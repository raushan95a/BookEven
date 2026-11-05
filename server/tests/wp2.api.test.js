const { test, before, after, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });
beforeEach(() => { t.emailControl.fail = false; });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Make the latest code look older, to get past the 60-second resend cooldown without waiting.
const ageCodes = (email, ms = 2 * 60 * 1000) =>
    t.models.OTP.collection.updateMany({ email }, { $set: { createdAt: new Date(Date.now() - ms) } });

describe('2.1 / 2.2 email failures and resend-otp', () => {
    test('register with the mail server down: 503, account kept, no usable code stored', async () => {
        t.emailControl.fail = true;
        const r = await t.api('POST', '/auth/register', { body: { name: 'Down', email: 'down@test.com', password: 'Password123' } });
        assert.equal(r.status, 503);
        assert.equal(r.data.accountCreated, true);
        assert.match(r.data.message, /account was created/);
        assert.ok(await t.models.User.findOne({ email: 'down@test.com' }));
        assert.equal(await t.models.OTP.countDocuments({ email: 'down@test.com' }), 0, 'code discarded');
    });

    test('resend-otp right after a failure sends a new code immediately (no cooldown)', async () => {
        const r = await t.api('POST', '/auth/resend-otp', { body: { email: 'DOWN@test.com' } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const code = t.lastCode('down@test.com', 'account_verification');
        assert.ok(code);
        const v = await t.api('POST', '/auth/verify-otp', { body: { email: 'down@test.com', otp: code } });
        assert.equal(v.status, 200);
    });

    test('resend-otp within 60 s returns 429 with Retry-After; after that it sends', async () => {
        await t.api('POST', '/auth/register', { body: { name: 'Wait', email: 'wait@test.com', password: 'Password123' } });
        let r = await t.api('POST', '/auth/resend-otp', { body: { email: 'wait@test.com' } });
        assert.equal(r.status, 429);
        assert.ok(r.data.retryAfterSeconds > 0 && r.data.retryAfterSeconds <= 60);
        assert.equal(Number(r.headers.get('retry-after')), r.data.retryAfterSeconds);
        const first = t.lastCode('wait@test.com', 'account_verification');
        await ageCodes('wait@test.com');
        r = await t.api('POST', '/auth/resend-otp', { body: { email: 'wait@test.com' } });
        assert.equal(r.status, 200);
        const second = t.lastCode('wait@test.com', 'account_verification');
        const old = await t.api('POST', '/auth/verify-otp', { body: { email: 'wait@test.com', otp: first } });
        if (first !== second) assert.equal(old.status, 400, 'old code replaced');
        const ok = await t.api('POST', '/auth/verify-otp', { body: { email: 'wait@test.com', otp: second } });
        assert.equal(ok.status, 200);
    });

    test('resend-otp gives the same reply for unknown and verified accounts and sends nothing', async () => {
        const verified = await t.makeUser();
        const before = t.emails.length;
        const a = await t.api('POST', '/auth/resend-otp', { body: { email: 'nobody@test.com' } });
        const b = await t.api('POST', '/auth/resend-otp', { body: { email: verified.email } });
        assert.equal(a.status, 200);
        assert.deepEqual(a.data, b.data);
        assert.equal(t.emails.length, before);
    });

    test('resend-otp with the mail server down returns 503; validation and injection rejected', async () => {
        await t.api('POST', '/auth/register', { body: { name: 'Fail', email: 'fail2@test.com', password: 'Password123' } });
        await ageCodes('fail2@test.com');
        t.emailControl.fail = true;
        let r = await t.api('POST', '/auth/resend-otp', { body: { email: 'fail2@test.com' } });
        assert.equal(r.status, 503);
        t.emailControl.fail = false;
        r = await t.api('POST', '/auth/resend-otp', { body: { email: { $ne: null } } });
        assert.equal(r.status, 400);
        r = await t.api('POST', '/auth/resend-otp', { body: {} });
        assert.equal(r.status, 400);
    });

    test('login of an unverified user with the mail server down: 503, not "check your email"', async () => {
        await t.api('POST', '/auth/register', { body: { name: 'L', email: 'login-down@test.com', password: 'Password123' } });
        await ageCodes('login-down@test.com');
        t.emailControl.fail = true;
        const r = await t.api('POST', '/auth/login', { body: { email: 'login-down@test.com', password: 'Password123' } });
        assert.equal(r.status, 503);
        assert.equal(r.data.needsVerification, undefined);
    });

    test('booking send-otp: 503 when email fails, then an immediate retry works', async () => {
        const user = await t.makeUser();
        const token = t.tokenFor(user);
        t.emailControl.fail = true;
        let r = await t.api('POST', '/bookings/send-otp', { token });
        assert.equal(r.status, 503);
        t.emailControl.fail = false;
        r = await t.api('POST', '/bookings/send-otp', { token });
        assert.equal(r.status, 200);
        assert.equal(r.data.message, 'OTP sent successfully');
        r = await t.api('POST', '/bookings/send-otp', { token });
        assert.equal(r.status, 200);
        assert.match(r.data.message, /sent recently/);
        assert.ok(r.data.retryAfterSeconds > 0);
    });

    test('approval reports emailSent true/false; a failed email never undoes the approval', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ totalSeats: 5, availableSeats: 5 });
        const b1 = await t.makeBooking(await t.makeUser(), event);
        const b2 = await t.makeBooking(await t.makeUser(), event);
        let r = await t.api('PUT', `/bookings/${b1.id}/confirm`, { token: t.tokenFor(admin), body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.emailSent, true);
        t.emailControl.fail = true;
        r = await t.api('PUT', `/bookings/${b2.id}/confirm`, { token: t.tokenFor(admin), body: {} });
        assert.equal(r.status, 200);
        assert.equal(r.data.emailSent, false);
        assert.equal((await t.models.Booking.findById(b2.id)).status, 'confirmed');
        assert.equal((await t.models.Event.findById(event.id)).availableSeats, 3);
    });

    test('event deletion reports how many emails were sent and failed', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent();
        await t.makeBooking(await t.makeUser(), event);
        await t.makeBooking(await t.makeUser(), event, { status: 'confirmed' });
        t.emailControl.fail = true;
        const r = await t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(admin) });
        assert.equal(r.status, 200);
        assert.deepEqual([r.data.cancelledBookings, r.data.emailsSent, r.data.emailsFailed], [2, 0, 2]);
    });
});

