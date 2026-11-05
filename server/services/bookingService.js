const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const { withTransaction } = require('../utils/transaction');
const { HttpError } = require('../utils/validation');
const { isAdmin, ownsEvent } = require('../utils/permissions');

const { ACTIVE_STATUSES } = Booking;
const PAYMENT_STATUSES = ['paid', 'not_paid'];
const EVENT_DELETED_REASON = 'Event deleted by organiser';

// Each function below changes several documents. They run inside one transaction,
// so a crash or error part-way leaves the database exactly as it was before.
// Functions return plain data; emails are sent by the caller after the commit.

// Booking closes when the event starts.
const hasEventStarted = (event) => event.date.getTime() <= Date.now();

/**
 * Creates a booking request for an event, in one transaction.
 * - 'manual' events: the booking is 'pending' and takes no seat until an admin approves.
 * - 'auto' events: the booking is 'confirmed' at once and takes a seat in the same
 *   transaction, so auto-approval can never overbook either.
 * @returns the booking (event populated) and whether it was auto-confirmed
 */
const createBooking = async ({ user, eventId }) => {
    const bookingId = await withTransaction(async (session) => {
        const event = await Event.findById(eventId).session(session);
        // Events waiting for review (or rejected) cannot be booked.
        if (!event || !event.isPublished()) throw new HttpError(404, 'Event not found');
        if (hasEventStarted(event)) throw new HttpError(400, 'This event has already started');
        if (event.availableSeats <= 0) throw new HttpError(400, 'No seats available');

        const auto = event.approvalMode === 'auto';
        if (auto) {
            const taken = await Event.findOneAndUpdate(
                { _id: eventId, availableSeats: mongoose.trusted({ $gt: 0 }) },
                { $inc: { availableSeats: -1 } },
                { new: true, session }
            );
            if (!taken) throw new HttpError(400, 'No seats available');
        }

        const now = new Date();
        const doc = {
            userId: user._id,
            eventId,
            status: auto ? 'confirmed' : 'pending',
            // A free event has nothing to pay; a paid one is settled later ("Mark as paid").
            paymentStatus: auto && event.ticketPrice === 0 ? 'paid' : 'not_paid',
            amount: event.ticketPrice,
            eventSnapshot: { title: event.title, date: event.date },
            ...(auto ? { statusChangedAt: now, statusReason: 'Auto-approved' } : {})
        };
        try {
            const [booking] = await Booking.create([doc], { session });
            return booking._id;
        } catch (error) {
            // The unique index caught a second active booking made at the same moment.
            if (error.code === 11000) throw new HttpError(400, 'Already booked or pending');
            throw error;
        }
    });

    const booking = await Booking.findById(bookingId).populate('eventId');
    return { booking, autoConfirmed: booking.status === 'confirmed' };
};

/**
 * Records payment on a confirmed booking, e.g. a paid auto-approved booking settled at the door.
 */
const setPaymentStatus = async ({ bookingId, paymentStatus }) => {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
        throw new HttpError(400, "paymentStatus must be 'paid' or 'not_paid'");
    }
    const updated = await Booking.findOneAndUpdate(
        { _id: bookingId, status: 'confirmed' },
        { paymentStatus },
        { new: true }
    ).populate('userId', 'name email').populate('eventId');
    if (!updated) {
        const exists = await Booking.exists({ _id: bookingId });
        throw exists
            ? new HttpError(400, 'Payment can only be recorded on a confirmed booking')
            : new HttpError(404, 'Booking not found');
    }
    return updated;
};

/**
 * Approves a pending booking and takes one seat.
 * @returns the confirmed booking with user (name, email) and event populated
 */
const confirmBooking = async ({ bookingId, paymentStatus, actorId }) => {
    if (paymentStatus !== undefined && !PAYMENT_STATUSES.includes(paymentStatus)) {
        throw new HttpError(400, "paymentStatus must be 'paid' or 'not_paid'");
    }

    const confirmedId = await withTransaction(async (session) => {
        const booking = await Booking.findById(bookingId).session(session);
        if (!booking) throw new HttpError(404, 'Booking not found');
        if (booking.status === 'confirmed') throw new HttpError(400, 'Booking is already confirmed');
        if (booking.status !== 'pending') throw new HttpError(400, 'Only pending bookings can be confirmed');

        // The "seats left?" check and the decrement are one operation.
        const event = await Event.findOneAndUpdate(
            { _id: booking.eventId, availableSeats: mongoose.trusted({ $gt: 0 }) },
            { $inc: { availableSeats: -1 } },
            { new: true, session }
        );
        if (!event) {
            const eventExists = await Event.exists({ _id: booking.eventId }).session(session);
            throw eventExists
                ? new HttpError(400, 'No seats available to confirm this booking')
                : new HttpError(404, 'Event not found');
        }

        const update = { status: 'confirmed', statusChangedBy: actorId, statusChangedAt: new Date() };
        if (paymentStatus) update.paymentStatus = paymentStatus;

        const confirmed = await Booking.findOneAndUpdate(
            { _id: bookingId, status: 'pending' },
            update,
            { new: true, session }
        );
        // Changed by another request since we read it: abort, which also undoes the seat decrement.
        if (!confirmed) {
            throw new HttpError(409, 'This booking was changed by another request. Please refresh and try again.');
        }
        return confirmed._id;
    });

    return Booking.findById(confirmedId).populate('userId', 'name email').populate('eventId');
};

