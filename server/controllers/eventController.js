const mongoose = require('mongoose');
const Event = require('../models/Event');
const User = require('../models/User');
const bookingService = require('../services/bookingService');
const { sendEventCancelledEmail, sendEventSubmittedEmail, sendEventReviewEmail } = require('../utils/email');
const { isAdmin, ownsEvent, canManageEvent } = require('../utils/permissions');
const {
    HttpError,
    requireString,
    optionalString,
    requireObjectId,
    requireNumber,
    requireDate,
    optionalUrl,
    escapeRegex
} = require('../utils/validation');

const MAX_SEATS = 1000000;
const MAX_PRICE = 10000000;
const WHEN_VALUES = ['all', 'upcoming', 'past'];
const APPROVAL_MODES = ['manual', 'auto'];
const REVIEW_DECISIONS = ['approve', 'reject'];

// Review details visible only to the event's organiser and admins.
const PRIVATE_FIELDS = ['pendingChanges', 'reviewNote', 'reviewedBy', 'reviewedAt'];
const withoutPrivateFields = (event) => {
    const plain = event.toObject();
    for (const field of PRIVATE_FIELDS) delete plain[field];
    return plain;
};

// Only published events (or events from before review existed) are public.
const publicStatusFilter = () => mongoose.trusted({ $nin: Event.HIDDEN_STATUSES });

// Builds a clean event object from the request, field by field. Fields that are not
// listed here (availableSeats, createdBy, status, _id, ...) can never be set by a request.
const parseEventInput = (body, { partial }) => {
    const fields = {
        title: (v) => requireString(v, 'Title', { max: 200 }),
        description: (v) => requireString(v, 'Description', { max: 5000 }),
        date: (v) => {
            const date = requireDate(v, 'Date');
            // An event (new or moved) must start in the future, or nobody could book it.
            if (date.getTime() <= Date.now()) throw new HttpError(400, 'Date must be in the future');
            return date;
        },
        location: (v) => requireString(v, 'Location', { max: 200 }),
        category: (v) => requireString(v, 'Category', { max: 50 }),
        totalSeats: (v) => requireNumber(v, 'Total seats', { min: 1, max: MAX_SEATS, integer: true }),
        ticketPrice: (v) => requireNumber(v, 'Ticket price', { min: 0, max: MAX_PRICE }),
        image: (v) => optionalUrl(v, 'Image URL') || '',
        approvalMode: (v) => {
            if (!APPROVAL_MODES.includes(v)) throw new HttpError(400, `approvalMode must be one of: ${APPROVAL_MODES.join(', ')}`);
            return v;
        }
    };

    const result = {};
    for (const [field, parse] of Object.entries(fields)) {
        const value = body[field];
        const isBlank = value === undefined || value === null || value === '';
        if (isBlank && partial) continue;
        if (isBlank && field === 'ticketPrice') {
            result.ticketPrice = 0;
            continue;
        }
        if (isBlank && field === 'image') {
            result.image = '';
            continue;
        }
        if (isBlank && field === 'approvalMode') {
            result.approvalMode = 'manual';
            continue;
        }
        result[field] = parse(value);
    }
    return result;
};

// Emails every admin about a submission. Never blocks or fails the request.
const notifyAdmins = async (organiser, eventTitle, kind) => {
    try {
        const admins = await User.find({ role: 'admin' }).select('email');
        await Promise.allSettled(admins.map((a) => sendEventSubmittedEmail(a.email, organiser.name, eventTitle, kind)));
    } catch (error) {
        console.error('Could not notify admins about an event submission:', error.message);
    }
};