describe('2.3 reject endpoint', () => {
    test('admin rejects a pending booking with a reason; user is emailed', async () => {
        const admin = await t.makeAdmin();
        const user = await t.makeUser();
        const event = await t.makeEvent({ title: 'Reject Me' });
        const booking = await t.makeBooking(user, event);
        const r = await t.api('PUT', `/bookings/${booking.id}/reject`, { token: t.tokenFor(admin), body: { reason: 'Payment not received' } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.booking.status, 'rejected');
        assert.equal(r.data.booking.statusReason, 'Payment not received');
        assert.equal(r.data.booking.userId.password, undefined);
        assert.equal(r.data.emailSent, true);
        const mail = t.emails.at(-1);
        assert.deepEqual([mail.type, mail.to, mail.title, mail.reason], ['rejected', user.email, 'Reject Me', 'Payment not received']);
    });

    test('reason is optional; empty string is treated as none', async () => {
        const admin = await t.makeAdmin();
        const booking = await t.makeBooking(await t.makeUser(), await t.makeEvent());
        const r = await t.api('PUT', `/bookings/${booking.id}/reject`, { token: t.tokenFor(admin), body: { reason: '' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.booking.statusReason, undefined);
    });

    test('rejects: non-admin 403, no token 401, bad id 400, unknown 404, non-pending 400, bad reason 400', async () => {
        const admin = await t.makeAdmin();
        const event = await t.makeEvent();
        const pending = await t.makeBooking(await t.makeUser(), event);
        const confirmed = await t.makeBooking(await t.makeUser(), event, { status: 'confirmed' });
        const token = t.tokenFor(admin);
        assert.equal((await t.api('PUT', `/bookings/${pending.id}/reject`, { token: t.tokenFor(await t.makeUser()), body: {} })).status, 403);
        assert.equal((await t.api('PUT', `/bookings/${pending.id}/reject`, { body: {} })).status, 401);
        assert.equal((await t.api('PUT', '/bookings/abc/reject', { token, body: {} })).status, 400);
        assert.equal((await t.api('PUT', `/bookings/${new t.mongoose.Types.ObjectId()}/reject`, { token, body: {} })).status, 404);
        assert.equal((await t.api('PUT', `/bookings/${confirmed.id}/reject`, { token, body: {} })).status, 400);
        assert.equal((await t.api('PUT', `/bookings/${pending.id}/reject`, { token, body: { reason: 'x'.repeat(501) } })).status, 400);
        assert.equal((await t.api('PUT', `/bookings/${pending.id}/reject`, { token, body: { reason: { $ne: null } } })).status, 400);
        assert.equal((await t.models.Booking.findById(pending.id)).status, 'pending');
    });

    test('rejection with the mail server down still rejects; emailSent false', async () => {
        const admin = await t.makeAdmin();
        const booking = await t.makeBooking(await t.makeUser(), await t.makeEvent());
        t.emailControl.fail = true;
        const r = await t.api('PUT', `/bookings/${booking.id}/reject`, { token: t.tokenFor(admin), body: {} });
        assert.equal(r.status, 200);
        assert.equal(r.data.emailSent, false);
        assert.equal((await t.models.Booking.findById(booking.id)).status, 'rejected');
    });
});

describe('2.4 admin bookings list', () => {
    let admin; let eventA; let eventB;
    before(async () => {
        admin = await t.makeAdmin();
        eventA = await t.makeEvent({ title: 'List A', totalSeats: 100, availableSeats: 100 });
        eventB = await t.makeEvent({ title: 'List B' });
        await t.models.Booking.deleteMany({});
        for (let i = 0; i < 23; i++) {
            await t.makeBooking(await t.makeUser(), eventA, { status: i % 3 === 0 ? 'confirmed' : 'pending', createdAt: new Date(Date.now() - (30 - i) * 1000) });
        }
        for (let i = 0; i < 4; i++) await t.makeBooking(await t.makeUser(), eventB, { status: 'cancelled' });
    });

    test('default page: 20 newest first, with totals', async () => {
        const r = await t.api('GET', '/bookings', { token: t.tokenFor(admin) });
        assert.equal(r.status, 200);
        assert.equal(r.data.items.length, 20);
        assert.deepEqual([r.data.page, r.data.limit, r.data.total, r.data.totalPages], [1, 20, 27, 2]);
        const times = r.data.items.map((b) => new Date(b.createdAt).getTime());
        assert.deepEqual(times, [...times].sort((a, b) => b - a));
        assert.ok(r.data.items[0].userId.email && r.data.items[0].userId.password === undefined);
        assert.ok(r.data.items[0].eventId.title);
    });

    test('pages do not overlap and cover every booking', async () => {
        const token = t.tokenFor(admin);
        const seen = new Set();
        for (let page = 1; page <= 3; page++) {
            const r = await t.api('GET', `/bookings?limit=10&page=${page}`, { token });
            assert.equal(r.data.items.length, page < 3 ? 10 : 7);
            for (const b of r.data.items) seen.add(b._id);
        }
        assert.equal(seen.size, 27);
        const beyond = await t.api('GET', '/bookings?limit=10&page=4', { token });
        assert.equal(beyond.data.items.length, 0);
    });

    test('filters by status and by event', async () => {
        const token = t.tokenFor(admin);
        let r = await t.api('GET', '/bookings?status=confirmed&limit=100', { token });
        assert.equal(r.data.total, 8);
        assert.ok(r.data.items.every((b) => b.status === 'confirmed'));
        r = await t.api('GET', `/bookings?eventId=${eventB.id}`, { token });
        assert.equal(r.data.total, 4);
        r = await t.api('GET', `/bookings?eventId=${eventA.id}&status=pending&limit=100`, { token });
        assert.equal(r.data.total, 15);
    });

    test('bad parameters return 400; non-admin 403; no token 401', async () => {
        const token = t.tokenFor(admin);
        for (const q of ['status=deleted', 'limit=0', 'limit=101', 'limit=abc', 'page=0', 'page=1.5', 'eventId=xyz', 'status[$ne]=x', 'eventId[$ne]=x']) {
            const r = await t.api('GET', `/bookings?${q}`, { token });
            assert.equal(r.status, 400, q);
        }
        assert.equal((await t.api('GET', '/bookings', { token: t.tokenFor(await t.makeUser()) })).status, 403);
        assert.equal((await t.api('GET', '/bookings')).status, 401);
    });

    test('/bookings/my: users see only their own; admins still see all (until the dashboard moves)', async () => {
        const user = await t.makeUser();
        await t.makeBooking(user, eventB);
        let r = await t.api('GET', '/bookings/my', { token: t.tokenFor(user) });
        assert.equal(r.data.length, 1);
        r = await t.api('GET', '/bookings/my', { token: t.tokenFor(admin) });
        assert.equal(r.data.length, await t.models.Booking.countDocuments());
    });
});

describe('2.5 admin stats', () => {
    test('figures match a direct count of the data, overall and per event', async () => {
        await t.models.Booking.deleteMany({});
        const admin = await t.makeAdmin();
        const e1 = await t.makeEvent({ ticketPrice: 500, totalSeats: 50, availableSeats: 50 });
        const e2 = await t.makeEvent({ ticketPrice: 200, totalSeats: 50, availableSeats: 50 });
        const payer = await t.makeUser();
        await t.makeBooking(payer, e1, { status: 'confirmed', paymentStatus: 'paid', amount: 500 });
        await t.makeBooking(payer, e2, { status: 'confirmed', paymentStatus: 'paid', amount: 200 });
        await t.makeBooking(await t.makeUser(), e1, { status: 'confirmed', paymentStatus: 'paid', amount: 500 });
        await t.makeBooking(await t.makeUser(), e1, { status: 'confirmed', paymentStatus: 'not_paid', amount: 500 });
        await t.makeBooking(await t.makeUser(), e1, { status: 'pending', amount: 500 });
        await t.makeBooking(await t.makeUser(), e2, { status: 'pending', amount: 200 });
        await t.makeBooking(await t.makeUser(), e1, { status: 'cancelled', paymentStatus: 'paid', amount: 500 });
        await t.makeBooking(await t.makeUser(), e2, { status: 'rejected', amount: 200 });

        let r = await t.api('GET', '/bookings/stats', { token: t.tokenFor(admin) });
        assert.equal(r.status, 200);
        assert.deepEqual(r.data, {
            totalRevenue: 1200, paidClients: 2, pendingRequests: 2,
            byStatus: { confirmed: 4, cancelled: 1, pending: 2, rejected: 1 }, totalBookings: 8
        });
        r = await t.api('GET', `/bookings/stats?eventId=${e1.id}`, { token: t.tokenFor(admin) });
        assert.deepEqual([r.data.totalRevenue, r.data.paidClients, r.data.pendingRequests, r.data.totalBookings], [1000, 2, 1, 5]);
    });

    test('empty data, bad params, and access control', async () => {
        await t.models.Booking.deleteMany({});
        const admin = await t.makeAdmin();
        let r = await t.api('GET', '/bookings/stats', { token: t.tokenFor(admin) });
        assert.deepEqual([r.data.totalRevenue, r.data.paidClients, r.data.pendingRequests, r.data.totalBookings], [0, 0, 0, 0]);
        r = await t.api('GET', '/bookings/stats?eventId=bad', { token: t.tokenFor(admin) });
        assert.equal(r.status, 400);
        r = await t.api('GET', '/bookings/stats?status=pending', { token: t.tokenFor(admin) });
        assert.equal(r.status, 400);
        assert.equal((await t.api('GET', '/bookings/stats', { token: t.tokenFor(await t.makeUser()) })).status, 403);
    });
});

describe('2.6 / 2.7 event times and upcoming filter', () => {
    test('booking closes when the event starts; one starting in an hour is still open', async () => {
        const started = await t.makeEvent({ date: new Date(Date.now() - 60 * 1000) });
        const soon = await t.makeEvent({ date: new Date(Date.now() + HOUR) });
        const user = await t.makeUser();
        const token = t.tokenFor(user);
        await t.api('POST', '/bookings/send-otp', { token });
        let r = await t.api('POST', '/bookings', { token, body: { eventId: started.id, otp: t.lastCode(user.email, 'event_booking') } });
        assert.equal(r.status, 400);
        assert.equal(r.data.message, 'This event has already started');
        r = await t.api('POST', '/bookings', { token, body: { eventId: soon.id, otp: t.lastCode(user.email, 'event_booking') } });
        assert.equal(r.status, 201, 'the code was not used up by the failed attempt');
    });

    test('creating or moving an event into the past is rejected; future times keep their time of day', async () => {
        const admin = await t.makeAdmin();
        const token = t.tokenFor(admin);
        const body = { title: 'Timed', description: 'd', location: 'l', category: 'Tech', totalSeats: 10, ticketPrice: 0 };
        let r = await t.api('POST', '/events', { token, body: { ...body, date: new Date(Date.now() - DAY).toISOString() } });
        assert.equal(r.status, 400);
        assert.equal(r.data.message, 'Date must be in the future');
        const when = new Date(Date.now() + 3 * DAY);
        when.setUTCHours(18, 30, 0, 0);
        r = await t.api('POST', '/events', { token, body: { ...body, date: when.toISOString() } });
        assert.equal(r.status, 201);
        assert.equal(r.data.date, when.toISOString());
        const id = r.data._id;
        r = await t.api('PUT', `/events/${id}`, { token, body: { date: new Date(Date.now() - HOUR).toISOString() } });
        assert.equal(r.status, 400);
        r = await t.api('PUT', `/events/${id}`, { token, body: { title: 'Renamed only' } });
        assert.equal(r.status, 200, 'updates without a date are unaffected');
    });

    test('?when=upcoming lists only future events, soonest first; past and all work; bad value 400', async () => {
        await t.models.Event.deleteMany({});
        const inserted = [];
        for (const [title, offset] of [['P2', -2 * DAY], ['F3', 3 * DAY], ['P1', -1 * DAY], ['F1', HOUR], ['F2', 2 * DAY]]) {
            inserted.push(await t.makeEvent({ title, date: new Date(Date.now() + offset) }));
        }
        let r = await t.api('GET', '/events?when=upcoming');
        assert.deepEqual(r.data.map((e) => e.title), ['F1', 'F2', 'F3']);
        r = await t.api('GET', '/events?when=past');
        assert.deepEqual(r.data.map((e) => e.title), ['P1', 'P2']);
        r = await t.api('GET', '/events');
        assert.deepEqual(r.data.map((e) => e.title), ['P2', 'F3', 'P1', 'F1', 'F2'], 'default keeps the original order');
        r = await t.api('GET', '/events?when=upcoming&search=F2');
        assert.deepEqual(r.data.map((e) => e.title), ['F2']);
        r = await t.api('GET', '/events?when=tomorrow');
        assert.equal(r.status, 400);
        r = await t.api('GET', '/events?when[$ne]=x');
        assert.equal(r.status, 400);
    });
});

describe('2.8 token lifetime', () => {
    test('tokens last 7 days by default', async () => {
        const user = await t.makeUser();
        const r = await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Password123' } });
        assert.equal(r.status, 200);
        const { iat, exp } = jwt.decode(r.data.token);
        assert.equal(exp - iat, 7 * 24 * 60 * 60);
    });
});

describe('every endpoint, one complete journey', () => {
    test('register -> verify -> login -> book -> reject -> rebook -> approve -> stats -> cancel -> delete event', async () => {
        const admin = await t.makeAdmin();
        const adminToken = t.tokenFor(admin);

        // Events: create, read, update, list
        let r = await t.api('POST', '/events', { token: adminToken, body: { title: 'Journey Fest', description: 'd', date: new Date(Date.now() + 5 * DAY).toISOString(), location: 'Hall', category: 'Music', totalSeats: 2, ticketPrice: 300 } });
        assert.equal(r.status, 201);
        const eventId = r.data._id;
        assert.equal((await t.api('GET', `/events/${eventId}`)).data.title, 'Journey Fest');
        assert.equal((await t.api('PUT', `/events/${eventId}`, { token: adminToken, body: { location: 'Big Hall' } })).data.location, 'Big Hall');
        assert.ok((await t.api('GET', '/events?when=upcoming')).data.some((e) => e._id === eventId));

        // Auth: register, verify, login
        r = await t.api('POST', '/auth/register', { body: { name: 'Jo', email: 'Jo@Journey.com', password: 'Password123' } });
        assert.equal(r.status, 201);
        r = await t.api('POST', '/auth/verify-otp', { body: { email: 'jo@journey.com', otp: t.lastCode('jo@journey.com', 'account_verification') } });
        assert.equal(r.status, 200);
        r = await t.api('POST', '/auth/login', { body: { email: 'jo@journey.com', password: 'Password123' } });
        const token = r.data.token;
        assert.ok(token);

        // Book
        const book = async () => {
            await t.api('POST', '/bookings/send-otp', { token });
            return t.api('POST', '/bookings', { token, body: { eventId, otp: t.lastCode('jo@journey.com', 'event_booking') } });
        };
        r = await book();
        assert.equal(r.status, 201);
        let bookingId = r.data.booking._id;

        // Admin sees it, rejects it
        r = await t.api('GET', `/bookings?eventId=${eventId}`, { token: adminToken });
        assert.equal(r.data.total, 1);
        r = await t.api('PUT', `/bookings/${bookingId}/reject`, { token: adminToken, body: { reason: 'Full guest list' } });
        assert.equal(r.status, 200);
        r = await t.api('GET', '/bookings/my', { token });
        assert.equal(r.data[0].status, 'rejected');
        assert.equal(r.data[0].statusReason, 'Full guest list');

        // Rebook (allowed after rejection), approve as paid
        await ageCodes('jo@journey.com');
        r = await book();
        assert.equal(r.status, 201, JSON.stringify(r.data));
        bookingId = r.data.booking._id;
        r = await t.api('PUT', `/bookings/${bookingId}/confirm`, { token: adminToken, body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 200);
        assert.equal((await t.api('GET', `/events/${eventId}`)).data.availableSeats, 1);
        r = await t.api('GET', `/bookings/stats?eventId=${eventId}`, { token: adminToken });
        assert.deepEqual([r.data.totalRevenue, r.data.paidClients, r.data.byStatus.rejected], [300, 1, 1]);

        // User cancels: seat returns
        r = await t.api('DELETE', `/bookings/${bookingId}`, { token });
        assert.equal(r.status, 200);
        assert.equal((await t.api('GET', `/events/${eventId}`)).data.availableSeats, 2);

        // Admin deletes the event: history stays
        r = await t.api('DELETE', `/events/${eventId}`, { token: adminToken });
        assert.equal(r.status, 200);
        r = await t.api('GET', '/bookings/my', { token });
        assert.equal(r.data.length, 2);
        assert.ok(r.data.every((b) => b.eventSnapshot.title === 'Journey Fest'));
    });
});
