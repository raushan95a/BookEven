/* The original 102 Phase 1 security and booking checks, kept as a regression suite.
 * Runs the real server code against an in-memory MongoDB replica set with email stubbed.
 * Never connects to the database in .env.
 * Run through `npm test` (tests/phase1.regression.test.js) or directly:
 *   node tests/legacy/phase1-checks.js
 */
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');

const SERVER_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
const req = (p) => require(path.join(SERVER_DIR, p));
const jwt = req('node_modules/jsonwebtoken');
const bcrypt = req('node_modules/bcryptjs');

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`);
};
const section = (title) => console.log(`\n== ${title}`);

const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SECRET = crypto.randomBytes(48).toString('hex');

const api = async (method, url, { token, body, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data, headers: res.headers };
};

// Runs server.js in a child process with the given env and returns { code, output }.
const runServerProcess = (env, timeoutMs) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SERVER_DIR, 'server.js')], {
        cwd: __dirname, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 'timeout', output }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
});

(async () => {
    const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const MONGO_URI = mongod.getUri('bookeven_test');

    // ---------- A. Startup configuration ----------
    section('A. Startup configuration (S2, B12)');
    const base = { PORT: String(PORT + 500), MONGO_URI };
    const [defSecret, emptySecret, shortSecret, noDb] = await Promise.all([
        runServerProcess({ ...base, JWT_SECRET: 'supersecretjwtkey_bookeven' }, 15000),
        runServerProcess({ ...base, JWT_SECRET: '' }, 15000),
        runServerProcess({ ...base, JWT_SECRET: 'short-secret' }, 15000),
        runServerProcess({ ...base, PORT: String(PORT + 501), JWT_SECRET: SECRET, MONGO_URI: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=2000' }, 20000),
    ]);
    check('Refuses to start with the published example secret', defSecret.code === 1 && /publicly known/.test(defSecret.output), defSecret.output);
    check('Refuses to start with no secret', emptySecret.code === 1 && /not set/.test(emptySecret.output), emptySecret.output);
    check('Refuses to start with a short secret', shortSecret.code === 1 && /at least 32/.test(shortSecret.output), shortSecret.output);
    check('Exits instead of serving when MongoDB is unreachable', noDb.code === 1 && /Connection Error/.test(noDb.output), `${noDb.code} ${noDb.output}`);

    // ---------- Boot the real server in-process with email stubbed ----------
    Object.assign(process.env, { PORT: String(PORT), MONGO_URI, JWT_SECRET: SECRET, CLIENT_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' });
    const emails = [];
    const email = req('utils/email.js');
    email.sendOTPEmail = async (to, code, type) => { emails.push({ to, code, type }); return true; };
    email.sendBookingEmail = async (to, name, title) => { emails.push({ to, type: 'confirmed', name, title }); return true; };
    const lastCode = (to, type) => [...emails].reverse().find((e) => e.to === to && e.type === type)?.code;

    const mongoose = req('node_modules/mongoose');
    req('server.js');
    for (let i = 0; i < 100; i++) {
        try { await fetch(`${BASE}/events`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const User = req('models/User.js');
    const Event = req('models/Event.js');
    const Booking = req('models/Booking.js');
    const OTP = req('models/OTP.js');

    const hash = (p) => bcrypt.hashSync(p, 10);
    const admin = await User.create({ name: 'Admin', email: 'admin@test.com', password: hash('AdminPass123'), role: 'admin', isVerified: true });
    const makeUser = (n) => User.create({ name: `User ${n}`, email: `u${n}@test.com`, password: hash('UserPass123'), role: 'user', isVerified: true });
    const users = [];
    for (let i = 1; i <= 16; i++) users.push(await makeUser(i));
    const tokenFor = (u) => jwt.sign({ id: u.id, role: u.role }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const day = 24 * 3600 * 1000;
    const future = (d) => new Date(Date.now() + d * day);

    // ---------- B. Admin takeover via operator injection ----------
    section('B. NoSQL operator injection (S1)');
    let r = await api('POST', '/auth/register', { body: { name: 'Attacker', email: 'attacker@test.com', password: 'Attacker123' } });
    check('Register creates a pending OTP for the attacker', r.status === 201 && lastCode('attacker@test.com', 'account_verification'), JSON.stringify(r.data));

    r = await api('POST', '/auth/verify-otp', { body: { email: { $ne: null }, otp: { $ne: null } } });
    check('verify-otp with {$ne} email and otp is rejected, no token', r.status === 400 && !r.data?.token, JSON.stringify(r.data));
    r = await api('POST', '/auth/verify-otp', { body: { email: 'attacker@test.com', otp: { $ne: null } } });
    check('verify-otp with {$ne} otp is rejected', r.status === 400 && !r.data?.token, JSON.stringify(r.data));
    r = await api('POST', '/auth/verify-otp', { body: { email: { $regex: '.*' }, otp: '123456' } });
    check('verify-otp with {$regex} email is rejected', r.status === 400 && !r.data?.token, JSON.stringify(r.data));
    r = await api('POST', '/auth/login', { body: { email: { $ne: null }, password: 'AdminPass123' } });
    check('login with {$ne} email is rejected', r.status === 400 && !r.data?.token, JSON.stringify(r.data));
    r = await api('POST', '/auth/login', { body: { email: 'admin@test.com', password: { $ne: null } } });
    check('login with {$ne} password is rejected', r.status === 400 && !r.data?.token, JSON.stringify(r.data));

    let leaked;
    try { leaked = await User.findOne({ email: { $ne: null } }); } catch (e) { leaked = e.name; }
    check('Defence in depth: sanitizeFilter neutralises a raw {$ne} filter (no user returned)', leaked === null || leaked === 'CastError', leaked && (leaked.email || leaked));

    r = await api('POST', '/auth/verify-otp', { body: { email: 'attacker@test.com', otp: lastCode('attacker@test.com', 'account_verification') } });
    check('Legitimate OTP still verifies after injection attempts, role is user', r.status === 200 && r.data.role === 'user' && r.data.email === 'attacker@test.com', JSON.stringify(r.data));

    r = await api('POST', '/auth/register', { body: { name: 'Sneaky', email: 'sneaky@test.com', password: 'Sneaky12345', role: 'admin' } });
    r = await api('POST', '/auth/verify-otp', { body: { email: 'sneaky@test.com', otp: lastCode('sneaky@test.com', 'account_verification') } });
    check('Register ignores role: "admin" in the body', r.status === 200 && r.data.role === 'user', JSON.stringify(r.data));

    // ---------- C. Token forgery ----------
    section('C. Token forgery (S2)');
    const eventBody = { title: 'Forged', description: 'x', date: future(5).toISOString(), location: 'x', category: 'Tech', totalSeats: 10, ticketPrice: 0 };
    const forged = jwt.sign({ id: admin.id, role: 'admin' }, 'supersecretjwtkey_bookeven');
    r = await api('POST', '/events', { token: forged, body: eventBody });
    check('Admin token signed with the old public secret is rejected', r.status === 401, r.status);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id: admin.id, role: 'admin' })).toString('base64url')}.`;
    r = await api('POST', '/events', { token: none, body: eventBody });
    check('Unsigned alg:none token is rejected', r.status === 401, r.status);
    r = await api('POST', '/events', { token: jwt.sign({ id: new mongoose.Types.ObjectId().toString() }, SECRET), body: eventBody });
    check('Valid signature for a non-existent user is rejected', r.status === 401, r.status);
    r = await api('POST', '/events', { token: jwt.sign({ id: { $ne: null } }, SECRET), body: eventBody });
    check('Token whose id is an object is rejected', r.status === 401, r.status);
    r = await api('POST', '/events', { token: tokenFor(users[0]).replace(/.$/, 'x'), body: eventBody });
    check('Tampered signature is rejected', r.status === 401, r.status);
    r = await api('POST', '/events', { token: tokenFor(users[0]), body: eventBody });
    check('Regular user cannot create events (403)', r.status === 403, r.status);
    r = await api('POST', '/auth/login', { body: { email: 'admin@test.com', password: 'AdminPass123' } });
    const adminToken = r.data?.token;
    check('Admin logs in with password and gets role admin', r.status === 200 && r.data.role === 'admin' && adminToken, JSON.stringify(r.data));
    const decoded = jwt.decode(adminToken, { complete: true });
    check('Issued token uses HS256', decoded.header.alg === 'HS256', decoded.header.alg);

    // ---------- D. OTP brute force and storage ----------
    section('D. OTP brute force, storage, resend (S3, S5, S13)');
    await api('POST', '/auth/register', { body: { name: 'Brute', email: 'brute@test.com', password: 'Brute123456' } });
    const bruteCode = lastCode('brute@test.com', 'account_verification');
    const stored = await OTP.findOne({ email: 'brute@test.com' }).lean();
    check('OTP is stored hashed (64-hex HMAC, no plain code)', stored && /^[a-f0-9]{64}$/.test(stored.otpHash) && stored.otp === undefined && !JSON.stringify(stored).includes(bruteCode), JSON.stringify(stored));
    check('OTP is a 6-digit code', /^\d{6}$/.test(bruteCode), bruteCode);
    const wrong = bruteCode === '000000' ? '111111' : '000000';
    const wrongResults = [];
    for (let i = 0; i < 5; i++) wrongResults.push((await api('POST', '/auth/verify-otp', { body: { email: 'brute@test.com', otp: wrong } })).status);
    check('5 wrong guesses are rejected', wrongResults.every((s) => s === 400), wrongResults.join(','));
    r = await api('POST', '/auth/verify-otp', { body: { email: 'brute@test.com', otp: bruteCode } });
    check('Correct code no longer works after 5 wrong guesses', r.status === 400, JSON.stringify(r.data));
    const emailsBefore = emails.filter((e) => e.to === 'brute@test.com').length;
    r = await api('POST', '/auth/login', { body: { email: 'brute@test.com', password: 'Brute123456' } });
    check('Unverified login returns 403 needsVerification (existing behaviour)', r.status === 403 && r.data.needsVerification === true, JSON.stringify(r.data));
    check('Login re-sends a code once the old one is burned', emails.filter((e) => e.to === 'brute@test.com').length === emailsBefore + 1);
    await api('POST', '/auth/login', { body: { email: 'brute@test.com', password: 'Brute123456' } });
    check('Second login within 60 s does not send another email (cooldown)', emails.filter((e) => e.to === 'brute@test.com').length === emailsBefore + 1);
    r = await api('POST', '/auth/verify-otp', { body: { email: 'brute@test.com', otp: lastCode('brute@test.com', 'account_verification') } });
    check('Newest code verifies the account', r.status === 200 && r.data.token, JSON.stringify(r.data));
    r = await api('POST', '/auth/verify-otp', { body: { email: 'brute@test.com', otp: lastCode('brute@test.com', 'account_verification') } });
    check('A used code cannot be reused', r.status === 400);
    // Parallel guesses must not get more than 5 attempts
    await OTP.deleteMany({});
    const parallelCode = '424242';
    const crypto2 = require('crypto');
    await OTP.create({ email: 'u16@test.com', action: 'event_booking', otpHash: crypto2.createHmac('sha256', SECRET).update(`event_booking:u16@test.com:${parallelCode}`).digest('hex') });
    const { consumeOTP } = req('utils/otp.js');
    const par = await Promise.all(Array.from({ length: 20 }, () => consumeOTP('u16@test.com', 'event_booking', '000001')));
    const after = await OTP.findOne({ email: 'u16@test.com' });
    check('20 parallel wrong guesses: all fail and the code is burned', par.every((x) => x === false) && after === null, `${par} ${after && after.attempts}`);

    // ---------- E. Validation, events, errors, headers ----------
    section('E. Validation, event API, errors, headers');
    r = await api('POST', '/auth/register', { body: { name: 'Short', email: 'short@test.com', password: '1234567' } });
    check('Register rejects passwords under 8 chars', r.status === 400 && /at least 8/.test(r.data.message), JSON.stringify(r.data));
    r = await api('POST', '/auth/register', { body: { name: 'Bad', email: 'not-an-email', password: 'Password123' } });
    check('Register rejects invalid email', r.status === 400, JSON.stringify(r.data));
    r = await api('POST', '/auth/register', { body: { name: 'Dup', email: 'u1@test.com', password: 'Password123' } });
    check('Register on existing email: "User already exists" (unchanged)', r.status === 400 && r.data.message === 'User already exists');

    r = await api('POST', '/events', { token: adminToken, body: { ...eventBody, title: 'Rock (Live) Night', totalSeats: '50', ticketPrice: '250', image: 'https://example.com/a.jpg' } });
    const rockId = r.data?._id;
    check('Admin creates event from form-style string numbers', r.status === 201 && r.data.totalSeats === 50 && r.data.availableSeats === 50 && r.data.ticketPrice === 250 && r.data.createdBy === admin.id, JSON.stringify(r.data));
    r = await api('POST', '/events', { token: adminToken, body: { ...eventBody, ticketPrice: '' } });
    check('Blank ticket price defaults to free (0)', r.status === 201 && r.data.ticketPrice === 0, JSON.stringify(r.data));
    for (const [label, patch] of [['negative seats', { totalSeats: -5 }], ['fractional seats', { totalSeats: 2.5 }], ['title as object', { title: { $gt: '' } }], ['javascript: image URL', { image: 'javascript:alert(1)' }], ['invalid date', { date: 'not a date' }], ['missing description', { description: undefined }]]) {
        r = await api('POST', '/events', { token: adminToken, body: { ...eventBody, ...patch } });
        check(`Create event rejects ${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
    }
    r = await api('GET', '/events?search=(a%2B)%2B%24');
    check('Search with regex metacharacters is safe (200, literal match)', r.status === 200 && Array.isArray(r.data) && r.data.length === 0, JSON.stringify(r.data));
    r = await api('GET', '/events?search=(Live)');
    check('Search matches literal text with brackets', r.status === 200 && r.data.length === 1 && r.data[0].title === 'Rock (Live) Night', JSON.stringify(r.data?.map((e) => e.title)));
    r = await api('GET', '/events?search[$ne]=x');
    check('Search as an object is rejected (400)', r.status === 400, r.status);
    r = await api('GET', '/events?category=Tech');
    check('Category filter still works', r.status === 200 && r.data.length >= 1);
    r = await api('GET', '/events');
    check('Public event list hides organiser email', r.status === 200 && r.data.every((e) => !e.createdBy || e.createdBy.email === undefined), JSON.stringify(r.data[0]?.createdBy));
    r = await api('GET', '/events/abc');
    check('GET /events/abc returns 400, not 500', r.status === 400, r.status);
    r = await api('GET', `/events/${new mongoose.Types.ObjectId()}`);
    check('Unknown event id returns 404', r.status === 404, r.status);
    r = await api('PUT', `/events/${rockId}`, { token: adminToken, body: { title: 'Rock Night', availableSeats: 9999, createdBy: users[0].id } });
    check('Update event ignores availableSeats/createdBy, applies title', r.status === 200 && r.data.title === 'Rock Night' && r.data.availableSeats === 50 && r.data.createdBy === admin.id, JSON.stringify(r.data));
    r = await api('POST', '/auth/login', { raw: '{"email": "x"' });
    check('Malformed JSON returns 400', r.status === 400, r.status);
    r = await api('POST', '/auth/login', { raw: JSON.stringify({ email: 'x', password: 'a'.repeat(20000) }) });
    check('Body over 10 kB returns 413', r.status === 413, r.status);
    r = await api('GET', '/does-not-exist');
    check('Unknown API route returns JSON 404', r.status === 404 && r.data?.message === 'Not found');
    check('Security headers set, X-Powered-By removed', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY' && !r.headers.get('x-powered-by'));
    let cr = await fetch(`${BASE}/events`, { headers: { Origin: 'http://evil.example' } });
    check('CORS: unknown origin gets no Access-Control-Allow-Origin', !cr.headers.get('access-control-allow-origin'));
    cr = await fetch(`${BASE}/events`, { headers: { Origin: 'http://localhost:5173' } });
    check('CORS: the client origin is allowed', cr.headers.get('access-control-allow-origin') === 'http://localhost:5173');

    // ---------- F. Booking flow ----------
    section('F. Booking flow (B3, B4, OTP injection)');
    const ev = await Event.create({ title: 'Flow', description: 'd', date: future(10), location: 'l', category: 'c', totalSeats: 10, availableSeats: 10, ticketPrice: 100, createdBy: admin._id });
    const past = await Event.create({ title: 'Past', description: 'd', date: new Date(Date.now() - 3 * day), location: 'l', category: 'c', totalSeats: 10, availableSeats: 10, ticketPrice: 0, createdBy: admin._id });
    const today = await Event.create({ title: 'Today', description: 'd', date: new Date(new Date().toISOString().slice(0, 10)), location: 'l', category: 'c', totalSeats: 10, availableSeats: 10, ticketPrice: 0, createdBy: admin._id });
    const u1 = users[0]; const t1 = tokenFor(u1);
    const bookWithOtp = async (u, eventId) => {
        const s = await api('POST', '/bookings/send-otp', { token: tokenFor(u) });
        return api('POST', '/bookings', { token: tokenFor(u), body: { eventId: String(eventId), otp: lastCode(u.email, 'event_booking') } });
    };
    r = await api('POST', '/bookings/send-otp', { token: t1 });
    check('send-otp works (unchanged)', r.status === 200 && lastCode(u1.email, 'event_booking'), JSON.stringify(r.data));
    r = await api('POST', '/bookings', { token: t1, body: { eventId: ev.id, otp: { $ne: null } } });
    check('Booking OTP injection {$ne} rejected', r.status === 400, JSON.stringify(r.data));
    r = await api('POST', '/bookings', { token: t1, body: { eventId: { $ne: null }, otp: '123456' } });
    check('Booking with object eventId rejected', r.status === 400, JSON.stringify(r.data));
    r = await api('POST', '/bookings/send-otp', { token: t1 });
    check('Repeat send-otp within 60 s keeps the same code (cooldown, still 200)', r.status === 200 && /recently/.test(r.data.message), JSON.stringify(r.data));
    r = await api('POST', '/bookings', { token: t1, body: { eventId: ev.id, otp: lastCode(u1.email, 'event_booking') } });
    check('Booking request created as pending with ticket price', r.status === 201 && r.data.booking.status === 'pending' && r.data.booking.amount === 100, JSON.stringify(r.data));
    check('Pending booking does not take a seat (unchanged)', (await Event.findById(ev.id)).availableSeats === 10);
    r = await bookWithOtp(u1, ev.id);
    check('Second booking for same event rejected', r.status === 400 && /Already booked/.test(r.data.message), JSON.stringify(r.data));

    const u2 = users[1]; const t2 = tokenFor(u2);
    r = await bookWithOtp(u2, ev.id); const firstId = r.data.booking._id;
    r = await api('DELETE', `/bookings/${firstId}`, { token: t2 });
    check('User cancels own pending booking', r.status === 200);
    r = await bookWithOtp(u2, ev.id);
    check('User can re-book after cancelling', r.status === 201, JSON.stringify(r.data));
    r = await bookWithOtp(u2, ev.id);
    check('B3 fixed: third active booking blocked even with a cancelled one present', r.status === 400, JSON.stringify(r.data));
    check('Only one active booking exists for u2', (await Booking.countDocuments({ userId: u2._id, eventId: ev._id, status: { $in: ['pending', 'confirmed'] } }).setOptions({ sanitizeFilter: false })) === 1);
    r = await bookWithOtp(users[2], past.id);
    check('B4 fixed: booking a past event is rejected', r.status === 400 && /already started/.test(r.data.message), JSON.stringify(r.data));
    r = await bookWithOtp(users[2], today.id);
    check('[WP2 rule] Event at midnight UTC today has started, so booking is closed', r.status === 400 && /already started/.test(r.data.message), JSON.stringify(r.data));
    r = await api('DELETE', `/bookings/${firstId}`, { token: tokenFor(users[3]) });
    check("Cannot cancel another user's booking (403)", r.status === 403, r.status);
    r = await api('DELETE', '/bookings/not-an-id', { token: t1 });
    check('Cancel with invalid id returns 400', r.status === 400, r.status);
    r = await api('GET', '/bookings/my', { token: t2 });
    check('User sees only own bookings', r.status === 200 && r.data.every((b) => String(b.userId) === u2.id) && r.data.length === 2, r.data?.length);
    r = await api('GET', '/bookings', { token: adminToken });
    check('[WP3 rule] Admin sees all bookings with user name/email via GET /bookings', r.status === 200 && r.data.total === 3 && r.data.items[0].userId.email, r.data?.total);

    // ---------- G. Overbooking ----------
    section('G. Overbooking and confirmation (B1, B2)');
    const one = await Event.create({ title: 'One seat', description: 'd', date: future(3), location: 'l', category: 'c', totalSeats: 1, availableSeats: 1, ticketPrice: 500, createdBy: admin._id });
    const pend = await Promise.all(users.slice(3, 9).map((u) => Booking.create({ userId: u._id, eventId: one._id, status: 'pending', amount: 500 })));
    const confirms = await Promise.all(pend.map((b) => api('PUT', `/bookings/${b.id}/confirm`, { token: adminToken, body: { paymentStatus: 'paid' } })));
    const okCount = confirms.filter((c) => c.status === 200).length;
    const oneAfter = await Event.findById(one.id);
    check('6 parallel approvals for 1 seat: exactly 1 succeeds', okCount === 1, confirms.map((c) => c.status).join(','));
    check('availableSeats ends at 0, never negative', oneAfter.availableSeats === 0, oneAfter.availableSeats);
    check('Exactly 1 booking confirmed in DB', (await Booking.countDocuments({ eventId: one._id, status: 'confirmed' })) === 1);
    const winner = confirms.find((c) => c.status === 200);
    check('Confirm response does not leak the password hash', winner && winner.data.booking.userId.password === undefined && winner.data.booking.paymentStatus === 'paid', JSON.stringify(winner?.data.booking.userId));
    check('Confirmation email sent (stubbed)', emails.some((e) => e.type === 'confirmed' && e.title === 'One seat'));

    const three = await Event.create({ title: 'Three', description: 'd', date: future(3), location: 'l', category: 'c', totalSeats: 3, availableSeats: 3, ticketPrice: 0, createdBy: admin._id });
    const pend3 = await Promise.all(users.slice(0, 10).map((u) => Booking.create({ userId: u._id, eventId: three._id, status: 'pending', amount: 0 })));
    const c3 = await Promise.all(pend3.map((b) => api('PUT', `/bookings/${b.id}/confirm`, { token: adminToken, body: { paymentStatus: 'not_paid' } })));
    const threeAfter = await Event.findById(three.id);
    check('10 parallel approvals for 3 seats: exactly 3 succeed, seats 0', c3.filter((c) => c.status === 200).length === 3 && threeAfter.availableSeats === 0, `${c3.map((c) => c.status).join(',')} seats=${threeAfter.availableSeats}`);

    const cancelled = await Booking.create({ userId: users[10]._id, eventId: ev._id, status: 'cancelled', amount: 100 });
    r = await api('PUT', `/bookings/${cancelled.id}/confirm`, { token: adminToken, body: { paymentStatus: 'paid' } });
    check('B2 fixed: a cancelled booking cannot be confirmed', r.status === 400 && (await Event.findById(ev.id)).availableSeats === 10, JSON.stringify(r.data));
    r = await api('PUT', `/bookings/${pend[1].id}/confirm`, { token: adminToken, body: { paymentStatus: 'hacked' } });
    check('Invalid paymentStatus rejected', r.status === 400);
    r = await api('PUT', `/bookings/${pend3[0].id}/confirm`, { token: tokenFor(users[0]), body: {} });
    check('Non-admin cannot confirm (403)', r.status === 403);
    const confirmedOne = await Booking.findOne({ eventId: one._id, status: 'confirmed' });
    r = await api('PUT', `/bookings/${confirmedOne.id}/confirm`, { token: adminToken, body: {} });
    check('Confirming twice says already confirmed (unchanged)', r.status === 400 && /already confirmed/.test(r.data.message));

    const cancels = await Promise.all([1, 2, 3].map(() => api('DELETE', `/bookings/${confirmedOne.id}`, { token: adminToken })));
    const oneAfterCancel = await Event.findById(one.id);
    check('3 parallel cancels of a confirmed booking: 1 succeeds, seat returned once', cancels.filter((c) => c.status === 200).length === 1 && oneAfterCancel.availableSeats === 1, `${cancels.map((c) => c.status)} seats=${oneAfterCancel.availableSeats}`);
    r = await api('PUT', `/bookings/${pend[2].id}/confirm`, { token: adminToken, body: { paymentStatus: 'paid' } });
    check('Freed seat can be given to another pending booking', r.status === 200 && (await Event.findById(one.id)).availableSeats === 0);

    r = await api('PUT', `/events/${three.id}`, { token: adminToken, body: { totalSeats: 2 } });
    check('Cannot reduce capacity below confirmed seats', r.status === 400 && /3 seats already confirmed/.test(r.data.message), JSON.stringify(r.data));
    r = await api('PUT', `/events/${three.id}`, { token: adminToken, body: { totalSeats: 5 } });
    check('Raising capacity 3 -> 5 frees 2 seats', r.status === 200 && r.data.totalSeats === 5 && r.data.availableSeats === 2, JSON.stringify(r.data));
    r = await api('PUT', `/events/${three.id}`, { token: adminToken, body: { totalSeats: 4 } });
    check('Lowering capacity 5 -> 4 removes 1 free seat', r.status === 200 && r.data.availableSeats === 1, JSON.stringify(r.data));
    r = await api('DELETE', `/events/${past.id}`, { token: adminToken });
    check('Admin can delete an event (unchanged)', r.status === 200);

    // ---------- H. Existing end-to-end journey ----------
    section('H. End-to-end journey (register -> verify -> login -> book -> approve)');
    await api('POST', '/auth/register', { body: { name: 'New Person', email: 'new@test.com', password: 'NewPerson1' } });
    r = await api('POST', '/auth/verify-otp', { body: { email: 'new@test.com', otp: lastCode('new@test.com', 'account_verification') } });
    check('New user verifies and receives a token', r.status === 200 && r.data.token && r.data.role === 'user');
    r = await api('POST', '/auth/login', { body: { email: 'new@test.com', password: 'NewPerson1' } });
    const newToken = r.data?.token;
    check('Verified user logs in with password only', r.status === 200 && newToken);
    r = await api('POST', '/auth/login', { body: { email: 'new@test.com', password: 'wrong-password' } });
    check('Wrong password -> "Invalid credentials" (unchanged)', r.status === 400 && r.data.message === 'Invalid credentials');
    r = await api('POST', '/auth/login', { body: { email: 'nobody@test.com', password: 'whatever1' } });
    check('Unknown email -> same "Invalid credentials"', r.status === 400 && r.data.message === 'Invalid credentials');
    await api('POST', '/bookings/send-otp', { token: newToken });
    r = await api('POST', '/bookings', { token: newToken, body: { eventId: rockId, otp: lastCode('new@test.com', 'event_booking') } });
    const newBooking = r.data?.booking?._id;
    check('New user books an event', r.status === 201);
    r = await api('PUT', `/bookings/${newBooking}/confirm`, { token: adminToken, body: { paymentStatus: 'paid' } });
    check('Admin approves it as paid; seat count drops 50 -> 49', r.status === 200 && (await Event.findById(rockId)).availableSeats === 49);
    r = await api('GET', '/bookings/my', { token: newToken });
    check('User dashboard shows confirmed + paid', r.data[0].status === 'confirmed' && r.data[0].paymentStatus === 'paid');

    // ---------- I. Email escaping ----------
    section('I. Email HTML escaping (S11)');
    const { escapeHtml } = req('utils/validation.js');
    check('escapeHtml neutralises tags and quotes', escapeHtml('<a href="x">\'hi\'</a>&') === '&lt;a href=&quot;x&quot;&gt;&#39;hi&#39;&lt;/a&gt;&amp;');

    // ---------- J. Rate limiting ----------
    section('J. Rate limiting (S3)');
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await api('POST', '/auth/login', { body: { email: 'target@test.com', password: `guess${i}` } })).status);
    check('Login: 11th attempt on one account within 15 min gets 429', statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429, statuses.join(','));
    const last = await api('POST', '/auth/login', { body: { email: 'target@test.com', password: 'x' } });
    check('429 response carries Retry-After', last.status === 429 && Number(last.headers.get('retry-after')) > 0);
    const vs = [];
    for (let i = 0; i < 25; i++) vs.push((await api('POST', '/auth/verify-otp', { body: {} })).status);
    check('verify-otp: requests beyond 20 per IP get 429', vs.includes(429) && vs.at(-1) === 429, vs.join(','));
    const ss = [];
    for (let i = 0; i < 12; i++) ss.push((await api('POST', '/bookings/send-otp', { token: tokenFor(users[15]) })).status);
    check('send-otp: 11th request per user gets 429', ss.slice(0, 10).every((s) => s === 200) && ss[10] === 429, ss.join(','));
    const rs = [];
    for (let i = 0; i < 12; i++) rs.push((await api('POST', '/auth/register', { body: {} })).status);
    check('register: capped at 10 per IP per hour', rs.at(-1) === 429, rs.join(','));

    // ---------- Summary ----------
    const failed = results.filter((x) => !x.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log('FAILED:\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'));
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('Test harness error:', e); process.exit(2); });
