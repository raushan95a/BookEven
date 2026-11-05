const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { consumeOTP, deliverOTP, EMAIL_FAILED_MESSAGE } = require('../utils/otp');
const { HttpError, requireString, requireEmail, requireLoginEmail, requireOtp } = require('../utils/validation');

const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
};

const authResponse = (user) => ({
    _id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    token: generateToken(user.id, user.role)
});

// Compared against when the email is unknown, so a missing account takes as long as a wrong password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('bookeven-timing-equaliser', 10);

const RESEND_GENERIC_MESSAGE = 'If this account still needs verification, a new code has been sent to its email.';

exports.register = async (req, res, next) => {
    try {
        const name = requireString(req.body.name, 'Name', { max: 100 });
        const email = requireEmail(req.body.email);
        const password = requireString(req.body.password, 'Password', { min: 8, max: 128, trim: false });

        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: 'User already exists' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const user = await User.create({
            name,
            email,
            password: hashedPassword,
            role: 'user', // Hardcoded to prevent frontend passing role
            isVerified: false
        });

        const delivery = await deliverOTP(user.email, 'account_verification');
        if (delivery.status === 'failed') {
            // The account exists; the user can get a code later with "resend" or by logging in.
            return res.status(503).json({
                message: 'Your account was created, but we could not send the verification email right now. Please request a new code in a few minutes.',
                accountCreated: true,
                email: user.email
            });
        }

        res.status(201).json({
            message: 'OTP sent to email. Please verify.',
            email: user.email
        });
    } catch (error) {
        next(error);
    }
};

exports.login = async (req, res, next) => {
    try {
        const email = requireLoginEmail(req.body.email);
        const password = requireString(req.body.password, 'Password', { max: 128, trim: false });

        const user = await User.findOne({ email });
        const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);
        if (!user || !isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        // Every role, admins included, must have a verified email address.
        if (!user.isVerified) {
            const delivery = await deliverOTP(user.email, 'account_verification');
            if (delivery.status === 'failed') {
                return res.status(503).json({ message: EMAIL_FAILED_MESSAGE });
            }
            // 'sent', or 'cooldown' (the code from under a minute ago is still valid).
            return res.status(403).json({ message: 'Account not verified', needsVerification: true, email: user.email });
        }

        res.json(authResponse(user));
    } catch (error) {
        next(error);
    }
};

exports.verifyOTP = async (req, res, next) => {
    try {
        const email = requireLoginEmail(req.body.email);
        const otp = requireOtp(req.body.otp);

        const isValid = await consumeOTP(email, 'account_verification', otp);
        if (!isValid) throw new HttpError(400, 'Invalid or expired OTP');

        // `email` is a validated plain string, so this matches exactly one account.
        const user = await User.findOneAndUpdate({ email }, { isVerified: true }, { new: true });
        if (!user) throw new HttpError(400, 'Invalid or expired OTP');

        res.json(authResponse(user));
    } catch (error) {
        next(error);
    }
};

// Sends a new account-verification code. The reply is the same whether or not the
// account exists or is already verified, so it can't be used to look up accounts.
exports.resendOTP = async (req, res, next) => {
    try {
        const email = requireLoginEmail(req.body.email);
        const user = await User.findOne({ email });
        if (!user || user.isVerified) return res.json({ message: RESEND_GENERIC_MESSAGE });

        const delivery = await deliverOTP(user.email, 'account_verification');
        if (delivery.status === 'cooldown') {
            res.setHeader('Retry-After', delivery.retryAfterSeconds);
            return res.status(429).json({
                message: `A code was sent recently. Please wait ${delivery.retryAfterSeconds} seconds before asking for another.`,
                retryAfterSeconds: delivery.retryAfterSeconds
            });
        }
        if (delivery.status === 'failed') return res.status(503).json({ message: EMAIL_FAILED_MESSAGE });

        res.json({ message: RESEND_GENERIC_MESSAGE });
    } catch (error) {
        next(error);
    }
};
