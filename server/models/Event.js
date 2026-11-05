const mongoose = require('mongoose');

// Statuses an event moves through when a non-admin submits it.
// Events with no status (created before this field existed) count as published.
const EVENT_STATUSES = ['pending_review', 'published', 'rejected'];
const HIDDEN_STATUSES = ['pending_review', 'rejected'];

// Edits an organiser makes to a published event that wait for admin approval.
// The live event keeps its current values (and stays bookable) until then.
const pendingChangesSchema = new mongoose.Schema({
    title: { type: String },
    description: { type: String },
    date: { type: Date },
    location: { type: String },
    ticketPrice: { type: Number, min: 0 },
    submittedAt: { type: Date }
}, { _id: false });

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
    approvalMode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    // 'published' is public and bookable. Events submitted by non-admins start as
    // 'pending_review' and are hidden until an admin approves them.
    status: { type: String, enum: EVENT_STATUSES, default: 'published' },
    reviewNote: { type: String, maxlength: 500 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    pendingChanges: { type: pendingChangesSchema, default: undefined }
}, { timestamps: true });

// Upcoming-event listings and category filters.
eventSchema.index({ date: 1 });
eventSchema.index({ category: 1 });
// Public listings by status, and an organiser's own events.
eventSchema.index({ status: 1, date: 1 });
eventSchema.index({ createdBy: 1 });

eventSchema.methods.isPublished = function isPublished() {
    return !HIDDEN_STATUSES.includes(this.status);
};

const Event = mongoose.model('Event', eventSchema);
Event.EVENT_STATUSES = EVENT_STATUSES;
Event.HIDDEN_STATUSES = HIDDEN_STATUSES;
// The fields an organiser's edit to a published event must get approved.
Event.REVIEWED_FIELDS = ['title', 'description', 'date', 'location', 'ticketPrice'];

module.exports = Event;