/**
 * Cancels a pending or confirmed booking. The booking's owner, the event's organiser
 * and admins may cancel it.
 * A confirmed seat is returned to the event.
 */
const cancelBooking = async ({ bookingId, actor }) => {
    return withTransaction(async (session) => {
        const booking = await Booking.findById(bookingId).session(session);
        if (!booking) throw new HttpError(404, 'Booking not found');
        if (booking.userId.toString() !== actor.id && !isAdmin(actor)) {
            const event = await Event.findById(booking.eventId).select('createdBy').session(session);
            if (!ownsEvent(actor, event)) throw new HttpError(403, 'Not authorized');
        }
        if (!ACTIVE_STATUSES.includes(booking.status)) throw new HttpError(400, 'Already cancelled');

        const previous = await Booking.findOneAndUpdate(
            { _id: bookingId, status: mongoose.trusted({ $in: ACTIVE_STATUSES }) },
            { status: 'cancelled', statusChangedBy: actor._id, statusChangedAt: new Date() },
            { new: false, session }
        );
        if (!previous) throw new HttpError(400, 'Already cancelled');

        if (previous.status === 'confirmed') {
            // Never raise free seats above capacity.
            await Event.updateOne(
                { _id: previous.eventId, $expr: mongoose.trusted({ $lt: ['$availableSeats', '$totalSeats'] }) },
                { $inc: { availableSeats: 1 } },
                { session }
            );
        }
        return { previousStatus: previous.status };
    });
};

/**
 * Admin declines a pending booking. Stored as 'rejected' (not 'cancelled') so it can
 * be told apart from a user cancelling. No seat was taken, so none is returned.
 */
const rejectBooking = async ({ bookingId, actorId, reason }) => {
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
        throw new HttpError(400, 'Reason must be text of at most 500 characters');
    }

    const rejectedId = await withTransaction(async (session) => {
        const booking = await Booking.findById(bookingId).session(session);
        if (!booking) throw new HttpError(404, 'Booking not found');
        if (booking.status !== 'pending') throw new HttpError(400, 'Only pending bookings can be rejected');

        const update = { status: 'rejected', statusChangedBy: actorId, statusChangedAt: new Date() };
        const trimmed = typeof reason === 'string' ? reason.trim() : '';
        if (trimmed) update.statusReason = trimmed;

        const rejected = await Booking.findOneAndUpdate(
            { _id: bookingId, status: 'pending' },
            update,
            { new: true, session }
        );
        if (!rejected) {
            throw new HttpError(409, 'This booking was changed by another request. Please refresh and try again.');
        }
        return rejected._id;
    });

    return Booking.findById(rejectedId).populate('userId', 'name email').populate('eventId');
};

/**
 * Deletes an event and cancels every pending/confirmed booking for it, in one transaction.
 * Booking documents are kept (with their event snapshot) as history.
 * @returns { event, affected: [{ bookingId, email, name }] } for notification emails
 */
const deleteEventWithBookings = async ({ eventId, actorId }) => {
    return withTransaction(async (session) => {
        const event = await Event.findById(eventId).session(session);
        if (!event) throw new HttpError(404, 'Event not found');

        const active = await Booking.find({ eventId, status: mongoose.trusted({ $in: ACTIVE_STATUSES }) })
            .populate('userId', 'name email')
            .session(session);

        if (active.length) {
            await Booking.updateMany(
                { _id: mongoose.trusted({ $in: active.map((b) => b._id) }), status: mongoose.trusted({ $in: ACTIVE_STATUSES }) },
                {
                    status: 'cancelled',
                    statusChangedBy: actorId,
                    statusChangedAt: new Date(),
                    statusReason: EVENT_DELETED_REASON,
                    // Make sure older bookings without a snapshot still keep the event's name.
                    eventSnapshot: { title: event.title, date: event.date }
                },
                { session }
            );
        }

        await Event.deleteOne({ _id: eventId }, { session });

        return {
            event: { _id: event._id, title: event.title },
            affected: active
                .filter((b) => b.userId)
                .map((b) => ({ bookingId: b._id, email: b.userId.email, name: b.userId.name }))
        };
    });
};

module.exports = {
    createBooking,
    setPaymentStatus,
    confirmBooking,
    cancelBooking,
    rejectBooking,
    deleteEventWithBookings,
    PAYMENT_STATUSES,
    EVENT_DELETED_REASON
};
