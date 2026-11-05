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
    if (existing && !isExpired(existing) && Date.now() - existing.createdAt.getTime() < RESEND_COOLDOWN_MS) {
        return { sent: false };
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

module.exports = { issueOTP, consumeOTP, MAX_ATTEMPTS, RESEND_COOLDOWN_MS };