// Applies field updates, including a capacity change, in one atomic write.
const applyEventUpdate = async (event, fields, extraSet = {}, extraUnset = []) => {
    const { totalSeats, ...set } = fields;
    const update = { $set: { ...set, ...extraSet } };
    if (extraUnset.length) update.$unset = Object.fromEntries(extraUnset.map((f) => [f, '']));
    let filter = { _id: event._id };

    // Changing capacity moves availableSeats by the same amount, so confirmed seats stay counted.
    if (totalSeats !== undefined && totalSeats !== event.totalSeats) {
        const confirmedSeats = event.totalSeats - event.availableSeats;
        if (totalSeats < confirmedSeats) {
            throw new HttpError(400, `Total seats cannot be lower than the ${confirmedSeats} seats already confirmed`);
        }
        const delta = totalSeats - event.totalSeats;
        update.$set.totalSeats = totalSeats;
        update.$inc = { availableSeats: delta };
        // Applies only if nothing changed capacity in between and the result can't go negative.
        filter = {
            _id: event._id,
            totalSeats: event.totalSeats,
            availableSeats: mongoose.trusted({ $gte: Math.max(0, -delta) })
        };
    }

    const updated = await Event.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!updated) throw new HttpError(409, 'Seats changed while saving. Please refresh and try again.');
    return updated;
};

// GET /api/events — public list of published events.
// Admins can add ?scope=all to include events waiting for review or rejected.
exports.getEvents = async (req, res, next) => {
    try {
        const filters = {};
        const category = optionalString(req.query.category, 'Category', { max: 50 });
        const search = optionalString(req.query.search, 'Search', { max: 100 });
        const when = optionalString(req.query.when, 'when', { max: 10 }) || 'all';
        const scope = optionalString(req.query.scope, 'scope', { max: 10 }) || 'public';
        if (!WHEN_VALUES.includes(when)) throw new HttpError(400, `when must be one of: ${WHEN_VALUES.join(', ')}`);
        if (!['public', 'all'].includes(scope)) throw new HttpError(400, 'scope must be public or all');
        if (scope === 'all' && !isAdmin(req.user)) throw new HttpError(403, 'Not authorized as an admin');

        if (scope === 'public') filters.status = publicStatusFilter();
        if (category) filters.category = category;
        // Escaped so user text is matched literally and cannot be a slow regular expression.
        if (search) filters.title = mongoose.trusted({ $regex: escapeRegex(search), $options: 'i' });

        // upcoming: not started yet, soonest first. past: started, most recent first.
        // all (default): every event in its original order, as before.
        // Default: creation order, as before (the status filter would otherwise let the
        // database return them in index order).
        let sort = { _id: 1 };
        const now = new Date();
        if (when === 'upcoming') {
            filters.date = mongoose.trusted({ $gt: now });
            sort = { date: 1 };
        } else if (when === 'past') {
            filters.date = mongoose.trusted({ $lte: now });
            sort = { date: -1 };
        }

        // Only the organiser's name is public; their email stays private.
        const query = Event.find(filters).populate('createdBy', 'name');
        if (scope === 'public') query.select(PRIVATE_FIELDS.map((f) => `-${f}`).join(' '));
        query.sort(sort);
        const events = await query;
        res.json(events);
    } catch (error) {
        next(error);
    }
};

// GET /api/events/:id — published events for everyone; unpublished ones only for
// their organiser and admins (others get 404, as if it did not exist).
exports.getEventById = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const event = await Event.findById(eventId).populate('createdBy', 'name');
        const manager = canManageEvent(req.user, event);
        if (!event || (!event.isPublished() && !manager)) {
            return res.status(404).json({ message: 'Event not found' });
        }
        res.json(manager ? event : withoutPrivateFields(event));
    } catch (error) {
        next(error);
    }
};

// GET /api/events/mine — every event the caller created, any status, newest first.
exports.getMyEvents = async (req, res, next) => {
    try {
        const events = await Event.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
        res.json(events);
    } catch (error) {
        next(error);
    }
};

// POST /api/events — admins publish directly; anyone else's event waits for review.
exports.createEvent = async (req, res, next) => {
    try {
        const data = parseEventInput(req.body, { partial: false });
        const byAdmin = isAdmin(req.user);
        const event = await Event.create({
            ...data,
            availableSeats: data.totalSeats,
            createdBy: req.user._id,
            status: byAdmin ? 'published' : 'pending_review'
        });
        // Emails go out in the background so a slow mail server never delays the reply.
        if (!byAdmin) notifyAdmins(req.user, event.title, 'new');
        res.status(201).json(event);
    } catch (error) {
        next(error);
    }
};

