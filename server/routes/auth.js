const express = require('express');
const router = express.Router();
const { register, login, verifyOTP, resendOTP } = require('../controllers/authController');
const { rateLimit, byIp, byEmail } = require('../middleware/security');

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const registerLimiter = rateLimit({ windowMs: ONE_HOUR, max: 10, keyGenerator: byIp('register'),
    message: 'Too many sign-up attempts. Please try again later.' });
const loginIpLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 30, keyGenerator: byIp('login'),
    message: 'Too many login attempts. Please try again in 15 minutes.' });
const loginEmailLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 10, keyGenerator: byEmail('login'),
    message: 'Too many login attempts for this account. Please try again in 15 minutes.' });
const verifyLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 20, keyGenerator: byIp('verify'),
    message: 'Too many verification attempts. Please try again in 15 minutes.' });
const resendIpLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 10, keyGenerator: byIp('resend'),
    message: 'Too many code requests. Please try again in 15 minutes.' });
const resendEmailLimiter = rateLimit({ windowMs: FIFTEEN_MINUTES, max: 5, keyGenerator: byEmail('resend'),
    message: 'Too many code requests for this account. Please try again in 15 minutes.' });

router.post('/register', registerLimiter, register);
router.post('/login', loginIpLimiter, loginEmailLimiter, login);
router.post('/verify-otp', verifyLimiter, verifyOTP);
router.post('/resend-otp', resendIpLimiter, resendEmailLimiter, resendOTP);

module.exports = router;
