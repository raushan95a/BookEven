const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sendOTPEmail } = require('../utils/email');
const { issueOTP, consumeOTP } = require('../utils/otp');
const { HttpError, requireString, requireEmail, requireOtp } = require('../utils/validation');

const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
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

// Login accepts any non-empty email string so existing accounts are never locked out by a stricter format rule.
const loginEmail = (value) => requireString(value, 'Email', { max: 254 });

const sendVerificationCode = async (email) => {
    const otp = await issueOTP(email, 'account_verification');
    if (otp.sent) await sendOTPEmail(email, otp.code, 'account_verification');
};

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

        await sendVerificationCode(user.email);

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
        const email = loginEmail(req.body.email);
        const password = requireString(req.body.password, 'Password', { max: 128, trim: false });

        const user = await User.findOne({ email });
        const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);
        if (!user || !isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        // Every role, admins included, must have a verified email address.
        if (!user.isVerified) {
            await sendVerificationCode(user.email);
            return res.status(403).json({ message: 'Account not verified', needsVerification: true, email: user.email });
        }

        res.json(authResponse(user));
    } catch (error) {
        next(error);
    }
};

exports.verifyOTP = async (req, res, next) => {
    try {
        const email = loginEmail(req.body.email);
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