// PUT /api/events/:id — admin or the event's organiser.
// Admin edits apply at once. Organiser edits to a published event: title, description,
// date, location and price wait for approval (the live event is unchanged meanwhile);
// seats, image, category and booking approval apply at once. Editing a rejected event
// sends it back for review.
exports.updateEvent = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const updates = parseEventInput(req.body, { partial: true });

        const event = await Event.findById(eventId);
        if (!event) return res.status(404).json({ message: 'Event not found' });
        if (!canManageEvent(req.user, event)) throw new HttpError(403, 'Not authorized to edit this event');

        if (isAdmin(req.user) || event.status === 'pending_review') {
            return res.json(await applyEventUpdate(event, updates));
        }

        if (event.status === 'rejected') {
            // A rejected event that is edited goes back into the review queue.
            const updated = await applyEventUpdate(event, updates, { status: 'pending_review' }, ['reviewNote']);
            notifyAdmins(req.user, updated.title, 'resubmitted');
            return res.json(updated);
        }

        // Published: split into changes that need review and changes that apply now.
        const reviewed = {};
        const direct = {};
        const backToLive = [];
        for (const [field, value] of Object.entries(updates)) {
            const current = event[field] instanceof Date ? event[field].getTime() : event[field];
            const next = value instanceof Date ? value.getTime() : value;
            if (!Event.REVIEWED_FIELDS.includes(field)) direct[field] = value;
            else if (current !== next) reviewed[field] = value;
            else backToLive.push(field); // set back to the live value: drop any waiting proposal
        }

        // Merge with any changes already waiting; newest values win.
        const { submittedAt: previousSubmission, ...waiting } = event.pendingChanges ? event.pendingChanges.toObject() : {};
        const withdrawn = backToLive.filter((field) => field in waiting);
        for (const field of withdrawn) delete waiting[field];
        const proposalChanged = Object.keys(reviewed).length > 0 || withdrawn.length > 0;
        const merged = { ...waiting, ...reviewed };
        const extraSet = {};
        const extraUnset = [];
        if (Object.keys(merged).length) {
            // A changed proposal gets a new timestamp, so a review of the old version is refused.
            extraSet.pendingChanges = { ...merged, submittedAt: proposalChanged ? new Date() : previousSubmission };
        } else if (event.pendingChanges) {
            extraUnset.push('pendingChanges');
        }
        const updated = await applyEventUpdate(event, direct, extraSet, extraUnset);
        if (Object.keys(reviewed).length) notifyAdmins(req.user, event.title, 'changes');

        res.json({ ...updated.toObject(), changesAwaitingReview: Object.keys(merged) });
    } catch (error) {
        next(error);
    }
};

// GET /api/events/review (admin) — new events waiting for review and published events
// with proposed changes, oldest first.
exports.getReviewQueue = async (req, res, next) => {
    try {
        const events = await Event.find({
            $or: [{ status: 'pending_review' }, { pendingChanges: mongoose.trusted({ $exists: true }) }]
        }).populate('createdBy', 'name email').sort({ updatedAt: 1 });
        res.json(events);
    } catch (error) {
        next(error);
    }
};

