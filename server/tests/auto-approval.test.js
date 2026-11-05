const { test, before, after, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });
beforeEach(() => { t.emailControl.fail = false; });

const DAY = 24 * 60 * 60 * 1000;
const book = async (user, eventId) => {
    const token = t.tokenFor(user);
    await t.api('POST', '/bookings/send-otp', { token });
    return t.api('POST', '/bookings', { token, body: { eventId: String(eventId), otp: t.lastCode(user.email, 'event_booking') } });
};
const eventBody = (extra = {}) => ({
    title: 'Auto Show', description: 'd', date: new Date(Date.now() + 5 * DAY).toISOString(),
    location: 'l', category: 'Music', totalSeats: 10, ticketPrice: 0, ...extra
});

describe('approvalMode on events', () => {
    test('new events default to manual; auto and manual can be set and changed', async () => {
        const admin = await t.makeAdmin();
        const token = t.tokenFor(admin);
        let r = await t.api('POST', '/events', { token, body: eventBody() });
        assert.equal(r.status, 201);
        assert.equal(r.data.approvalMode, 'manual');
        r = await t.api('POST', '/events', { token, body: eventBody({ approvalMode: 'auto' }) });
        assert.equal(r.data.approvalMode, 'auto');
        r = await t.api('PUT', `/events/${r.data._id}`, { token, body: { approvalMode: 'manual' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.approvalMode, 'manual');
    });

    test('invalid approvalMode is rejected', async () => {
        const token = t.tokenFor(await t.makeAdmin());
        for (const bad of ['instant', { $ne: null }, 1]) {
            const r = await t.api('POST', '/events', { token, body: eventBody({ approvalMode: bad }) });
            assert.equal(r.status, 400, JSON.stringify(bad));
        }
    });

    test('events stored before this feature (no approvalMode) behave as manual', async () => {
        const raw = await t.models.Event.collection.insertOne({
            title: 'Legacy', description: 'd', date: new Date(Date.now() + DAY), location: 'l', category: 'c',
            totalSeats: 5, availableSeats: 5, ticketPrice: 0
        });
        const r = await t.api('GET', `/events/${raw.insertedId}`);
        assert.equal(r.data.approvalMode, 'manual');
        const booked = await book(await t.makeUser(), raw.insertedId);
        assert.equal(booked.status, 201);
        assert.equal(booked.data.booking.status, 'pending');
    });
});

describe('booking an auto-approve event', () => {
    test('free event: confirmed at once, paid (nothing owed), seat taken, email sent', async () => {
        const event = await t.makeEvent({ approvalMode: 'auto', ticketPrice: 0, totalSeats: 5, availableSeats: 5 });
        const user = await t.makeUser();
        const r = await book(user, event.id);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        assert.equal(r.data.message, 'Booking confirmed');
        assert.equal(r.data.autoConfirmed, true);
        assert.equal(r.data.emailSent, true);
        assert.equal(r.data.booking.status, 'confirmed');
        assert.equal(r.data.booking.paymentStatus, 'paid');
        assert.equal(r.data.booking.statusReason, 'Auto-approved');
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 4);
        const mail = t.emails.at(-1);
        assert.deepEqual([mail.type, mail.to, mail.title], ['confirmed', user.email, event.title]);
    });

    test('paid event: confirmed but not paid; admin marks it paid later and revenue counts it', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ approvalMode: 'auto', ticketPrice: 750 });
        const r = await book(await t.makeUser(), event.id);
        assert.equal(r.data.booking.status, 'confirmed');
        assert.equal(r.data.booking.paymentStatus, 'not_paid');
        let stats = await t.api('GET', `/bookings/stats?eventId=${event.id}`, { token: t.tokenFor(admin) });
        assert.equal(stats.data.totalRevenue, 0);
        const paid = await t.api('PUT', `/bookings/${r.data.booking._id}/payment`, { token: t.tokenFor(admin), body: { paymentStatus: 'paid' } });
        assert.equal(paid.status, 200);
        assert.equal(paid.data.booking.paymentStatus, 'paid');
        assert.equal(paid.data.booking.userId.password, undefined);
        stats = await t.api('GET', `/bookings/stats?eventId=${event.id}`, { token: t.tokenFor(admin) });
        assert.equal(stats.data.totalRevenue, 750);
    });

    test('manual events are unchanged: pending, no seat taken, no email', async () => {
        const event = await t.makeEvent({ approvalMode: 'manual', totalSeats: 5, availableSeats: 5 });
        const before = t.emails.length;
        const r = await book(await t.makeUser(), event.id);
        assert.equal(r.data.message, 'Booking request submitted');
        assert.equal(r.data.booking.status, 'pending');
        assert.equal(r.data.autoConfirmed, undefined);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 5);
        assert.equal(t.emails.slice(before).filter((e) => e.type === 'confirmed').length, 0);
    });

    test('the confirmation email failing does not undo the booking', async () => {
        const event = await t.makeEvent({ approvalMode: 'auto', totalSeats: 3, availableSeats: 3 });
        const user = await t.makeUser();
        const token = t.tokenFor(user);
        await t.api('POST', '/bookings/send-otp', { token });
        const code = t.lastCode(user.email, 'event_booking');
        t.emailControl.fail = true;
        const r = await t.api('POST', '/bookings', { token, body: { eventId: event.id, otp: code } });
        assert.equal(r.status, 201);
        assert.equal(r.data.emailSent, false);
        assert.equal(r.data.booking.status, 'confirmed');
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 2);
    });

    test('8 users booking the last 3 seats at once: exactly 3 confirmed, never overbooked', async () => {
        const event = await t.makeEvent({ approvalMode: 'auto', totalSeats: 3, availableSeats: 3 });
        const users = [];
        for (let i = 0; i < 8; i++) users.push(await t.makeUser());
        for (const u of users) await t.api('POST', '/bookings/send-otp', { token: t.tokenFor(u) });
        const results = await Promise.all(users.map((u) => t.api('POST', '/bookings', {
            token: t.tokenFor(u), body: { eventId: event.id, otp: t.lastCode(u.email, 'event_booking') }
        })));
        assert.equal(results.filter((r) => r.status === 201).length, 3, results.map((r) => r.status).join(','));
        assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 400 && r.data.message === 'No seats available'));
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 0);
        assert.equal(await t.models.Booking.countDocuments({ eventId: event._id, status: 'confirmed' }), 3);
    });

    test('a failure while saving the booking gives the seat back (transaction)', async () => {
        const event = await t.makeEvent({ approvalMode: 'auto', totalSeats: 2, availableSeats: 2 });
        const user = await t.makeUser();
        const token = t.tokenFor(user);
        await t.api('POST', '/bookings/send-otp', { token });
        const original = t.models.Booking.create;
        t.models.Booking.create = () => { throw new Error('simulated crash'); };
        let r;
        try {
            r = await t.api('POST', '/bookings', { token, body: { eventId: event.id, otp: t.lastCode(user.email, 'event_booking') } });
        } finally {
            t.models.Booking.create = original;
        }
        assert.equal(r.status, 500);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 2);
        assert.equal(await t.models.Booking.countDocuments({ eventId: event._id }), 0);
    });

    test('cancelling an auto-confirmed booking returns the seat; booking again works', async () => {
        const event = await t.makeEvent({ approvalMode: 'auto', totalSeats: 1, availableSeats: 1 });
        const user = await t.makeUser();
        let r = await book(user, event.id);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 0);
        await t.api('DELETE', `/bookings/${r.data.booking._id}`, { token: t.tokenFor(user) });
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 1);
        await t.models.OTP.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120000) } });
        r = await book(user, event.id);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        assert.equal(r.data.booking.status, 'confirmed');
    });

    test('switching an event to auto leaves existing pending requests for the admin', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ approvalMode: 'manual', totalSeats: 5, availableSeats: 5 });
        const pendingUser = await t.makeUser();
        const pending = await book(pendingUser, event.id);
        await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(admin), body: { approvalMode: 'auto' } });
        assert.equal((await t.models.Booking.findById(pending.data.booking._id)).status, 'pending');
        const later = await book(await t.makeUser(), event.id);
        assert.equal(later.data.booking.status, 'confirmed');
        const approve = await t.api('PUT', `/bookings/${pending.data.booking._id}/confirm`, { token: t.tokenFor(admin), body: {} });
        assert.equal(approve.status, 200);
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 3);
    });
});

