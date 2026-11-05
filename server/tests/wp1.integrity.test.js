const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { startTestServer, startStandalone } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

// Temporarily replace a model method; always restored.
const patched = async (obj, method, replacement, fn) => {
    const original = obj[method];
    obj[method] = replacement(original);
    try { return await fn(); } finally { obj[method] = original; }
};

describe('1.1 email normalisation', () => {
    test('register stores the email lowercased and login/verify accept any case', async () => {
        let r = await t.api('POST', '/auth/register', { body: { name: 'Mixed', email: '  Mixed.Case@Example.COM ', password: 'Password123' } });
        assert.equal(r.status, 201);
        assert.equal(r.data.email, 'mixed.case@example.com');
        const stored = await t.models.User.findOne({ email: 'mixed.case@example.com' });
        assert.ok(stored, 'stored lowercased');

        const code = t.lastCode('mixed.case@example.com', 'account_verification');
        r = await t.api('POST', '/auth/verify-otp', { body: { email: 'MIXED.CASE@example.com', otp: code } });
        assert.equal(r.status, 200, JSON.stringify(r.data));

        r = await t.api('POST', '/auth/login', { body: { email: 'Mixed.Case@EXAMPLE.com', password: 'Password123' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.email, 'mixed.case@example.com');
    });

    test('the same address in different case cannot register twice', async () => {
        const r = await t.api('POST', '/auth/register', { body: { name: 'Dup', email: 'MIXED.case@EXAMPLE.COM', password: 'Password123' } });
        assert.equal(r.status, 400);
        assert.equal(r.data.message, 'User already exists');
    });
});

describe('1.2 / 1.4 booking statuses and database-level duplicate guard', () => {
    test('the unique partial index exists', async () => {
        const names = (await t.models.Booking.collection.indexes()).map((i) => i.name);
        for (const name of ['one_active_booking_per_user_event', 'eventId_1_status_1', 'userId_1_createdAt_-1']) {
            assert.ok(names.includes(name), `missing index ${name}`);
        }
        const eventIndexes = (await t.models.Event.collection.indexes()).map((i) => i.name);
        assert.ok(eventIndexes.includes('date_1') && eventIndexes.includes('category_1'));
    });

    test('the database rejects a second active booking even when the app check is bypassed', async () => {
        const user = await t.makeUser();
        const event = await t.makeEvent();
        await t.makeBooking(user, event, { status: 'pending' });
        await assert.rejects(t.makeBooking(user, event, { status: 'confirmed' }), (e) => e.code === 11000);
    });

    test('cancelled and rejected bookings do not block a new active booking', async () => {
        const user = await t.makeUser();
        const event = await t.makeEvent();
        await t.makeBooking(user, event, { status: 'cancelled' });
        await t.makeBooking(user, event, { status: 'rejected' });
        await t.makeBooking(user, event, { status: 'cancelled' });
        await t.makeBooking(user, event, { status: 'pending' });
        assert.equal(await t.models.Booking.countDocuments({ userId: user._id, eventId: event._id }), 4);
    });

    test('API maps a duplicate caught by the index to "Already booked or pending"', async () => {
        const user = await t.makeUser();
        const event = await t.makeEvent();
        await t.makeBooking(user, event, { status: 'pending' });
        const token = t.tokenFor(user);
        await t.api('POST', '/bookings/send-otp', { token });
        // Make the app-level check miss, as in two requests arriving at the same moment.
        const r = await patched(t.models.Booking, 'exists', () => async () => null, () =>
            t.api('POST', '/bookings', { token, body: { eventId: event.id, otp: t.lastCode(user.email, 'event_booking') } }));
        assert.equal(r.status, 400);
        assert.equal(r.data.message, 'Already booked or pending');
        assert.equal(await t.models.Booking.countDocuments({ userId: user._id, eventId: event._id }), 1);
    });
});

describe('1.3 event snapshot', () => {
    test('a new booking stores the event title and date', async () => {
        const user = await t.makeUser();
        const event = await t.makeEvent({ title: 'Snapshot Show' });
        const token = t.tokenFor(user);
        await t.api('POST', '/bookings/send-otp', { token });
        const r = await t.api('POST', '/bookings', { token, body: { eventId: event.id, otp: t.lastCode(user.email, 'event_booking') } });
        assert.equal(r.status, 201);
        assert.equal(r.data.booking.eventSnapshot.title, 'Snapshot Show');
        assert.equal(new Date(r.data.booking.eventSnapshot.date).getTime(), event.date.getTime());
    });
});

describe('1.5 transactions: approval', () => {
    test('approval records who changed the status and when', async () => {
        const admin = await t.makeAdmin();
        const user = await t.makeUser();
        const event = await t.makeEvent({ totalSeats: 2, availableSeats: 2 });
        const booking = await t.makeBooking(user, event);
        const r = await t.api('PUT', `/bookings/${booking.id}/confirm`, { token: t.tokenFor(admin), body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.booking.status, 'confirmed');
        assert.equal(r.data.booking.statusChangedBy, admin.id);
        assert.ok(r.data.booking.statusChangedAt);
        assert.equal(r.data.booking.userId.password, undefined);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 1);
    });

    test('a failure after the seat is taken rolls the seat back', async () => {
        const admin = await t.makeAdmin();
        const user = await t.makeUser();
        const event = await t.makeEvent({ totalSeats: 1, availableSeats: 1 });
        const booking = await t.makeBooking(user, event);
        const r = await patched(t.models.Booking, 'findOneAndUpdate', () => () => { throw new Error('simulated crash'); }, () =>
            t.api('PUT', `/bookings/${booking.id}/confirm`, { token: t.tokenFor(admin), body: {} }));
        assert.equal(r.status, 500);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 1, 'seat restored by rollback');
        assert.equal((await t.models.Booking.findById(booking.id)).status, 'pending');
    });

    test('a booking changed by another request mid-approval aborts with 409 and keeps the seat', async () => {
        const admin = await t.makeAdmin();
        const user = await t.makeUser();
        const event = await t.makeEvent({ totalSeats: 1, availableSeats: 1 });
        const booking = await t.makeBooking(user, event);
        const r = await patched(t.models.Booking, 'findOneAndUpdate', () => async () => null, () =>
            t.api('PUT', `/bookings/${booking.id}/confirm`, { token: t.tokenFor(admin), body: {} }));
        assert.equal(r.status, 409);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 1);
    });

    test('10 parallel approvals for 3 seats: exactly 3 confirmed, seats end at 0', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ totalSeats: 3, availableSeats: 3 });
        const bookings = [];
        for (let i = 0; i < 10; i++) bookings.push(await t.makeBooking(await t.makeUser(), event));
        const token = t.tokenFor(admin);
        const results = await Promise.all(bookings.map((b) => t.api('PUT', `/bookings/${b.id}/confirm`, { token, body: { paymentStatus: 'paid' } })));
        assert.equal(results.filter((r) => r.status === 200).length, 3, results.map((r) => r.status).join(','));
        assert.ok(results.every((r) => r.status === 200 || r.status === 400));
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 0);
        assert.equal(await t.models.Booking.countDocuments({ eventId: event._id, status: 'confirmed' }), 3);
    });

    test('a cancelled or rejected booking cannot be approved', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent();
        for (const status of ['cancelled', 'rejected']) {
            const booking = await t.makeBooking(await t.makeUser(), event, { status });
            const r = await t.api('PUT', `/bookings/${booking.id}/confirm`, { token: t.tokenFor(admin), body: {} });
            assert.equal(r.status, 400, status);
        }
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 10);
    });
});