// PUT /api/events/:id/review (admin) — { decision: 'approve' | 'reject', reason? }
// Reviews a waiting event, or a published event's proposed changes.
exports.reviewEvent = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const { decision } = req.body;
        if (!REVIEW_DECISIONS.includes(decision)) throw new HttpError(400, "decision must be 'approve' or 'reject'");
        const reason = optionalString(req.body.reason, 'Reason', { max: 500 });
        // Optional: the version the admin was looking at (updatedAt of a new event, or
        // pendingChanges.submittedAt of proposed changes). If the organiser has changed it
        // since, the review is refused so the admin never approves something unseen.
        const version = optionalString(req.body.version, 'version', { max: 40 });
        const versionMatches = (current) => version === undefined || (current && new Date(version).getTime() === current.getTime());

        const event = await Event.findById(eventId).populate('createdBy', 'name email');
        if (!event) return res.status(404).json({ message: 'Event not found' });
        const reviewedVersion = event.status === 'pending_review' ? event.updatedAt : event.pendingChanges?.submittedAt;
        if (!versionMatches(reviewedVersion)) {
            throw new HttpError(409, 'The organiser changed this event while you were reviewing it. Please check the latest version.');
        }

        const reviewStamp = { reviewedBy: req.user._id, reviewedAt: new Date() };
        let updated;
        let kind;

        if (event.status === 'pending_review') {
            kind = 'event';
            if (decision === 'approve' && event.date.getTime() <= Date.now()) {
                throw new HttpError(400, 'This event\'s date has passed. Ask the organiser to change it first.');
            }
            const update = decision === 'approve'
                ? { $set: { status: 'published', ...reviewStamp }, $unset: { reviewNote: '' } }
                : { $set: { status: 'rejected', ...reviewStamp, ...(reason ? { reviewNote: reason } : {}) } };
            // Only if still waiting: two admins reviewing at once cannot both win.
            updated = await Event.findOneAndUpdate({ _id: eventId, status: 'pending_review', updatedAt: event.updatedAt }, update, { new: true });
        } else if (event.pendingChanges) {
            kind = 'changes';
            const { submittedAt: _submittedAt, ...changes } = event.pendingChanges.toObject();
            if (decision === 'approve' && changes.date && new Date(changes.date).getTime() <= Date.now()) {
                throw new HttpError(400, 'The proposed new date has passed. Reject these changes and ask the organiser to resubmit.');
            }
            const update = decision === 'approve'
                ? { $set: { ...changes, ...reviewStamp }, $unset: { pendingChanges: '', reviewNote: '' } }
                : { $set: { ...reviewStamp, ...(reason ? { reviewNote: reason } : {}) }, $unset: { pendingChanges: '' } };
            // Only if the same changes are still waiting (the organiser may have edited again).
            updated = await Event.findOneAndUpdate(
                { _id: eventId, 'pendingChanges.submittedAt': event.pendingChanges.submittedAt },
                update,
                { new: true }
            );
        } else {
            throw new HttpError(400, 'Nothing to review for this event');
        }

        if (!updated) throw new HttpError(409, 'This event changed while you were reviewing it. Please refresh.');

        let emailSent = false;
        if (event.createdBy && event.createdBy.email && !ownsEvent(req.user, event)) {
            emailSent = await sendEventReviewEmail(event.createdBy.email, event.createdBy.name, updated.title, decision, kind, reason);
        }

        res.json({ message: decision === 'approve' ? 'Approved' : 'Rejected', event: updated, reviewed: kind, emailSent });
    } catch (error) {
        next(error);
    }
};

// DELETE /api/events/:id — admin or the event's organiser.
exports.deleteEvent = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const existing = await Event.findById(eventId).select('createdBy');
        if (!existing) return res.status(404).json({ message: 'Event not found' });
        if (!canManageEvent(req.user, existing)) throw new HttpError(403, 'Not authorized to delete this event');

        // Cancels the event's active bookings and deletes the event in one transaction.
        const { event, affected } = await bookingService.deleteEventWithBookings({ eventId, actorId: req.user._id });

        // Notify affected users after the commit. A failed email never undoes the deletion.
        const results = await Promise.allSettled(
            affected.map((b) => sendEventCancelledEmail(b.email, b.name, event.title))
        );
        const emailsSent = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;

        res.json({
            message: 'Event deleted successfully',
            cancelledBookings: affected.length,
            emailsSent,
            emailsFailed: affected.length - emailsSent
        });
    } catch (error) {
        next(error);
    }
};
