const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { MongoClient, ObjectId } = require('mongodb');
const { startReplSet, assertLocal } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-phase2.js');
const SEED = path.join(__dirname, '..', 'seed.js');
const DB = 'bookeven_migration_test';

let replSet;
let uri;
let client;
let db;

// Runs a script with MONGO_URI forced to the in-memory database.
const run = (script, args = [], extraEnv = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
        cwd: __dirname,
        env: { ...process.env, MONGO_URI: assertLocal(uri), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
});
const migrate = (...args) => run(SCRIPT, args);

// A fingerprint of every document and index, to prove a run changed nothing.
const snapshot = async () => {
    const result = {};
    for (const name of ['users', 'events', 'bookings', 'otps']) {
        const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
        let indexes = [];
        try { indexes = (await db.collection(name).indexes()).map((i) => i.name).sort(); } catch { /* no collection */ }
        result[name] = JSON.stringify({ docs, indexes });
    }
    return result;
};

const ids = {};

before(async () => {
    ({ replSet } = await startReplSet(DB));
    uri = assertLocal(replSet.getUri(DB));
    client = await MongoClient.connect(uri);
    db = client.db(DB);

    // Data as an older version of the app could have left it.
    ids.alice = new ObjectId(); ids.aliceDupe = new ObjectId(); ids.bob = new ObjectId(); ids.carol = new ObjectId();
    await db.collection('users').insertMany([
        { _id: ids.alice, name: 'Alice', email: 'Alice@Example.com', password: 'x', role: 'user', isVerified: true },
        { _id: ids.aliceDupe, name: 'Alice 2', email: 'alice@example.com', password: 'x', role: 'user', isVerified: true },
        { _id: ids.bob, name: 'Bob', email: ' BOB@test.com', password: 'x', role: 'user', isVerified: true },
        { _id: ids.carol, name: 'Carol', email: 'carol@test.com', password: 'x', role: 'admin', isVerified: true }
    ]);
    ids.concert = new ObjectId(); ids.talk = new ObjectId(); ids.gone = new ObjectId();
    const soon = new Date(Date.now() + 5 * 864e5);
    await db.collection('events').insertMany([
        // Seats out of step: 2 confirmed bookings, so 8 should be free, not 10.
        { _id: ids.concert, title: 'Concert', description: 'd', date: soon, location: 'l', category: 'Music', totalSeats: 10, availableSeats: 10, ticketPrice: 100 },
        { _id: ids.talk, title: 'Talk', description: 'd', date: soon, location: 'l', category: 'Tech', totalSeats: 5, availableSeats: 5, ticketPrice: 0 }
    ]);
    ids.dup1 = new ObjectId(); ids.dup2 = new ObjectId(); ids.orphan = new ObjectId(); ids.oldCancelled = new ObjectId();
    await db.collection('bookings').insertMany([
        { _id: new ObjectId(), userId: ids.alice, eventId: ids.concert, status: 'confirmed', paymentStatus: 'paid', amount: 100 },
        { _id: ids.dup1, userId: ids.bob, eventId: ids.concert, status: 'confirmed', paymentStatus: 'paid', amount: 100 },
        { _id: ids.dup2, userId: ids.bob, eventId: ids.concert, status: 'pending', paymentStatus: 'not_paid', amount: 100 },
        { _id: new ObjectId(), userId: ids.carol, eventId: ids.talk, status: 'pending', paymentStatus: 'not_paid', amount: 0 },
        { _id: ids.orphan, userId: ids.carol, eventId: ids.gone, status: 'pending', paymentStatus: 'not_paid', amount: 50 },
        { _id: ids.oldCancelled, userId: ids.alice, eventId: ids.gone, status: 'cancelled', paymentStatus: 'not_paid', amount: 50 }
    ]);
    await db.collection('otps').insertOne({ email: 'Alice@Example.com', otpHash: 'x', action: 'event_booking', attempts: 0, createdAt: new Date() });
});

after(async () => {
    await client.close();
    await replSet.stop();
});