describe('1.5 transactions: cancellation', () => {
    test('cancelling a pending booking frees nothing; a confirmed one frees one seat', async () => {
        const user = await t.makeUser();
        const token = t.tokenFor(user);
        const event = await t.makeEvent({ totalSeats: 5, availableSeats: 4 });
        const pending = await t.makeBooking(user, event, { status: 'pending' });
        let r = await t.api('DELETE', `/bookings/${pending.id}`, { token });
        assert.equal(r.status, 200);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 4);
        const after = await t.models.Booking.findById(pending.id);
        assert.equal(after.status, 'cancelled');
        assert.equal(String(after.statusChangedBy), user.id);

        const confirmed = await t.makeBooking(user, event, { status: 'confirmed' });
        r = await t.api('DELETE', `/bookings/${confirmed.id}`, { token });
        assert.equal(r.status, 200);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 5);
    });

    test('3 parallel cancels of a confirmed booking return the seat once', async () => {
        const user = await t.makeUser();
        const event = await t.makeEvent({ totalSeats: 2, availableSeats: 1 });
        const booking = await t.makeBooking(user, event, { status: 'confirmed' });
        const token = t.tokenFor(user);
        const results = await Promise.all([1, 2, 3].map(() => t.api('DELETE', `/bookings/${booking.id}`, { token })));
        assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join(','));
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 2);
    });

    test('a failure while returning the seat rolls the cancellation back', async () => {
        const user = await t.makeUser();
        const event = await t.makeEvent({ totalSeats: 2, availableSeats: 1 });
        const booking = await t.makeBooking(user, event, { status: 'confirmed' });
        const r = await patched(t.models.Event, 'updateOne', () => () => { throw new Error('simulated crash'); }, () =>
            t.api('DELETE', `/bookings/${booking.id}`, { token: t.tokenFor(user) }));
        assert.equal(r.status, 500);
        assert.equal((await t.models.Booking.findById(booking.id)).status, 'confirmed', 'status change undone');
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 1);
    });

    test("users cannot cancel others' bookings; rejected bookings cannot be cancelled", async () => {
        const owner = await t.makeUser();
        const other = await t.makeUser();
        const event = await t.makeEvent();
        const booking = await t.makeBooking(owner, event);
        let r = await t.api('DELETE', `/bookings/${booking.id}`, { token: t.tokenFor(other) });
        assert.equal(r.status, 403);
        const rejected = await t.makeBooking(other, event, { status: 'rejected' });
        r = await t.api('DELETE', `/bookings/${rejected.id}`, { token: t.tokenFor(other) });
        assert.equal(r.status, 400);
    });
});

