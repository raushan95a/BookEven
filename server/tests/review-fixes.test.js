// Tests for the issues found in the independent code review of phase-2.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { assertSupportedMongoVersion } = require('../utils/config');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

const DAY = 24 * 60 * 60 * 1000;
const future = (days = 5) => new Date(Date.now() + days * DAY).toISOString();
const book = async (user, eventId) => {
    const token = t.tokenFor(user);
    await t.models.OTP.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120000) } });
    await t.api('POST', '/bookings/send-otp', { token });
    return t.api('POST', '/bookings', { token, body: { eventId: String(eventId), otp: t.lastCode(user.email, 'event_booking') } });
};

describe('#1 attendees never see an event\'s review details', () => {
    test('booking response and My Bookings hide pendingChanges and reviewNote', async () => {
        const organiser = await t.makeUser();
        const event = await t.makeEvent({
            createdBy: organiser._id, status: 'published', reviewNote: 'internal note',
            pendingChanges: { title: 'Secret new title', submittedAt: new Date() }
        });
        const attendee = await t.makeUser();
        const r = await book(attendee, event.id);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        assert.equal(r.data.booking.eventId.title, event.title);
        assert.equal(r.data.booking.eventId.pendingChanges, undefined);
        assert.equal(r.data.booking.eventId.reviewNote, undefined);
        const my = await t.api('GET', '/bookings/my', { token: t.tokenFor(attendee) });
        assert.equal(my.data[0].eventId.title, event.title);
        assert.equal(my.data[0].eventId.pendingChanges, undefined);
        assert.equal(my.data[0].eventId.reviewNote, undefined);
        assert.equal(my.data[0].eventId.reviewedBy, undefined);
    });
});

describe('#3 an admin can only approve the version they saw', () => {
    test('new event: a review based on an older version is refused (409)', async () => {
        const admin = await t.makeAdmin();
        const organiser = await t.makeUser();
        const created = await t.api('POST', '/events', { token: t.tokenFor(organiser), body: { title: 'V1', description: 'd', date: future(), location: 'l', category: 'c', totalSeats: 5, ticketPrice: 0 } });
        const seenVersion = created.data.updatedAt;
        await new Promise((resolve) => setTimeout(resolve, 15));
        await t.api('PUT', `/events/${created.data._id}`, { token: t.tokenFor(organiser), body: { title: 'V2' } });
        let r = await t.api('PUT', `/events/${created.data._id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve', version: seenVersion } });
        assert.equal(r.status, 409, JSON.stringify(r.data));
        assert.equal((await t.models.Event.findById(created.data._id)).status, 'pending_review');
        const latest = await t.models.Event.findById(created.data._id);
        r = await t.api('PUT', `/events/${created.data._id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve', version: latest.updatedAt.toISOString() } });
        assert.equal(r.status, 200);
        assert.equal(r.data.event.title, 'V2');
    });

    test('changes: withdrawing a proposed field gives a new version, so the old review is refused', async () => {
        const admin = await t.makeAdmin();
        const organiser = await t.makeUser();
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published', title: 'Live' });
        let r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { title: 'Proposed', location: 'New place' } });
        const seen = r.data.pendingChanges.submittedAt;
        await new Promise((resolve) => setTimeout(resolve, 15));
        r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { location: event.location } });
        assert.equal(r.data.pendingChanges.location, undefined);
        assert.notEqual(r.data.pendingChanges.submittedAt, seen, 'withdrawal creates a new version');
        r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve', version: seen } });
        assert.equal(r.status, 409);
    });

    test('bookings on a published event do not make a changes review "stale"', async () => {
        const admin = await t.makeAdmin();
        const organiser = await t.makeUser();
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published', approvalMode: 'auto', totalSeats: 5, availableSeats: 5 });
        let r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { title: 'Renamed' } });
        const seen = r.data.pendingChanges.submittedAt;
        assert.equal((await book(await t.makeUser(), event.id)).status, 201, 'a seat is taken meanwhile');
        r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve', version: seen } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.event.title, 'Renamed');
    });

    test('changing only seats does not invalidate a waiting proposal', async () => {
        const admin = await t.makeAdmin();
        const organiser = await t.makeUser();
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published', totalSeats: 5, availableSeats: 5 });
        let r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { title: 'Next' } });
        const seen = r.data.pendingChanges.submittedAt;
        r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { totalSeats: 8 } });
        assert.equal(r.data.pendingChanges.submittedAt, seen);
        r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve', version: seen } });
        assert.equal(r.status, 200);
    });
});

