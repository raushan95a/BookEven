#!/usr/bin/env node
/**
 * Phase 2 (WP1) data migration.
 *
 *   node scripts/migrate-phase2.js                       dry run: reports only, changes nothing
 *   node scripts/migrate-phase2.js --apply --db=<name>   applies the changes
 *   node scripts/migrate-phase2.js --rollback            dry run of the rollback
 *   node scripts/migrate-phase2.js --rollback --apply --db=<name>
 *
 * --db must equal the name of the database in MONGO_URI, so a command copied from
 * one environment cannot change another by accident. Take a backup before --apply.
 *
 * Steps (all safe to run more than once):
 *   1. Lowercase and trim user emails. Stops if two accounts would end up with the same email.
 *   2. Check for users with more than one pending/confirmed booking for the same event.
 *      Stops if any exist: they block the new unique index and need a manual decision.
 *   3. Cancel pending/confirmed bookings whose event no longer exists.
 *   4. Fill in the event title/date snapshot on bookings whose event still exists.
 *   5. Recompute each event's availableSeats as totalSeats minus confirmed bookings.
 *   6. Mark events without a review status as published (they were all public before).
 *   7. Create the new indexes.
 *
 * Exit codes: 0 = done / nothing blocking, 2 = blocking problems found, 1 = error.
 */
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env') });

// A dry run must never write. Stop Mongoose from building indexes or collections on its own.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const User = require('../models/User');
const Event = require('../models/Event');
const Booking = require('../models/Booking');
const OTP = require('../models/OTP');

const ACTIVE = Booking.ACTIVE_STATUSES;
const ORPHAN_REASON = 'Event deleted by organiser';
const NEW_INDEXES = {
    bookings: ['one_active_booking_per_user_event', 'eventId_1_status_1', 'userId_1_createdAt_-1'],
    events: ['date_1', 'category_1', 'status_1_date_1', 'createdBy_1']
};

