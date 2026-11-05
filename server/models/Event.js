const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    date: { type: Date, required: true },
    location: { type: String, required: true },
    category: { type: String, required: true },
    totalSeats: { type: Number, required: true, min: 0 },
    availableSeats: { type: Number, required: true, min: 0 },
    image: { type: String },
    ticketPrice: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // 'manual': an admin approves each request (the original behaviour, and the default for
    // existing events). 'auto': a request is confirmed and takes a seat immediately.
    approvalMode: { type: String, enum: ['manual', 'auto'], default: 'manual' }
}, { timestamps: true });

// Upcoming-event listings and category filters.
eventSchema.index({ date: 1 });
eventSchema.index({ category: 1 });

module.exports = mongoose.model('Event', eventSchema);
