const crypto = require('crypto');
const mongoose = require('mongoose');
const OTP = require('../models/OTP');
const { normalizeEmail } = require('./validation');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

const generateCode = () => crypto.randomInt(100000, 1000000).toString();

// Codes are stored as an HMAC so a database leak does not reveal live codes.
const hashCode = (email, action, code) => crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`${action}:${email}:${code}`)
    .digest('hex');

const hashesMatch = (stored, candidate) => {
    if (typeof stored !== 'string' || stored.length !== candidate.length) return false;
    return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
};

const isExpired = (record) => Date.now() - record.createdAt.getTime() > OTP_TTL_MS;

/**
 * Creates a new code for (email, action) and returns it so the caller can email it.
 * If a code was issued less than a minute ago it is kept and nothing new is sent,
 * which stops repeated requests from flooding someone's inbox.
 */
const issueOTP = async (rawEmail, action) => {
    const email = normalizeEmail(rawEmail);
    const existing = await OTP.findOne({ email, action });
    const age = existing ? Date.now() - existing.createdAt.getTime() : Infinity;
    if (existing && !isExpired(existing) && age < RESEND_COOLDOWN_MS) {
        return { sent: false, retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - age) / 1000) };
    }

    const code = generateCode();
    await OTP.deleteMany({ email, action });
    await OTP.create({ email, action, otpHash: hashCode(email, action, code) });
    return { sent: true, code };
};

/**
 * Checks a code and, if correct, deletes it so it can be used only once.
 * Each code allows MAX_ATTEMPTS guesses in total, counted atomically so that
 * parallel requests cannot get extra guesses.
 */
const consumeOTP = async (rawEmail, action, code) => {
    const email = normalizeEmail(rawEmail);
    const record = await OTP.findOneAndUpdate(
        { email, action, attempts: mongoose.trusted({ $lt: MAX_ATTEMPTS }) },
        { $inc: { attempts: 1 } },
        { new: true }
    );
    if (!record) return false;

    // MongoDB's TTL monitor only runs about once a minute, so check expiry here too.
    if (isExpired(record)) {
        await OTP.deleteOne({ _id: record._id });
        return false;
    }

    if (!hashesMatch(record.otpHash, hashCode(email, action, code))) {
        if (record.attempts >= MAX_ATTEMPTS) await OTP.deleteOne({ _id: record._id });
        return false;
    }

    // Only the request that actually deletes the code succeeds.
    const { deletedCount } = await OTP.deleteOne({ _id: record._id });
    return deletedCount === 1;
};

// Removes the current code, e.g. when its email could not be sent, so the user can
// ask for a new one straight away instead of waiting out the resend cooldown.
const discardOTP = async (rawEmail, action) => {
    await OTP.deleteMany({ email: normalizeEmail(rawEmail), action });
};

/**
 * Issues a code and emails it.
 * @returns {{ status: 'sent' } | { status: 'cooldown', retryAfterSeconds: number } | { status: 'failed' }}
 *   'cooldown' means a code went out under a minute ago and is still valid.
 *   'failed' means the email could not be sent; the code is discarded.
 */
const deliverOTP = async (email, action) => {
    const otp = await issueOTP(email, action);
    if (!otp.sent) return { status: 'cooldown', retryAfterSeconds: otp.retryAfterSeconds };
    // Looked up at call time so the mailer can be swapped (tests stub it).
    const sent = await require('./email').sendOTPEmail(normalizeEmail(email), otp.code, action);
    if (!sent) {
        await discardOTP(email, action);
        return { status: 'failed' };
    }
    return { status: 'sent' };
};

const EMAIL_FAILED_MESSAGE = 'We could not send the email with your code right now. Please try again in a few minutes.';

module.exports = { issueOTP, consumeOTP, discardOTP, deliverOTP, EMAIL_FAILED_MESSAGE, MAX_ATTEMPTS, RESEND_COOLDOWN_MS };