const parseArgs = (argv) => {
    const args = { apply: false, rollback: false, db: undefined };
    for (const arg of argv) {
        if (arg === '--apply') args.apply = true;
        else if (arg === '--rollback') args.rollback = true;
        else if (arg.startsWith('--db=')) args.db = arg.slice(5);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
};

const maskUri = (uri) => uri.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:***@');
const log = (...parts) => console.log(...parts);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- planning (read-only)

const planEmails = async (db) => {
    const users = await db.collection('users').find({}, { projection: { email: 1 } }).toArray();
    const groups = new Map();
    for (const u of users) {
        const key = String(u.email).trim().toLowerCase();
        groups.set(key, [...(groups.get(key) || []), u]);
    }
    const collisions = [...groups.entries()].filter(([, list]) => list.length > 1)
        .map(([email, list]) => ({ email, ids: list.map((u) => String(u._id)) }));
    const toFix = users.filter((u) => u.email !== String(u.email).trim().toLowerCase());
    return { collisions, toFix };
};

const planDuplicateBookings = (db) => db.collection('bookings').aggregate([
    { $match: { status: { $in: ACTIVE } } },
    { $group: { _id: { userId: '$userId', eventId: '$eventId' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } }
]).toArray();

const planBookingsVsEvents = async (db) => {
    const eventIds = new Set((await db.collection('events').find({}, { projection: { _id: 1 } }).toArray()).map((e) => String(e._id)));
    const orphans = await db.collection('bookings').find({ status: { $in: ACTIVE } }, { projection: { eventId: 1 } }).toArray();
    const activeOrphans = orphans.filter((b) => !eventIds.has(String(b.eventId)));
    const missingSnapshot = await db.collection('bookings')
        .find({ 'eventSnapshot.title': { $exists: false } }, { projection: { eventId: 1 } }).toArray();
    return {
        activeOrphans,
        snapshotFixable: missingSnapshot.filter((b) => eventIds.has(String(b.eventId))),
        snapshotUnrecoverable: missingSnapshot.filter((b) => !eventIds.has(String(b.eventId)))
    };
};

const planSeats = async (db) => {
    const confirmed = await db.collection('bookings').aggregate([
        { $match: { status: 'confirmed' } },
        { $group: { _id: '$eventId', n: { $sum: 1 } } }
    ]).toArray();
    const counts = new Map(confirmed.map((c) => [String(c._id), c.n]));
    const events = await db.collection('events').find({}, { projection: { title: 1, totalSeats: 1, availableSeats: 1 } }).toArray();
    return events.map((e) => {
        const used = counts.get(String(e._id)) || 0;
        return {
            _id: e._id,
            title: e.title,
            current: e.availableSeats,
            expected: Math.max(0, e.totalSeats - used),
            overbookedBy: Math.max(0, used - e.totalSeats)
        };
    }).filter((e) => e.current !== e.expected || e.overbookedBy > 0);
};

const existingIndexNames = async (db, name) => {
    try {
        return (await db.collection(name).indexes()).map((i) => i.name);
    } catch (error) {
        if (error.codeName === 'NamespaceNotFound' || error.code === 26) return [];
        throw error;
    }
};

const planIndexes = async (db) => {
    const missing = [];
    for (const [collection, names] of Object.entries(NEW_INDEXES)) {
        const existing = await existingIndexNames(db, collection);
        for (const name of names) if (!existing.includes(name)) missing.push(`${collection}.${name}`);
    }
    return missing;
};

// ---------------------------------------------------------------- migrate

const migrate = async (db, apply) => {
    const emails = await planEmails(db);
    const duplicates = await planDuplicateBookings(db);
    const links = await planBookingsVsEvents(db);
    const seats = await planSeats(db);
    const unstatused = await db.collection('events').countDocuments({ status: { $exists: false } });
    const indexes = await planIndexes(db);

    log('\n1. User emails');
    log(`   ${plural(emails.toFix.length, 'email')} to lowercase/trim`);
    if (emails.collisions.length) {
        log(`   BLOCKING: ${plural(emails.collisions.length, 'email')} shared by several accounts once lowercased:`);
        for (const c of emails.collisions) log(`     ${c.email}: users ${c.ids.join(', ')}`);
    }

    log('\n2. Duplicate active bookings');
    if (duplicates.length) {
        log(`   BLOCKING: ${plural(duplicates.length, 'user/event pair')} with more than one pending/confirmed booking:`);
        for (const d of duplicates) log(`     user ${d._id.userId} event ${d._id.eventId}: bookings ${d.ids.join(', ')}`);
    } else {
        log('   none');
    }

    log('\n3. Active bookings for deleted events');
    log(`   ${plural(links.activeOrphans.length, 'booking')} to cancel`);

    log('\n4. Event snapshots on bookings');
    log(`   ${plural(links.snapshotFixable.length, 'booking')} to fill in`);
    if (links.snapshotUnrecoverable.length) {
        log(`   ${plural(links.snapshotUnrecoverable.length, 'booking')} whose event is already gone (left without a snapshot; the UI shows "event unavailable")`);
    }

    log('\n5. Seat counts');
    if (!seats.length) log('   all consistent');
    for (const s of seats) {
        log(`   "${s.title}": availableSeats ${s.current} -> ${s.expected}${s.overbookedBy ? `  (WARNING: overbooked by ${s.overbookedBy}; needs manual follow-up)` : ''}`);
    }

    log('\n6. Event review status');
    log(`   ${plural(unstatused, 'event')} to mark as published`);

    log('\n7. Indexes');
    log(indexes.length ? `   to create: ${indexes.join(', ')}` : '   all present');

    const blocking = emails.collisions.length + duplicates.length;
    if (blocking) {
        log(`\nStopped: ${plural(blocking, 'blocking problem')} must be resolved by hand first. Nothing was changed.`);
        return 2;
    }
    if (!apply) {
        log('\nDry run only. Nothing was changed.');
        return 0;
    }

    log('\nApplying...');
    if (emails.toFix.length) {
        await db.collection('users').bulkWrite(emails.toFix.map((u) => ({
            updateOne: { filter: { _id: u._id }, update: { $set: { email: String(u.email).trim().toLowerCase() } } }
        })));
    }
    // Codes live at most 5 minutes; clear them so none is stored under an old mixed-case email.
    await db.collection('otps').deleteMany({ email: { $regex: /[A-Z]|^\s|\s$/ } });

    if (links.activeOrphans.length) {
        await db.collection('bookings').updateMany(
            { _id: { $in: links.activeOrphans.map((b) => b._id) }, status: { $in: ACTIVE } },
            { $set: { status: 'cancelled', statusReason: ORPHAN_REASON, statusChangedAt: new Date() } }
        );
    }

    if (links.snapshotFixable.length) {
        const events = new Map((await db.collection('events').find(
            { _id: { $in: [...new Set(links.snapshotFixable.map((b) => String(b.eventId)))].map((id) => new mongoose.Types.ObjectId(id)) } },
            { projection: { title: 1, date: 1 } }
        ).toArray()).map((e) => [String(e._id), e]));
        await db.collection('bookings').bulkWrite(links.snapshotFixable.map((b) => {
            const e = events.get(String(b.eventId));
            return { updateOne: { filter: { _id: b._id }, update: { $set: { eventSnapshot: { title: e.title, date: e.date } } } } };
        }));
    }

    if (seats.length) {
        await db.collection('events').bulkWrite(seats.map((s) => ({
            updateOne: { filter: { _id: s._id }, update: { $set: { availableSeats: s.expected } } }
        })));
    }

    if (unstatused) {
        await db.collection('events').updateMany({ status: { $exists: false } }, { $set: { status: 'published' } });
    }

    // createIndexes only adds; it never drops an index.
    for (const Model of [User, Event, Booking, OTP]) {
        await Model.createCollection().catch(() => {});
        await Model.createIndexes();
    }

    const remaining = await planIndexes(db);
    log(remaining.length ? `Done, but indexes still missing: ${remaining.join(', ')}` : 'Done. Run again without --apply to confirm nothing is left to change.');
    return remaining.length ? 1 : 0;
};

// ---------------------------------------------------------------- rollback

const rollback = async (db, apply) => {
    const bookings = db.collection('bookings');
    const rejected = await bookings.countDocuments({ status: 'rejected' });
    const withNewFields = await bookings.countDocuments({
        $or: [{ eventSnapshot: { $exists: true } }, { statusChangedBy: { $exists: true } }, { statusChangedAt: { $exists: true } }, { statusReason: { $exists: true } }]
    });
    const events = db.collection('events');
    const unpublished = await events.countDocuments({ status: { $in: ['pending_review', 'rejected'] } });
    const eventsWithNewFields = await events.countDocuments({
        $or: [{ status: { $exists: true } }, { reviewNote: { $exists: true } }, { reviewedBy: { $exists: true } }, { reviewedAt: { $exists: true } }, { pendingChanges: { $exists: true } }]
    });
    const present = [];
    for (const [collection, names] of Object.entries(NEW_INDEXES)) {
        const existing = await existingIndexNames(db, collection);
        for (const name of names) if (existing.includes(name)) present.push([collection, name]);
    }

    log('\nRollback plan');
    log(`   ${plural(rejected, 'rejected booking')} -> cancelled`);
    log(`   ${plural(withNewFields, 'booking')}: remove eventSnapshot/statusChangedBy/statusChangedAt/statusReason`);
    log(`   indexes to drop: ${present.length ? present.map(([c, n]) => `${c}.${n}`).join(', ') : 'none'}`);
    log(`   ${plural(eventsWithNewFields, 'event')}: remove status/reviewNote/reviewedBy/reviewedAt/pendingChanges`);
    if (unpublished) {
        log(`   WARNING: ${plural(unpublished, 'event')} waiting for review or rejected will become PUBLIC under the old code. Review or delete them first.`);
    }
    log('   emails stay lowercased (harmless for the old code)');
    log('   Roll the code back first: the new server re-creates these indexes when it starts.');

    if (!apply) {
        log('\nDry run only. Nothing was changed.');
        return 0;
    }

    log('\nApplying rollback...');
    await bookings.updateMany({ status: 'rejected' }, { $set: { status: 'cancelled' } });
    await bookings.updateMany({}, { $unset: { eventSnapshot: '', statusChangedBy: '', statusChangedAt: '', statusReason: '' } });
    await events.updateMany({}, { $unset: { status: '', reviewNote: '', reviewedBy: '', reviewedAt: '', pendingChanges: '' } });
    for (const [collection, name] of present) await db.collection(collection).dropIndex(name);
    log('Done.');
    return 0;
};

// ---------------------------------------------------------------- main

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not set.');

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    log(`Database: ${db.databaseName} on ${maskUri(uri).replace(/\?.*$/, '')}`);
    log(`Mode: ${args.rollback ? 'ROLLBACK' : 'MIGRATE'} ${args.apply ? '(APPLY)' : '(dry run)'}`);

    if (args.apply && args.db !== db.databaseName) {
        throw new Error(`--apply needs --db=${db.databaseName} to confirm the target database. Take a backup first.`);
    }

    const code = args.rollback ? await rollback(db, args.apply) : await migrate(db, args.apply);
    await mongoose.disconnect();
    return code;
};

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch(async (error) => {
            console.error(`\nError: ${error.message}`);
            await mongoose.disconnect().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main };