describe('1.5 transactions: rejection (service; API endpoint arrives in WP2)', () => {
    const service = () => require('../services/bookingService');

    test('rejects a pending booking with a reason, no seat change', async () => {
        const admin = await t.makeAdmin();
        const user = await t.makeUser();
        const event = await t.makeEvent({ totalSeats: 3, availableSeats: 3 });
        const booking = await t.makeBooking(user, event);
        const rejected = await service().rejectBooking({ bookingId: booking.id, actorId: admin._id, reason: '  Payment not received  ' });
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.statusReason, 'Payment not received');
        assert.equal(String(rejected.statusChangedBy), admin.id);
        assert.equal(rejected.userId.email, user.email);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 3);
    });

    test('only pending bookings can be rejected; reason is validated', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent();
        for (const status of ['confirmed', 'cancelled', 'rejected']) {
            const booking = await t.makeBooking(await t.makeUser(), event, { status });
            await assert.rejects(service().rejectBooking({ bookingId: booking.id, actorId: admin._id }), (e) => e.status === 400);
        }
        const booking = await t.makeBooking(await t.makeUser(), event);
        await assert.rejects(service().rejectBooking({ bookingId: booking.id, actorId: admin._id, reason: 'x'.repeat(501) }), (e) => e.status === 400);
        await assert.rejects(service().rejectBooking({ bookingId: booking.id, actorId: admin._id, reason: { $ne: null } }), (e) => e.status === 400);
    });

    test('parallel rejections: exactly one succeeds', async () => {
        const admin = await t.makeAdmin();
        const booking = await t.makeBooking(await t.makeUser(), await t.makeEvent());
        const results = await Promise.allSettled([1, 2, 3].map(() => service().rejectBooking({ bookingId: booking.id, actorId: admin._id })));
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    });

    test('a user can book again after being rejected', async () => {
        const admin = await t.makeAdmin();
        const user = await t.makeUser();
        const event = await t.makeEvent();
        const booking = await t.makeBooking(user, event);
        await service().rejectBooking({ bookingId: booking.id, actorId: admin._id });
        const token = t.tokenFor(user);
        await t.api('POST', '/bookings/send-otp', { token });
        const r = await t.api('POST', '/bookings', { token, body: { eventId: event.id, otp: t.lastCode(user.email, 'event_booking') } });
        assert.equal(r.status, 201, JSON.stringify(r.data));
    });
});

