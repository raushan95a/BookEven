const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const { sendBookingEmail, sendOTPEmail } = require('../utils/email');
const { issueOTP, consumeOTP } = require('../utils/otp');
const { HttpError, requireObjectId, requireOtp } = require('../utils/validation');
const bookingService = require('../services/bookingService');

const { ACTIVE_STATUSES } = Booking;

// Events created from the admin form store a date with no time (midnight UTC), so an
// event stays bookable until the end of that day instead of from midnight.
const BOOKING_GRACE_MS = 24 * 60 * 60 * 1000;
const hasEventPassed = (event) => event.date.getTime() + BOOKING_GRACE_MS < Date.now();

exports.sendBookingOTP = async (req, res, next) => {
    try {
        const otp = await issueOTP(req.user.email, 'event_booking');
        if (!otp.sent) {
            // A code went out less than a minute ago and is still valid.
            return res.json({ message: 'An OTP was sent recently. Please check your email.' });
        }
        await sendOTPEmail(req.user.email, otp.code, 'event_booking');
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
        if (!event) throw new HttpError(404, 'Event not found');
        if (hasEventPassed(event)) throw new HttpError(400, 'This event has already taken place');
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

        let booking;
        try {
            booking = await Booking.create({
                userId: req.user._id,
                eventId,
                status: 'pending',
                paymentStatus: 'not_paid',
                amount: event.ticketPrice,
                eventSnapshot: { title: event.title, date: event.date }
            });
        } catch (error) {
            // The database's unique index caught a duplicate that slipped past the check above
            // (two requests at the same moment).
            if (error.code === 11000) throw new HttpError(400, 'Already booked or pending');
            throw error;
        }

        res.status(201).json({ message: 'Booking request submitted', booking });
    } catch (error) {
        next(error);
    }
};

exports.confirmBooking = async (req, res, next) => {
    try {
        const bookingId = requireObjectId(req.params.id, 'booking id');
        const confirmed = await bookingService.confirmBooking({
            bookingId,
            paymentStatus: req.body.paymentStatus,
            actorId: req.user._id
        });

        // Send email on admin confirmation (after the transaction has committed)
        if (confirmed.userId && confirmed.eventId) {
            await sendBookingEmail(confirmed.userId.email, confirmed.userId.name, confirmed.eventId.title);
        }

        res.json({ message: 'Booking confirmed successfully', booking: confirmed });
    } catch (error) {
        next(error);
    }
};

exports.getMyBookings = async (req, res, next) => {
    try {
        const bookings = req.user.role === 'admin'
            ? await Booking.find().populate('eventId').populate('userId', 'name email').sort({ createdAt: -1 })
            : await Booking.find({ userId: req.user._id }).populate('eventId').sort({ createdAt: -1 });
        res.json(bookings);
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
