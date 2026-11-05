const mongoose = require('mongoose');

// Statuses that hold (or are waiting for) a seat. A user may have at most one of these per event.
const ACTIVE_STATUSES = ['pending', 'confirmed'];

const bookingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    status: { type: String, enum: ['confirmed', 'cancelled', 'pending', 'rejected'], default: 'pending' },
    paymentStatus: { type: String, enum: ['paid', 'not_paid'], default: 'not_paid' },
    amount: { type: Number, required: true },
    bookedAt: { type: Date, default: Date.now },
    // Copy of the event's title and date when booked, so history survives if the event is deleted.
    eventSnapshot: {
        title: { type: String },
        date: { type: Date }
    },
    // Who last changed the status, when, and why (e.g. a rejection reason or "Event deleted").
    statusChangedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    statusChangedAt: { type: Date },
    statusReason: { type: String, maxlength: 500 }
}, { timestamps: true });

// Database-level guarantee: one active booking per user per event. Cancelled and
// rejected bookings are outside the index, so a user can book again afterwards.
bookingSchema.index(
    { userId: 1, eventId: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ACTIVE_STATUSES } },
        name: 'one_active_booking_per_user_event'
    }
);
// Admin lists and seat reconciliation by event and status.
bookingSchema.index({ eventId: 1, status: 1 });
// A user's own bookings, newest first.
bookingSchema.index({ userId: 1, createdAt: -1 });

const Booking = mongoose.model('Booking', bookingSchema);
Booking.ACTIVE_STATUSES = ACTIVE_STATUSES;

module.exports = Booking;