describe('1.6 event deletion', () => {
    test('cancels active bookings, keeps history, notifies users, in one transaction', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ title: 'Doomed Gig', totalSeats: 5, availableSeats: 4 });
        const pendingUser = await t.makeUser();
        const confirmedUser = await t.makeUser();
        const cancelledUser = await t.makeUser();
        const pending = await t.makeBooking(pendingUser, event, { status: 'pending' });
        const confirmed = await t.makeBooking(confirmedUser, event, { status: 'confirmed' });
        // An older booking without a snapshot still gets one on deletion.
        const legacy = await t.makeBooking(await t.makeUser(), event, { status: 'pending', eventSnapshot: undefined });
        const cancelled = await t.makeBooking(cancelledUser, event, { status: 'cancelled' });
        const emailsBefore = t.emails.length;

        const r = await t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(admin) });
        assert.equal(r.status, 200);
        assert.equal(r.data.cancelledBookings, 3);
        assert.equal(await t.models.Event.findById(event.id), null);

        for (const b of [pending, confirmed, legacy]) {
            const after = await t.models.Booking.findById(b.id);
            assert.equal(after.status, 'cancelled');
            assert.equal(after.statusReason, 'Event deleted by organiser');
            assert.equal(String(after.statusChangedBy), admin.id);
            assert.equal(after.eventSnapshot.title, 'Doomed Gig');
        }
        const untouched = await t.models.Booking.findById(cancelled.id);
        assert.equal(untouched.statusReason, undefined);

        const sent = t.emails.slice(emailsBefore).filter((e) => e.type === 'event_cancelled');
        assert.equal(sent.length, 3);
        assert.ok(sent.every((e) => e.title === 'Doomed Gig'));
        assert.ok(!sent.some((e) => e.to === cancelledUser.email));

        const history = await t.api('GET', '/bookings/my', { token: t.tokenFor(confirmedUser) });
        assert.equal(history.status, 200);
        assert.equal(history.data.length, 1);
        assert.equal(history.data[0].eventId, null);
        assert.equal(history.data[0].eventSnapshot.title, 'Doomed Gig');
    });

    test('a failure during deletion leaves the event and its bookings untouched', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent();
        const booking = await t.makeBooking(await t.makeUser(), event, { status: 'confirmed' });
        const emailsBefore = t.emails.length;
        const r = await patched(t.models.Event, 'deleteOne', () => () => { throw new Error('simulated crash'); }, () =>
            t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(admin) }));
        assert.equal(r.status, 500);
        assert.ok(await t.models.Event.findById(event.id), 'event still exists');
        assert.equal((await t.models.Booking.findById(booking.id)).status, 'confirmed');
        assert.equal(t.emails.length, emailsBefore, 'no emails sent for a rolled-back deletion');
    });

    test('deleting an event with no bookings, an unknown event, and as a non-admin', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent();
        let r = await t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(admin) });
        assert.equal(r.status, 200);
        assert.equal(r.data.cancelledBookings, 0);
        r = await t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(admin) });
        assert.equal(r.status, 404);
        const other = await t.makeEvent();
        r = await t.api('DELETE', `/events/${other.id}`, { token: t.tokenFor(await t.makeUser()) });
        assert.equal(r.status, 403);
    });
});

describe('startup transaction check', () => {
    test('the server refuses to start on a standalone MongoDB', async () => {
        const { server, uri } = await startStandalone();
        try {
            const result = await new Promise((resolve) => {
                const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
                    cwd: __dirname,
                    env: { ...process.env, MONGO_URI: uri, PORT: '0', JWT_SECRET: 'x'.repeat(48) },
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                let out = '';
                child.stdout.on('data', (d) => { out += d; });
                child.stderr.on('data', (d) => { out += d; });
                const timer = setTimeout(() => child.kill(), 20000);
                child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
            });
            assert.equal(result.code, 1, result.out);
            assert.match(result.out, /does not support transactions/);
        } finally {
            await server.stop();
        }
    });
});
