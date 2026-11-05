const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const bookingRoutes = require('./routes/bookings');
const { securityHeaders } = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/error');

// Defence in depth against NoSQL injection: any `$operator` object that reaches a
// query filter from user input is treated as a literal value. Operators we write
// ourselves are marked with mongoose.trusted().
mongoose.set('sanitizeFilter', true);

// Builds the Express app without connecting to the database or listening on a port,
// so tests can start it against an in-memory database.
const createApp = (config) => {
    const app = express();

    app.disable('x-powered-by');
    // Needed behind a reverse proxy (Render, Railway, Nginx) so rate limits see the real client IP.
    if (config.trustProxy) {
        const hops = Number(config.trustProxy);
        app.set('trust proxy', Number.isNaN(hops) ? config.trustProxy : hops);
    }

    // Middleware
    app.use(securityHeaders(config.isProduction));
    app.use(cors({ origin: config.clientOrigins }));
    app.use(express.json({ limit: '10kb' }));

    // Health check & root endpoints
    app.get('/', (req, res) => {
        res.json({ status: 'ok', message: 'BookEven API is running' });
    });
    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    // Routes
    app.use('/api/auth', authRoutes);
    app.use('/api/events', eventRoutes);
    app.use('/api/bookings', bookingRoutes);

    app.use('/api', notFound);
    app.use(errorHandler);

    return app;
};

module.exports = { createApp };
