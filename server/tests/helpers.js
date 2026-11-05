/**
 * Test helpers. Every test runs against a throwaway in-memory MongoDB replica set
 * (needed for transactions). Nothing here ever connects to MONGO_URI from .env.
 */
const crypto = require('crypto');
const { once } = require('events');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');

// Safety net: refuse any URI that is not a local in-memory server.
const assertLocal = (uri) => {
    if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri)) {
        throw new Error(`Refusing to run tests against a non-local database: ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
    }
    return uri;
};

const startReplSet = async (dbName = 'bookeven_test') => {
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    return { replSet, uri: assertLocal(replSet.getUri(dbName)) };
};

const startStandalone = async (dbName = 'bookeven_test') => {
    const server = await MongoMemoryServer.create();
    return { server, uri: assertLocal(server.getUri(dbName)) };
};

/**
 * Boots the real Express app in this process against an in-memory replica set.
 * Email functions are replaced by recorders before any controller is loaded.
 */
const startTestServer = async () => {
    const { replSet, uri } = await startReplSet();
    try {
        return await bootApp(replSet, uri);
    } catch (error) {
        // Never leave a database process running if startup fails, or the test run hangs.
        await require('mongoose').disconnect().catch(() => {});
        await replSet.stop();
        throw error;
    }
};

const bootApp = async (replSet, uri) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
    process.env.NODE_ENV = 'test';

    // Recorded instead of sent. Set `emailControl.fail = true` to simulate the mail
    // server being down: the stubs then return false, exactly like the real ones.
    const emails = [];
    const emailControl = { fail: false };
    const record = (entry) => {
        const delivered = !emailControl.fail;
        emails.push({ ...entry, delivered });
        return delivered;
    };
    const email = require('../utils/email');
    email.sendOTPEmail = async (to, code, type) => record({ to, code, type });
    email.sendBookingEmail = async (to, name, title) => record({ to, type: 'confirmed', name, title });
    email.sendEventCancelledEmail = async (to, name, title) => record({ to, type: 'event_cancelled', name, title });
    email.sendBookingRejectedEmail = async (to, name, title, reason) => record({ to, type: 'rejected', name, title, reason });
    email.sendEventSubmittedEmail = async (to, organiser, title, kind) => record({ to, type: 'event_submitted', organiser, title, kind });
    email.sendEventReviewEmail = async (to, name, title, decision, kind, reason) => record({ to, type: 'event_review', name, title, decision, kind, reason });
    // Any other send* function added later is recorded too, never sent.
    const stubbed = new Set(['sendOTPEmail', 'sendBookingEmail', 'sendEventCancelledEmail', 'sendBookingRejectedEmail', 'sendEventSubmittedEmail', 'sendEventReviewEmail']);
    for (const key of Object.keys(email)) {
        if (key.startsWith('send') && !stubbed.has(key)) email[key] = async (to) => record({ to, type: key });
    }

    const mongoose = require('mongoose');
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcryptjs');
    const { createApp } = require('../app');
    const { loadConfig } = require('../utils/config');
    const User = require('../models/User');
    const Event = require('../models/Event');
    const Booking = require('../models/Booking');
    const OTP = require('../models/OTP');

    await mongoose.connect(uri);
    // Build all indexes (including the unique booking index) before tests start.
    await Promise.all([User, Event, Booking, OTP].map((Model) => Model.init()));

    const app = createApp(loadConfig({ ...process.env, CLIENT_ORIGIN: 'http://localhost:5173' }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const api = async (method, url, { token, body } = {}) => {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        let data = null;
        try { data = await res.json(); } catch { /* empty body */ }
        return { status: res.status, data, headers: res.headers };
    };

    let userCount = 0;
    const passwordHash = bcrypt.hashSync('Password123', 4);
    const makeUser = (overrides = {}) => {
        userCount += 1;
        return User.create({ name: `User ${userCount}`, email: `user${userCount}@test.com`, password: passwordHash, role: 'user', isVerified: true, ...overrides });
    };
    const makeAdmin = () => makeUser({ role: 'admin', name: 'Admin' });
    const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

    const day = 24 * 60 * 60 * 1000;
    const makeEvent = (overrides = {}) => Event.create({
        title: 'Test Event', description: 'd', date: new Date(Date.now() + 10 * day), location: 'l',
        category: 'Tech', totalSeats: 10, availableSeats: 10, ticketPrice: 100, ...overrides
    });
    const makeBooking = (user, event, overrides = {}) => Booking.create({
        userId: user._id, eventId: event._id, status: 'pending', amount: event.ticketPrice,
        eventSnapshot: { title: event.title, date: event.date }, ...overrides
    });
    const lastCode = (to, type) => [...emails].reverse().find((e) => e.to === to && e.type === type && e.delivered)?.code;

    const stop = async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await mongoose.disconnect();
        await replSet.stop();
    };

    return {
        uri, base, api, emails, emailControl, lastCode, mongoose, models: { User, Event, Booking, OTP },
        makeUser, makeAdmin, makeEvent, makeBooking, tokenFor, stop
    };
};

module.exports = { startTestServer, startReplSet, startStandalone, assertLocal };
