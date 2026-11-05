const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const { sendBookingEmail, sendOTPEmail } = require('../utils/email');
const { issueOTP, consumeOTP } = require('../utils/otp');
const { HttpError, requireObjectId, requireOtp } = require('../utils/validation');

const ACTIVE_STATUSES = ['pending', 'confirmed'];
const PAYMENT_STATUSES = ['paid', 'not_paid'];

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

        const booking = await Booking.create({
            userId: req.user._id,
            eventId,
            status: 'pending',
            paymentStatus: 'not_paid',
            amount: event.ticketPrice
        });

        res.status(201).json({ message: 'Booking request submitted', booking });
    } catch (error) {
        next(error);
    }
};

exports.confirmBooking = async (req, res, next) => {
    try {
        const bookingId = requireObjectId(req.params.id, 'booking id');
        const { paymentStatus } = req.body;
        if (paymentStatus !== undefined && !PAYMENT_STATUSES.includes(paymentStatus)) {
            throw new HttpError(400, "paymentStatus must be 'paid' or 'not_paid'");
        }

        const booking = await Booking.findById(bookingId);
        if (!booking) throw new HttpError(404, 'Booking not found');
        if (booking.status === 'confirmed') throw new HttpError(400, 'Booking is already confirmed');
        if (booking.status !== 'pending') throw new HttpError(400, 'Only pending bookings can be confirmed');

        // Take a seat in one atomic step: the "seats left?" check and the decrement happen
        // together inside MongoDB, so two admins can never both take the last seat.
        const event = await Event.findOneAndUpdate(
            { _id: booking.eventId, availableSeats: mongoose.trusted({ $gt: 0 }) },
            { $inc: { availableSeats: -1 } },
            { new: true }
        );
        if (!event) {
            const eventExists = await Event.exists({ _id: booking.eventId });
            throw eventExists
                ? new HttpError(400, 'No seats available to confirm this booking')
                : new HttpError(404, 'Event not found');
        }

        const update = { status: 'confirmed' };
        if (paymentStatus) update.paymentStatus = paymentStatus;

        // Only move the booking from pending. If it changed meanwhile (cancelled or
        // confirmed by another request), give the seat back.
        const confirmed = await Booking.findOneAndUpdate(
            { _id: bookingId, status: 'pending' },
            update,
            { new: true }
        ).populate('userId', 'name email').populate('eventId');

        if (!confirmed) {
            await Event.updateOne({ _id: booking.eventId }, { $inc: { availableSeats: 1 } });
            throw new HttpError(409, 'This booking was changed by another request. Please refresh and try again.');
        }

        // Send email on admin confirmation
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

        const booking = await Booking.findById(bookingId);
        if (!booking) throw new HttpError(404, 'Booking not found');
        if (booking.userId.toString() !== req.user.id && req.user.role !== 'admin') {
            throw new HttpError(403, 'Not authorized');
        }
        if (booking.status === 'cancelled') throw new HttpError(400, 'Already cancelled');

        // Atomic status change that returns the previous state, so a seat is restored
        // at most once even if the cancel button is pressed twice.
        const previous = await Booking.findOneAndUpdate(
            { _id: bookingId, status: mongoose.trusted({ $in: ACTIVE_STATUSES }) },
            { status: 'cancelled' },
            { new: false }
        );
        if (!previous) throw new HttpError(400, 'Already cancelled');

        // Only restore the seat if it was actually confirmed and deducted, and never above the total.
        if (previous.status === 'confirmed') {
            await Event.updateOne(
                { _id: previous.eventId, $expr: mongoose.trusted({ $lt: ['$availableSeats', '$totalSeats'] }) },
                { $inc: { availableSeats: 1 } }
            );
        }

        res.json({ message: 'Booking cancelled successfully' });
    } catch (error) {
        next(error);
    }
};
