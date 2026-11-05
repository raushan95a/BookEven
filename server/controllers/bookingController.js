const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const { sendBookingEmail, sendBookingRejectedEmail } = require('../utils/email');
const { consumeOTP, deliverOTP, EMAIL_FAILED_MESSAGE } = require('../utils/otp');
const { HttpError, requireObjectId, requireOtp, requireNumber, optionalString } = require('../utils/validation');
const bookingService = require('../services/bookingService');
const { isAdmin, ownsEvent } = require('../utils/permissions');

const { ACTIVE_STATUSES } = Booking;
const ALL_STATUSES = Booking.schema.path('status').enumValues;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Booking closes when the event starts.
const hasEventStarted = (event) => event.date.getTime() <= Date.now();

exports.sendBookingOTP = async (req, res, next) => {
    try {
        const delivery = await deliverOTP(req.user.email, 'event_booking');
        if (delivery.status === 'failed') return res.status(503).json({ message: EMAIL_FAILED_MESSAGE });
        if (delivery.status === 'cooldown') {
            // A code went out less than a minute ago and is still valid.
            return res.json({ message: 'An OTP was sent recently. Please check your email.', retryAfterSeconds: delivery.retryAfterSeconds });
        }
        res.json({ message: 'OTP sent successfully' });
    } catch (error) {
        next(error);
    }
};

exports.bookEvent = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.body.eventId, 'event id');
        const otp = requireOtp(req.body.otp);

        // Check the event before using up the OTP, so a failed check doesn't cost the user their code.
        const event = await Event.findById(eventId);
        // Events waiting for review (or rejected) cannot be booked.
        if (!event || !event.isPublished()) throw new HttpError(404, 'Event not found');
        if (hasEventStarted(event)) throw new HttpError(400, 'This event has already started');
        if (event.availableSeats <= 0) throw new HttpError(400, 'No seats available');

        // Look for any active booking, not just the first booking found, which might be a cancelled one.
        const existingBooking = await Booking.exists({
            userId: req.user._id,
            eventId,
            status: mongoose.trusted({ $in: ACTIVE_STATUSES })
        });
        if (existingBooking) throw new HttpError(400, 'Already booked or pending');

        // Single-use: of two parallel requests with the same code, only one gets past this line.
        const isValid = await consumeOTP(req.user.email, 'event_booking', otp);
        if (!isValid) throw new HttpError(400, 'Invalid or expired OTP for booking');

        // Pending for 'manual' events; confirmed with a seat taken for 'auto' events.
        const { booking, autoConfirmed } = await bookingService.createBooking({ user: req.user, eventId });

        if (!autoConfirmed) {
            return res.status(201).json({ message: 'Booking request submitted', booking });
        }
        const emailSent = await sendBookingEmail(req.user.email, req.user.name, booking.eventId.title);
        res.status(201).json({ message: 'Booking confirmed', booking, autoConfirmed: true, emailSent });
    } catch (error) {
        next(error);
    }
};

// Admins manage every booking; an organiser only the bookings for their own events.
const assertCanManageBooking = async (user, bookingId) => {
    if (isAdmin(user)) return;
    const booking = await Booking.findById(bookingId).select('eventId');
    if (!booking) throw new HttpError(404, 'Booking not found');
    const event = await Event.findById(booking.eventId).select('createdBy');
    if (!ownsEvent(user, event)) throw new HttpError(403, 'Not authorized to manage this booking');
};

// Limits a list/stats filter to the events the caller may manage.
const scopeToManagedEvents = async (user, filter) => {
    if (isAdmin(user)) return filter;
    const ids = await Event.find({ createdBy: user._id }).distinct('_id');
    if (filter.eventId) {
        if (!ids.some((id) => id.equals(filter.eventId))) throw new HttpError(403, 'Not authorized for this event');
        return filter;
    }
    return { ...filter, eventId: mongoose.trusted({ $in: ids }) };
};

exports.confirmBooking = async (req, res, next) => {
    try {
        const bookingId = requireObjectId(req.params.id, 'booking id');
        await assertCanManageBooking(req.user, bookingId);
        const confirmed = await bookingService.confirmBooking({
            bookingId,
            paymentStatus: req.body.paymentStatus,
            actorId: req.user._id
        });

        // Email after the transaction has committed. A failed email does not undo the approval;
        // `emailSent: false` lets the admin know to contact the user another way.
        let emailSent = false;
        if (confirmed.userId && confirmed.eventId) {
            emailSent = await sendBookingEmail(confirmed.userId.email, confirmed.userId.name, confirmed.eventId.title);
        }

        res.json({ message: 'Booking confirmed successfully', booking: confirmed, emailSent });
    } catch (error) {
        next(error);
    }
};