describe('migrate-phase2', () => {
    test('dry run reports blocking problems and changes nothing', async () => {
        const before = await snapshot();
        const r = await migrate();
        assert.equal(r.code, 2, r.out);
        assert.match(r.out, /BLOCKING: 1 email shared by several accounts/);
        assert.match(r.out, /alice@example\.com/);
        assert.match(r.out, /BLOCKING: 1 user\/event pair with more than one pending\/confirmed booking/);
        assert.match(r.out, /Nothing was changed/);
        assert.deepEqual(await snapshot(), before);
    });

    test('--apply refuses to run while blocking problems exist', async () => {
        const before = await snapshot();
        const r = await migrate('--apply', `--db=${DB}`);
        assert.equal(r.code, 2, r.out);
        assert.deepEqual(await snapshot(), before);
    });

    test('after the manual fixes, the dry run lists every change and still changes nothing', async () => {
        // The manual decisions an operator would make.
        await db.collection('users').deleteOne({ _id: ids.aliceDupe });
        await db.collection('bookings').updateOne({ _id: ids.dup2 }, { $set: { status: 'cancelled' } });

        const before = await snapshot();
        const r = await migrate();
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /2 emails to lowercase\/trim/);
        assert.match(r.out, /Duplicate active bookings\s+none/);
        assert.match(r.out, /1 booking to cancel/);
        assert.match(r.out, /4 bookings to fill in/);
        assert.match(r.out, /2 bookings whose event is already gone/);
        assert.match(r.out, /"Concert": availableSeats 10 -> 8/);
        assert.match(r.out, /2 events to mark as published/);
        assert.match(r.out, /to create: bookings\.one_active_booking_per_user_event/);
        assert.match(r.out, /Dry run only/);
        assert.deepEqual(await snapshot(), before);
    });

    test('--apply without --db, or with the wrong name, is refused', async () => {
        const before = await snapshot();
        let r = await migrate('--apply');
        assert.equal(r.code, 1);
        assert.match(r.out, new RegExp(`needs --db=${DB}`));
        r = await migrate('--apply', '--db=bookeven');
        assert.equal(r.code, 1);
        assert.deepEqual(await snapshot(), before);
    });

    test('--apply --db=<name> applies every step', async () => {
        const r = await migrate('--apply', `--db=${DB}`);
        assert.equal(r.code, 0, r.out);

        const emails = (await db.collection('users').find({}).toArray()).map((u) => u.email).sort();
        assert.deepEqual(emails, ['alice@example.com', 'bob@test.com', 'carol@test.com']);
        assert.equal(await db.collection('otps').countDocuments({ email: 'Alice@Example.com' }), 0);

        const orphan = await db.collection('bookings').findOne({ _id: ids.orphan });
        assert.equal(orphan.status, 'cancelled');
        assert.equal(orphan.statusReason, 'Event deleted by organiser');

        const concertBookings = await db.collection('bookings').find({ eventId: ids.concert }).toArray();
        assert.ok(concertBookings.every((b) => b.eventSnapshot.title === 'Concert'));
        const gone = await db.collection('bookings').findOne({ _id: ids.oldCancelled });
        assert.equal(gone.eventSnapshot, undefined, 'no snapshot can be made for a deleted event');

        assert.equal((await db.collection('events').findOne({ _id: ids.concert })).availableSeats, 8);
        assert.equal((await db.collection('events').findOne({ _id: ids.talk })).availableSeats, 5);
        assert.equal(await db.collection('events').countDocuments({ status: 'published' }), 2);

        const bookingIndexes = (await db.collection('bookings').indexes()).map((i) => i.name);
        assert.ok(bookingIndexes.includes('one_active_booking_per_user_event'));
        const unique = (await db.collection('bookings').indexes()).find((i) => i.name === 'one_active_booking_per_user_event');
        assert.equal(unique.unique, true);
        const eventIndexes = (await db.collection('events').indexes()).map((i) => i.name);
        assert.ok(eventIndexes.includes('date_1') && eventIndexes.includes('category_1'));
    });

    test('running again finds nothing to do and changes nothing (idempotent)', async () => {
        const before = await snapshot();
        let r = await migrate();
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /0 emails to lowercase/);
        assert.match(r.out, /0 bookings to cancel/);
        assert.match(r.out, /0 bookings to fill in/);
        assert.match(r.out, /all consistent/);
        assert.match(r.out, /0 events to mark as published/);
        assert.match(r.out, /all present/);
        r = await migrate('--apply', `--db=${DB}`);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(await snapshot(), before);
    });

    test('rollback: dry run changes nothing; apply reverts statuses, fields and indexes', async () => {
        await db.collection('bookings').updateOne({ eventId: ids.talk }, { $set: { status: 'rejected', statusReason: 'no' } });
        const before = await snapshot();
        let r = await migrate('--rollback');
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /1 rejected booking -> cancelled/);
        assert.deepEqual(await snapshot(), before);

        r = await migrate('--rollback', '--apply', `--db=${DB}`);
        assert.equal(r.code, 0, r.out);
        assert.equal(await db.collection('bookings').countDocuments({ status: 'rejected' }), 0);
        assert.equal(await db.collection('bookings').countDocuments({ eventSnapshot: { $exists: true } }), 0);
        assert.equal(await db.collection('bookings').countDocuments({ statusReason: { $exists: true } }), 0);
        assert.equal(await db.collection('events').countDocuments({ status: { $exists: true } }), 0);
        const bookingIndexes = (await db.collection('bookings').indexes()).map((i) => i.name);
        assert.deepEqual(bookingIndexes, ['_id_']);
        const eventIndexes = (await db.collection('events').indexes()).map((i) => i.name);
        assert.deepEqual(eventIndexes, ['_id_']);
    });

    test('data produced by the seed script needs no fixes and passes the migration', async () => {
        const seedDb = `${DB}_seed`;
        const seedUri = assertLocal(replSet.getUri(seedDb));
        const seeded = await run(SEED, [], { MONGO_URI: seedUri });
        assert.equal(seeded.code, 0, seeded.out);
        const r = await new Promise((resolve) => {
            const child = spawn(process.execPath, [SCRIPT], { cwd: __dirname, env: { ...process.env, MONGO_URI: seedUri }, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });
            child.on('exit', (code) => resolve({ code, out }));
        });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /0 emails to lowercase/);
        assert.match(r.out, /Duplicate active bookings\s+none/);
        assert.match(r.out, /0 bookings to fill in/);
        assert.match(r.out, /all consistent/);
    });
});
