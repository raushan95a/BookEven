const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, trim: true },
    // HMAC of the code; the plain code is only ever emailed, never stored.
    otpHash: { type: String, required: true },
    action: { type: String, enum: ['account_verification', 'event_booking'], required: true },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 300 } // OTP expires in 5 minutes
});

otpSchema.index({ email: 1, action: 1 });

module.exports = mongoose.model('OTP', otpSchema);