// PUT /api/bookings/:id/payment (admin) — record payment on a confirmed booking.
exports.updatePaymentStatus = async (req, res, next) => {
    try {
        const bookingId = requireObjectId(req.params.id, 'booking id');
        await assertCanManageBooking(req.user, bookingId);
        const booking = await bookingService.setPaymentStatus({ bookingId, paymentStatus: req.body.paymentStatus });
        res.json({ message: 'Payment status updated', booking });
    } catch (error) {
        next(error);
    }
};

exports.rejectBooking = async (req, res, next) => {
    try {
        const bookingId = requireObjectId(req.params.id, 'booking id');
        await assertCanManageBooking(req.user, bookingId);
        const rejected = await bookingService.rejectBooking({
            bookingId,
            actorId: req.user._id,
            reason: req.body.reason === '' ? undefined : req.body.reason
        });

        let emailSent = false;
        if (rejected.userId) {
            const title = rejected.eventId ? rejected.eventId.title : rejected.eventSnapshot?.title;
            emailSent = await sendBookingRejectedEmail(rejected.userId.email, rejected.userId.name, title, rejected.statusReason);
        }

        res.json({ message: 'Booking rejected', booking: rejected, emailSent });
    } catch (error) {
        next(error);
    }
};

// GET /api/bookings/my — the caller's own bookings, for every role.
// Admins list all bookings with GET /api/bookings.
exports.getMyBookings = async (req, res, next) => {
    try {
        const bookings = await Booking.find({ userId: req.user._id }).populate('eventId').sort({ createdAt: -1 });
        res.json(bookings);
    } catch (error) {
        next(error);
    }
};

// Shared filter for the admin list and stats: ?status= and ?eventId=
const adminFilter = (query) => {
    const filter = {};
    const status = optionalString(query.status, 'status', { max: 20 });
    if (status !== undefined) {
        if (!ALL_STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${ALL_STATUSES.join(', ')}`);
        filter.status = status;
    }
    const eventId = optionalString(query.eventId, 'eventId', { max: 24 });
    if (eventId !== undefined) filter.eventId = new mongoose.Types.ObjectId(requireObjectId(eventId, 'event id'));
    return filter;
};

// GET /api/bookings — admins: every booking; organisers: bookings for their own events.
// Paginated, newest first, filterable by status and event.
exports.listBookings = async (req, res, next) => {
    try {
        const filter = await scopeToManagedEvents(req.user, adminFilter(req.query));
        const page = req.query.page === undefined ? 1 : requireNumber(req.query.page, 'page', { min: 1, max: 100000, integer: true });
        const limit = req.query.limit === undefined
            ? DEFAULT_PAGE_SIZE
            : requireNumber(req.query.limit, 'limit', { min: 1, max: MAX_PAGE_SIZE, integer: true });

        const [items, total] = await Promise.all([
            Booking.find(filter)
                .sort({ createdAt: -1, _id: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('eventId')
                .populate('userId', 'name email'),
            Booking.countDocuments(filter)
        ]);

        res.json({ items, page, limit, total, totalPages: Math.ceil(total / limit) });
    } catch (error) {
        next(error);
    }
};

// GET /api/bookings/stats (admin) — the dashboard figures, computed by the database
// with the same rules the dashboard used before (confirmed + paid counts as revenue).
exports.getBookingStats = async (req, res, next) => {
    try {
        const { status, ...requested } = adminFilter(req.query);
        if (status !== undefined) throw new HttpError(400, 'status filter is not supported for stats');
        const filter = await scopeToManagedEvents(req.user, requested);

        const [result] = await Booking.aggregate([
            { $match: filter },
            {
                $facet: {
                    byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
                    paid: [
                        { $match: { status: 'confirmed', paymentStatus: 'paid' } },
                        { $group: { _id: null, revenue: { $sum: '$amount' }, clients: { $addToSet: '$userId' } } }
                    ]
                }
            }
        ]);

        const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
        for (const row of result.byStatus) counts[row._id] = row.count;
        const paid = result.paid[0];

        res.json({
            totalRevenue: paid ? paid.revenue : 0,
            paidClients: paid ? paid.clients.length : 0,
            pendingRequests: counts.pending,
            byStatus: counts,
            totalBookings: Object.values(counts).reduce((a, b) => a + b, 0)
        });
    } catch (error) {
        next(error);
    }
};

exports.cancelBooking = async (req, res, next) => {
    try {
        const bookingId = requireObjectId(req.params.id, 'booking id');
        await bookingService.cancelBooking({ bookingId, actor: req.user });
        res.json({ message: 'Booking cancelled successfully' });
    } catch (error) {
        next(error);
    }
};