describe('PUT /bookings/:id/payment', () => {
    test('validation and access control', async () => {
        const admin = await t.makeAdmin();
        const token = t.tokenFor(admin);
        const event = await t.makeEvent();
        const confirmed = await t.makeBooking(await t.makeUser(), event, { status: 'confirmed', paymentStatus: 'paid' });
        const pending = await t.makeBooking(await t.makeUser(), event);
        let r = await t.api('PUT', `/bookings/${confirmed.id}/payment`, { token, body: { paymentStatus: 'not_paid' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.booking.paymentStatus, 'not_paid');
        assert.equal((await t.api('PUT', `/bookings/${pending.id}/payment`, { token, body: { paymentStatus: 'paid' } })).status, 400);
        assert.equal((await t.api('PUT', `/bookings/${confirmed.id}/payment`, { token, body: { paymentStatus: 'free' } })).status, 400);
        assert.equal((await t.api('PUT', `/bookings/${confirmed.id}/payment`, { token, body: { paymentStatus: { $ne: null } } })).status, 400);
        assert.equal((await t.api('PUT', '/bookings/abc/payment', { token, body: { paymentStatus: 'paid' } })).status, 400);
        assert.equal((await t.api('PUT', `/bookings/${new t.mongoose.Types.ObjectId()}/payment`, { token, body: { paymentStatus: 'paid' } })).status, 404);
        assert.equal((await t.api('PUT', `/bookings/${confirmed.id}/payment`, { token: t.tokenFor(await t.makeUser()), body: { paymentStatus: 'paid' } })).status, 403);
    });
});
