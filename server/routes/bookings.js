const express = require('express');
const router = express.Router();
const {
    bookEvent,
    confirmBooking,
    rejectBooking,
    updatePaymentStatus,
    getMyBookings,
    listBookings,
    getBookingStats,
    cancelBooking,
    sendBookingOTP
} = require('../controllers/bookingController');
const { protect } = require('../middleware/auth');
const { rateLimit, byUser } = require('../middleware/security');

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const bookingOtpLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 10, keyGenerator: byUser('booking-otp'),
    message: 'Too many OTP requests. Please try again in 15 minutes.' });
const bookingLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 20, keyGenerator: byUser('booking'),
    message: 'Too many booking attempts. Please try again in 15 minutes.' });

// Admins see everything; organisers only their own events (checked in the controller).
router.get('/', protect, listBookings);
router.get('/stats', protect, getBookingStats);
router.post('/send-otp', protect, bookingOtpLimiter, sendBookingOTP);
router.post('/', protect, bookingLimiter, bookEvent);
router.put('/:id/confirm', protect, confirmBooking);
router.put('/:id/reject', protect, rejectBooking);
router.put('/:id/payment', protect, updatePaymentStatus);
router.get('/my', protect, getMyBookings);
router.delete('/:id', protect, cancelBooking);

module.exports = router;
