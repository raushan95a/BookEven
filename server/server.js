const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();
dotenv.config({ path: path.join(__dirname, '../.env') });

const { loadConfig } = require('./utils/config');

let config;
try {
    config = loadConfig();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

// Defence in depth against NoSQL injection: any `$operator` object that reaches a
// query filter from user input is treated as a literal value. Operators we write
// ourselves are marked with mongoose.trusted().
mongoose.set('sanitizeFilter', true);

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const bookingRoutes = require('./routes/bookings');
const { securityHeaders } = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/error');

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

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingRoutes);

app.use('/api', notFound);
app.use(errorHandler);

// Connect to the database first; there is no point accepting requests without it.
const start = async () => {
    await mongoose.connect(config.mongoUri);
    console.log('MongoDB Connected');
    app.listen(config.port, () => console.log(`Server running on port ${config.port}`));
};

start().catch((err) => {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
});