describe('#4 MongoDB version requirement', () => {
    test('6.0 and newer accepted; older refused with a clear message', () => {
        for (const ok of ['6.0.0', '7.0.14', '8.0.37']) assert.doesNotThrow(() => assertSupportedMongoVersion(ok));
        for (const bad of ['5.0.26', '4.4.1', 'unknown']) assert.throws(() => assertSupportedMongoVersion(bad), /6\.0 or newer/);
    });
});

describe('#6 "Load more" never skips bookings', () => {
    test('with offset, approving rows while filtered by "pending" loses nothing', async () => {
        await t.models.Booking.deleteMany({});
        const admin = await t.makeAdmin();
        const token = t.tokenFor(admin);
        const event = await t.makeEvent({ totalSeats: 100, availableSeats: 100 });
        for (let i = 0; i < 25; i++) {
            await t.makeBooking(await t.makeUser(), event, { createdAt: new Date(Date.now() - (60 - i) * 1000) });
        }
        const first = await t.api('GET', '/bookings', { token, params: undefined }).then(() => t.api('GET', '/bookings?status=pending&limit=10&offset=0', { token }));
        assert.equal(first.data.items.length, 10);
        assert.equal(first.data.hasMore, true);
        // Approve 3 of the rows shown: they leave the "pending" list on the server.
        for (const b of first.data.items.slice(0, 3)) {
            assert.equal((await t.api('PUT', `/bookings/${b._id}/confirm`, { token, body: {} })).status, 200);
        }
        // The page asks for the next rows after the 7 still-pending ones it shows.
        const next = await t.api('GET', '/bookings?status=pending&limit=10&offset=7', { token });
        const shown = new Set([...first.data.items.slice(3), ...next.data.items].map((b) => b._id));
        const rest = await t.api('GET', '/bookings?status=pending&limit=10&offset=17', { token });
        for (const b of rest.data.items) shown.add(b._id);
        assert.equal(shown.size, 22, 'every one of the 22 still-pending bookings is reachable');
        assert.equal(rest.data.hasMore, false);
    });

    test('offset is validated; page still works', async () => {
        const token = t.tokenFor(await t.makeAdmin());
        for (const q of ['offset=-1', 'offset=abc', 'offset=1.5']) {
            assert.equal((await t.api('GET', `/bookings?${q}`, { token })).status, 400, q);
        }
        const r = await t.api('GET', '/bookings?page=2&limit=5', { token });
        assert.equal(r.status, 200);
        assert.equal(r.data.offset, 5);
    });
});

describe('#8 Paid Clients counts only people who paid something', () => {
    test('free confirmed bookings marked paid are not paying clients', async () => {
        await t.models.Booking.deleteMany({});
        const admin = await t.makeAdmin();
        const free = await t.makeEvent({ ticketPrice: 0 });
        const paid = await t.makeEvent({ ticketPrice: 400 });
        for (let i = 0; i < 3; i++) await t.makeBooking(await t.makeUser(), free, { status: 'confirmed', paymentStatus: 'paid', amount: 0 });
        await t.makeBooking(await t.makeUser(), paid, { status: 'confirmed', paymentStatus: 'paid', amount: 400 });
        const r = await t.api('GET', '/bookings/stats', { token: t.tokenFor(admin) });
        assert.deepEqual([r.data.paidClients, r.data.totalRevenue], [1, 400]);
    });
});

describe('#9 submitting an event never waits for admin emails', () => {
    test('a hanging mail server does not delay the reply', async () => {
        await t.makeAdmin();
        const email = require('../utils/email');
        const original = email.sendEventSubmittedEmail;
        email.sendEventSubmittedEmail = () => new Promise(() => {}); // never finishes
        try {
            const started = Date.now();
            const r = await t.api('POST', '/events', { token: t.tokenFor(await t.makeUser()), body: { title: 'Quick', description: 'd', date: future(), location: 'l', category: 'c', totalSeats: 5, ticketPrice: 0 } });
            assert.equal(r.status, 201);
            assert.ok(Date.now() - started < 2000, `replied in ${Date.now() - started} ms`);
        } finally {
            email.sendEventSubmittedEmail = original;
        }
    });
});

describe('#10 one set of booking rules', () => {
    test('quick check and transaction use the same assertBookable', () => {
        const { assertBookable } = require('../services/bookingService');
        const base = { isPublished: () => true, date: new Date(Date.now() + DAY), availableSeats: 1 };
        assert.doesNotThrow(() => assertBookable(base));
        assert.throws(() => assertBookable(null), (e) => e.status === 404);
        assert.throws(() => assertBookable({ ...base, isPublished: () => false }), (e) => e.status === 404);
        assert.throws(() => assertBookable({ ...base, date: new Date(Date.now() - 1000) }), /already started/);
        assert.throws(() => assertBookable({ ...base, availableSeats: 0 }), /No seats/);
    });
});
