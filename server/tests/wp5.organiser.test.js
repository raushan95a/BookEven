const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

const DAY = 24 * 60 * 60 * 1000;
const future = (days = 5) => new Date(Date.now() + days * DAY).toISOString();
const body = (extra = {}) => ({
    title: 'Community Meetup', description: 'd', date: future(), location: 'Library', category: 'Tech',
    totalSeats: 10, ticketPrice: 0, ...extra
});
const book = async (user, eventId) => {
    const token = t.tokenFor(user);
    await t.models.OTP.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120000) } });
    await t.api('POST', '/bookings/send-otp', { token });
    return t.api('POST', '/bookings', { token, body: { eventId: String(eventId), otp: t.lastCode(user.email, 'event_booking') } });
};
const emailsSince = (n) => t.emails.slice(n);

describe('submitting and reviewing an event', () => {
    let admin; let organiser; let visitor; let eventId;
    before(async () => {
        admin = await t.makeAdmin();
        organiser = await t.makeUser({ name: 'Olivia Organiser' });
        visitor = await t.makeUser();
    });

    test('a user\'s new event waits for review; status/createdBy in the body are ignored; admins are emailed', async () => {
        const before = t.emails.length;
        const r = await t.api('POST', '/events', { token: t.tokenFor(organiser), body: body({ status: 'published', createdBy: visitor.id }) });
        assert.equal(r.status, 201, JSON.stringify(r.data));
        assert.equal(r.data.status, 'pending_review');
        assert.equal(r.data.createdBy, organiser.id);
        eventId = r.data._id;
        const mail = await t.waitForEmail((m, i) => i >= before && m.type === 'event_submitted' && m.to === admin.email && m.kind === 'new');
        assert.ok(mail, 'admin emailed (sent in the background)');
        assert.equal(mail.organiser, 'Olivia Organiser');
    });

    test('hidden from the public, visible to its organiser and admins, not bookable', async () => {
        let r = await t.api('GET', '/events');
        assert.ok(!r.data.some((e) => e._id === eventId));
        assert.equal((await t.api('GET', `/events/${eventId}`)).status, 404);
        assert.equal((await t.api('GET', `/events/${eventId}`, { token: t.tokenFor(visitor) })).status, 404);
        assert.equal((await t.api('GET', `/events/${eventId}`, { token: t.tokenFor(organiser) })).status, 200);
        assert.equal((await t.api('GET', `/events/${eventId}`, { token: t.tokenFor(admin) })).status, 200);
        r = await t.api('GET', '/events/mine', { token: t.tokenFor(organiser) });
        assert.deepEqual(r.data.map((e) => e._id), [eventId]);
        r = await book(visitor, eventId);
        assert.equal(r.status, 404);
    });

    test('an invalid token on public pages is ignored, not a 401', async () => {
        const r = await t.api('GET', '/events', { token: 'not-a-real-token' });
        assert.equal(r.status, 200);
    });

    test('?scope=all is admin only and includes events under review', async () => {
        assert.equal((await t.api('GET', '/events?scope=all', { token: t.tokenFor(organiser) })).status, 403);
        assert.equal((await t.api('GET', '/events?scope=all')).status, 403);
        const r = await t.api('GET', '/events?scope=all', { token: t.tokenFor(admin) });
        assert.ok(r.data.some((e) => e._id === eventId));
    });

    test('review queue lists it with the organiser; only admins can review', async () => {
        let r = await t.api('GET', '/events/review', { token: t.tokenFor(admin) });
        const item = r.data.find((e) => e._id === eventId);
        assert.ok(item);
        assert.equal(item.createdBy.email, organiser.email);
        assert.equal((await t.api('GET', '/events/review', { token: t.tokenFor(organiser) })).status, 403);
        r = await t.api('PUT', `/events/${eventId}/review`, { token: t.tokenFor(organiser), body: { decision: 'approve' } });
        assert.equal(r.status, 403);
        r = await t.api('PUT', `/events/${eventId}/review`, { token: t.tokenFor(admin), body: { decision: 'maybe' } });
        assert.equal(r.status, 400);
    });

    test('admin rejects with a reason; organiser is emailed; still hidden', async () => {
        const before = t.emails.length;
        const r = await t.api('PUT', `/events/${eventId}/review`, { token: t.tokenFor(admin), body: { decision: 'reject', reason: 'Please add the room number' } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.event.status, 'rejected');
        assert.equal(r.data.event.reviewNote, 'Please add the room number');
        assert.equal(r.data.emailSent, true);
        const mail = emailsSince(before).find((e) => e.type === 'event_review');
        assert.deepEqual([mail.to, mail.decision, mail.kind, mail.reason], [organiser.email, 'reject', 'event', 'Please add the room number']);
        assert.equal((await t.api('GET', `/events/${eventId}`)).status, 404);
    });

    test('editing a rejected event sends it back for review and notifies admins', async () => {
        const before = t.emails.length;
        const r = await t.api('PUT', `/events/${eventId}`, { token: t.tokenFor(organiser), body: { location: 'Library, Room 4' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.status, 'pending_review');
        assert.equal(r.data.location, 'Library, Room 4');
        assert.equal(r.data.reviewNote, undefined);
        assert.ok(await t.waitForEmail((e, i) => i >= before && e.type === 'event_submitted' && e.kind === 'resubmitted'));
    });

    test('admin approves: published, public, bookable; organiser emailed', async () => {
        const before = t.emails.length;
        let r = await t.api('PUT', `/events/${eventId}/review`, { token: t.tokenFor(admin), body: { decision: 'approve' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.event.status, 'published');
        assert.equal(r.data.reviewed, 'event');
        assert.ok(emailsSince(before).some((e) => e.type === 'event_review' && e.decision === 'approve' && e.to === organiser.email));
        r = await t.api('GET', '/events?when=upcoming');
        assert.ok(r.data.some((e) => e._id === eventId));
        r = await book(visitor, eventId);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        r = await t.api('PUT', `/events/${eventId}/review`, { token: t.tokenFor(admin), body: { decision: 'approve' } });
        assert.equal(r.status, 400, 'nothing left to review');
    });

    test('an event whose date passed while waiting cannot be approved', async () => {
        const stale = await t.makeEvent({ createdBy: organiser._id, status: 'pending_review', date: new Date(Date.now() - 1000) });
        const r = await t.api('PUT', `/events/${stale.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve' } });
        assert.equal(r.status, 400);
    });

    test('events created by an admin are published straight away, no review email', async () => {
        const before = t.emails.length;
        const r = await t.api('POST', '/events', { token: t.tokenFor(admin), body: body({ title: 'Admin Event' }) });
        assert.equal(r.data.status, 'published');
        await new Promise((resolve) => setTimeout(resolve, 300)); // background emails would have arrived
        assert.equal(emailsSince(before).filter((e) => e.type === 'event_submitted').length, 0);
    });
});

describe('changes to a published event', () => {
    let admin; let organiser; let event;
    before(async () => {
        admin = await t.makeAdmin();
        organiser = await t.makeUser();
        event = await t.makeEvent({ createdBy: organiser._id, status: 'published', title: 'Live Title', ticketPrice: 100, totalSeats: 10, availableSeats: 10 });
    });

    test('big changes wait for review, small ones apply now, live event stays bookable', async () => {
        const before = t.emails.length;
        const r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { title: 'New Title', ticketPrice: 150, totalSeats: 12, approvalMode: 'auto' } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.title, 'Live Title', 'live title unchanged');
        assert.equal(r.data.ticketPrice, 100);
        assert.equal(r.data.pendingChanges.title, 'New Title');
        assert.equal(r.data.pendingChanges.ticketPrice, 150);
        assert.equal(r.data.totalSeats, 12, 'seats apply at once');
        assert.equal(r.data.availableSeats, 12);
        assert.equal(r.data.approvalMode, 'auto');
        assert.deepEqual(r.data.changesAwaitingReview.sort(), ['ticketPrice', 'title']);
        assert.ok(await t.waitForEmail((e, i) => i >= before && e.type === 'event_submitted' && e.kind === 'changes'));
        const pub = await t.api('GET', `/events/${event.id}`);
        assert.equal(pub.status, 200);
        assert.equal(pub.data.title, 'Live Title');
        const booked = await book(await t.makeUser(), event.id);
        assert.equal(booked.status, 201);
        assert.equal(booked.data.booking.amount, 100, 'booked at the live price');
    });

    test('proposed changes and admin notes are never shown to the public', async () => {
        const visitor = await t.makeUser();
        for (const token of [undefined, t.tokenFor(visitor)]) {
            const one = await t.api('GET', `/events/${event.id}`, { token });
            assert.equal(one.data.pendingChanges, undefined);
            assert.equal(one.data.reviewNote, undefined);
            const list = await t.api('GET', '/events', { token });
            const item = list.data.find((e) => e._id === event.id);
            assert.ok(item);
            assert.equal(item.pendingChanges, undefined);
        }
        const own = await t.api('GET', `/events/${event.id}`, { token: t.tokenFor(organiser) });
        assert.equal(own.data.pendingChanges.title, 'New Title', 'the organiser still sees them');
    });

    test('setting a field back to its live value drops that proposal', async () => {
        const r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { ticketPrice: 100 } });
        assert.equal(r.data.pendingChanges.ticketPrice, undefined);
        assert.equal(r.data.pendingChanges.title, 'New Title');
    });

    test('the review queue shows events with waiting changes; approving applies them', async () => {
        let r = await t.api('GET', '/events/review', { token: t.tokenFor(admin) });
        assert.ok(r.data.some((e) => e._id === event.id && e.pendingChanges.title === 'New Title'));
        r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.reviewed, 'changes');
        assert.equal(r.data.event.title, 'New Title');
        assert.equal(r.data.event.pendingChanges, undefined);
        assert.equal(r.data.event.status, 'published');
    });

    test('rejecting changes discards them and keeps the live event', async () => {
        await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { location: 'Somewhere else', date: future(9) } });
        const before = t.emails.length;
        const r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'reject', reason: 'Venue not confirmed' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.event.location, event.location);
        assert.equal(r.data.event.pendingChanges, undefined);
        assert.equal(r.data.event.reviewNote, 'Venue not confirmed');
        const mail = emailsSince(before).find((e) => e.type === 'event_review');
        assert.deepEqual([mail.decision, mail.kind], ['reject', 'changes']);
    });

    test('admin edits to any event apply immediately', async () => {
        const r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(admin), body: { title: 'Admin Renamed' } });
        assert.equal(r.data.title, 'Admin Renamed');
        assert.equal(r.data.pendingChanges, undefined);
    });
});

describe('organiser access is limited to their own events', () => {
    let admin; let olivia; let oscar; let oliviaEvent; let oscarEvent; let attendee; let oliviaBooking; let oscarBooking;
    before(async () => {
        admin = await t.makeAdmin();
        olivia = await t.makeUser();
        oscar = await t.makeUser();
        attendee = await t.makeUser();
        oliviaEvent = await t.makeEvent({ createdBy: olivia._id, status: 'published', ticketPrice: 200, totalSeats: 5, availableSeats: 5 });
        oscarEvent = await t.makeEvent({ createdBy: oscar._id, status: 'published', ticketPrice: 300, totalSeats: 5, availableSeats: 5 });
        oliviaBooking = await t.makeBooking(attendee, oliviaEvent);
        oscarBooking = await t.makeBooking(attendee, oscarEvent);
        await t.makeBooking(await t.makeUser(), oliviaEvent, { status: 'confirmed', paymentStatus: 'paid', amount: 200 });
    });

    test('booking list and stats show only their events', async () => {
        let r = await t.api('GET', '/bookings?limit=100', { token: t.tokenFor(olivia) });
        assert.equal(r.status, 200);
        assert.equal(r.data.total, 2);
        assert.ok(r.data.items.every((b) => b.eventId._id === oliviaEvent.id));
        assert.ok(r.data.items[0].userId.email, 'organisers see who booked');
        r = await t.api('GET', '/bookings/stats', { token: t.tokenFor(olivia) });
        assert.deepEqual([r.data.totalBookings, r.data.totalRevenue, r.data.pendingRequests], [2, 200, 1]);
        r = await t.api('GET', `/bookings?eventId=${oscarEvent.id}`, { token: t.tokenFor(olivia) });
        assert.equal(r.status, 403);
        r = await t.api('GET', `/bookings/stats?eventId=${oscarEvent.id}`, { token: t.tokenFor(olivia) });
        assert.equal(r.status, 403);
    });

    test('can approve, reject and mark paid on their own event\'s bookings only', async () => {
        const token = t.tokenFor(olivia);
        let r = await t.api('PUT', `/bookings/${oscarBooking.id}/confirm`, { token, body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 403);
        r = await t.api('PUT', `/bookings/${oscarBooking.id}/reject`, { token, body: {} });
        assert.equal(r.status, 403);
        assert.equal((await t.models.Booking.findById(oscarBooking.id)).status, 'pending');
        r = await t.api('PUT', `/bookings/${oliviaBooking.id}/confirm`, { token, body: { paymentStatus: 'not_paid' } });
        assert.equal(r.status, 200);
        r = await t.api('PUT', `/bookings/${oliviaBooking.id}/payment`, { token, body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 200);
        r = await t.api('PUT', `/bookings/${oscarBooking.id}/payment`, { token, body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 403);
    });

    test('can cancel bookings on their own event, not on others', async () => {
        const extra = await t.makeBooking(await t.makeUser(), oliviaEvent);
        assert.equal((await t.api('DELETE', `/bookings/${extra.id}`, { token: t.tokenFor(olivia) })).status, 200);
        assert.equal((await t.api('DELETE', `/bookings/${oscarBooking.id}`, { token: t.tokenFor(olivia) })).status, 403);
    });

    test('cannot edit, delete or see the unpublished events of another organiser', async () => {
        const token = t.tokenFor(olivia);
        assert.equal((await t.api('PUT', `/events/${oscarEvent.id}`, { token, body: { title: 'Hacked' } })).status, 403);
        assert.equal((await t.api('DELETE', `/events/${oscarEvent.id}`, { token })).status, 403);
        const hidden = await t.makeEvent({ createdBy: oscar._id, status: 'pending_review' });
        assert.equal((await t.api('GET', `/events/${hidden.id}`, { token })).status, 404);
        const mine = await t.api('GET', '/events/mine', { token });
        assert.ok(mine.data.every((e) => e.createdBy === olivia.id));
    });

    test('admin keeps full access to every organiser\'s bookings', async () => {
        const r = await t.api('PUT', `/bookings/${oscarBooking.id}/reject`, { token: t.tokenFor(admin), body: { reason: 'Admin decision' } });
        assert.equal(r.status, 200);
    });

    test('organiser deletes their own event: bookings cancelled and attendees emailed', async () => {
        const before = t.emails.length;
        const r = await t.api('DELETE', `/events/${oliviaEvent.id}`, { token: t.tokenFor(olivia) });
        assert.equal(r.status, 200);
        assert.equal(r.data.cancelledBookings, 2);
        assert.equal(emailsSince(before).filter((e) => e.type === 'event_cancelled').length, 2);
        assert.equal(await t.models.Event.findById(oliviaEvent.id), null);
    });

    test('/events/mine needs a login', async () => {
        assert.equal((await t.api('GET', '/events/mine')).status, 401);
    });
});

describe('organisers cannot book their own events', () => {
    let organiser; let other; let admin;
    before(async () => {
        organiser = await t.makeUser({ name: 'Own Event Organiser' });
        other = await t.makeUser();
        admin = await t.makeAdmin();
    });

    test('booking your own event is refused (manual and auto); no seat taken, no booking stored', async () => {
        for (const approvalMode of ['manual', 'auto']) {
            const event = await t.makeEvent({ createdBy: organiser._id, status: 'published', approvalMode });
            const r = await book(organiser, event._id);
            assert.equal(r.status, 403, JSON.stringify(r.data));
            assert.match(r.data.message, /your own event/);
            assert.equal(await t.models.Booking.countDocuments({ eventId: event._id }), 0);
            assert.equal((await t.models.Event.findById(event._id)).availableSeats, 10);
        }
    });

    test('send-otp with eventId refuses your own event and sends no email', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published' });
        await t.models.OTP.deleteMany({});
        const before = t.emails.length;
        const r = await t.api('POST', '/bookings/send-otp', { token: t.tokenFor(organiser), body: { eventId: String(event._id) } });
        assert.equal(r.status, 403);
        assert.equal(emailsSince(before).length, 0);
    });

    test('send-otp with eventId refuses unpublished events and bad ids', async () => {
        const hidden = await t.makeEvent({ createdBy: organiser._id, status: 'pending_review' });
        const token = t.tokenFor(other);
        assert.equal((await t.api('POST', '/bookings/send-otp', { token, body: { eventId: String(hidden._id) } })).status, 404);
        assert.equal((await t.api('POST', '/bookings/send-otp', { token, body: { eventId: 'nope' } })).status, 400);
    });

    test('an admin cannot book an event they created, but other users can', async () => {
        const r = await t.api('POST', '/events', { token: t.tokenFor(admin), body: body({ approvalMode: 'auto' }) });
        assert.equal(r.status, 201);
        assert.equal((await book(admin, r.data._id)).status, 403);
        const ok = await book(other, r.data._id);
        assert.equal(ok.status, 201, JSON.stringify(ok.data));
        assert.equal(ok.data.autoConfirmed, true);
    });

    test('send-otp with eventId works for someone else\'s published event', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published' });
        await t.models.OTP.deleteMany({});
        const r = await t.api('POST', '/bookings/send-otp', { token: t.tokenFor(other), body: { eventId: String(event._id) } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
    });
});

describe('rules once an event has started', () => {
    let organiser; let attendee; let admin;
    const pastDate = () => new Date(Date.now() - 60 * 60 * 1000);
    before(async () => {
        organiser = await t.makeUser({ name: 'Past Organiser' });
        attendee = await t.makeUser();
        admin = await t.makeAdmin();
    });

    test('a pending request cannot be approved after the event starts, but can be declined', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, date: pastDate() });
        const pending = await t.makeBooking(attendee, event);
        let r = await t.api('PUT', `/bookings/${pending.id}/confirm`, { token: t.tokenFor(organiser), body: { paymentStatus: 'paid' } });
        assert.equal(r.status, 400);
        assert.match(r.data.message, /already started/);
        assert.equal((await t.models.Event.findById(event._id)).availableSeats, 10, 'no seat taken');
        r = await t.api('PUT', `/bookings/${pending.id}/reject`, { token: t.tokenFor(admin), body: { reason: 'Too late' } });
        assert.equal(r.status, 200);
    });

    test('an attendee cannot cancel after the event starts; the organiser and admin still can', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, date: pastDate(), availableSeats: 8 });
        const a = await t.makeBooking(attendee, event, { status: 'confirmed', paymentStatus: 'paid' });
        let r = await t.api('DELETE', `/bookings/${a.id}`, { token: t.tokenFor(attendee) });
        assert.equal(r.status, 400);
        assert.equal((await t.models.Booking.findById(a.id)).status, 'confirmed');
        r = await t.api('DELETE', `/bookings/${a.id}`, { token: t.tokenFor(organiser) });
        assert.equal(r.status, 200);
        const b = await t.makeBooking(await t.makeUser(), event, { status: 'confirmed' });
        r = await t.api('DELETE', `/bookings/${b.id}`, { token: t.tokenFor(admin) });
        assert.equal(r.status, 200);
    });

    test('an attendee can still cancel before the event starts', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, availableSeats: 9 });
        const b = await t.makeBooking(attendee, event, { status: 'confirmed' });
        const r = await t.api('DELETE', `/bookings/${b.id}`, { token: t.tokenFor(attendee) });
        assert.equal(r.status, 200);
        assert.equal((await t.models.Event.findById(event._id)).availableSeats, 10);
    });

    test('a past event with active bookings cannot be deleted; nothing changes and no emails go out', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, date: pastDate(), availableSeats: 9 });
        const b = await t.makeBooking(attendee, event, { status: 'confirmed', paymentStatus: 'paid' });
        const before = t.emails.length;
        for (const user of [organiser, admin]) {
            const r = await t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(user) });
            assert.equal(r.status, 400);
            assert.match(r.data.message, /kept as a record/);
        }
        assert.ok(await t.models.Event.findById(event._id));
        assert.equal((await t.models.Booking.findById(b.id)).status, 'confirmed');
        assert.equal(emailsSince(before).filter((e) => e.type === 'event_cancelled').length, 0);
    });

    test('a past event with no active bookings can still be deleted', async () => {
        const event = await t.makeEvent({ createdBy: organiser._id, date: pastDate() });
        await t.makeBooking(attendee, event, { status: 'cancelled' });
        const r = await t.api('DELETE', `/events/${event.id}`, { token: t.tokenFor(organiser) });
        assert.equal(r.status, 200);
    });
});

describe('admin edits and waiting organiser changes', () => {
    test('an admin edit replaces the waiting proposal for that field; other proposed fields stay', async () => {
        const organiser = await t.makeUser();
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published', title: 'Original' });
        let r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { title: 'Organiser title', location: 'New hall' } });
        assert.deepEqual(r.data.changesAwaitingReview.sort(), ['location', 'title']);
        const oldVersion = (await t.models.Event.findById(event._id)).pendingChanges.submittedAt.toISOString();

        r = await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(admin), body: { title: 'Admin title' } });
        assert.equal(r.status, 200);
        assert.equal(r.data.title, 'Admin title');
        let saved = await t.models.Event.findById(event._id);
        assert.equal(saved.pendingChanges.title, undefined, 'title proposal dropped');
        assert.equal(saved.pendingChanges.location, 'New hall', 'location proposal kept');

        // A review of the old version is refused, so the admin re-checks before approving.
        r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve', version: oldVersion } });
        assert.equal(r.status, 409);
        r = await t.api('PUT', `/events/${event.id}/review`, { token: t.tokenFor(admin), body: { decision: 'approve' } });
        assert.equal(r.status, 200);
        saved = await t.models.Event.findById(event._id);
        assert.equal(saved.title, 'Admin title', 'approval did not undo the admin edit');
        assert.equal(saved.location, 'New hall');
    });

    test('when the admin edit covers every proposed field, nothing is left to review', async () => {
        const organiser = await t.makeUser();
        const admin = await t.makeAdmin();
        const event = await t.makeEvent({ createdBy: organiser._id, status: 'published' });
        await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(organiser), body: { location: 'Somewhere' } });
        await t.api('PUT', `/events/${event.id}`, { token: t.tokenFor(admin), body: { location: 'Admin place' } });
        const saved = await t.models.Event.findById(event._id);
        assert.equal(saved.pendingChanges, undefined);
        assert.equal(saved.location, 'Admin place');
    });
});
