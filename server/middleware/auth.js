const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const protect = async (req, res, next) => {
    const header = req.headers.authorization;
    const [scheme, token] = typeof header === 'string' ? header.split(' ') : [];
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }

    let decoded;
    try {
        // Pin the algorithm so a token cannot choose a weaker one.
        decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
        return res.status(401).json({ message: 'Not authorized, token failed' });
    }

    if (!decoded || typeof decoded.id !== 'string' || !mongoose.isValidObjectId(decoded.id)) {
        return res.status(401).json({ message: 'Not authorized, token failed' });
    }

    try {
        // Role is always read from the database, never trusted from the token.
        req.user = await User.findById(decoded.id).select('-password');
    } catch (error) {
        return next(error);
    }
    if (!req.user) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
    }
    next();
};

const admin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as an admin' });
    }
};

module.exports = { protect, admin };
