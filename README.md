# BookEven - Full-Stack Event Booking Platform

BookEven is a MERN (MongoDB, Express, React, Node.js) app for small organisers. Admins publish free or paid events, and any user can host their own events once an admin approves them; attendees verify their email, request a seat with a one-time code, and the organiser or an admin approves or declines each request. Payment happens outside the app (cash, UPI, bank transfer) and the admin records it when approving.

## Features
- **Accounts**: registration with email verification code, login with JWT (valid 7 days), bcrypt-hashed passwords. Emails are case-insensitive.
- **Email codes (OTP)**: 6-digit codes, valid 5 minutes, single use, 5 attempts per code, "Resend code" after 60 seconds.
- **Roles**:
  - **Admin**: create, edit and delete events; choose per event whether requests need approval or are **auto-approved**; approve requests as *Paid* or *Not paid*; mark confirmed bookings as paid later; decline requests with an optional reason; see revenue, paid clients and pending requests; filter and page through all bookings.
  - **User**: browse upcoming events, request a seat with an email code, see status and reasons in *My Bookings*, cancel, and request again after a decline.
  - **Organiser** (any user, for the events they create): **Host an Event** submits an event for admin review. Once approved, the organiser manages that event in *My Events*: its bookings (approve, decline, mark paid, cancel), stats, edits and deletion. Organisers never see other organisers' events or bookings.
- **Event review**:
  - A user's new event is *Waiting for approval*: hidden from the public and not bookable. Admins are emailed and review it under *Event Submissions*; the organiser is emailed the result (with the reason if rejected). Editing a rejected event sends it back for review.
  - On a published event, changes to the title, description, date, location or price wait for admin approval while the event stays live and bookable as it is. Seats, image, category and booking approval change immediately.
  - Events created by an admin are published straight away.
  - When an admin edits a field that an organiser's waiting proposal also changes, the admin's value wins and that field is dropped from the proposal, so approving the rest later does not undo the admin's edit.
- **Booking rules**:
  - Each event has a **booking approval** setting: *Admin approves each request* (default) or *Auto-approve*, where a request is confirmed and takes a seat immediately. Free auto-approved bookings count as paid; paid ones are marked paid by the admin later.
  - On approval-required events a seat is taken only when an admin approves. Neither mode can overbook, even when many people book at once.
  - One pending/confirmed booking per user per event (enforced by the database).
  - Organisers (admins included) cannot book seats at their own events.
  - Booking closes when the event starts. After that, a still-pending request can only be declined (not approved), attendees can no longer cancel (the organiser or an admin still can, to correct records), and an event that still has active bookings cannot be deleted (it is kept as a record; a past event with no active bookings can be).
  - Approve, cancel, decline and event deletion each run in a MongoDB transaction: all of it happens or none of it does.
  - Deleting an event cancels its active bookings, keeps them as history and emails the users.
- **Emails** (Nodemailer + Gmail): verification codes, booking confirmed, request declined, event cancelled. If an email cannot be sent, the API says so instead of failing silently.
- **Security**: input validation on every endpoint, protection against NoSQL injection, rate limits on login/sign-up/codes/bookings (login limits count only failed attempts, so correct logins never lock anyone out), security headers, CORS allow-list, server refuses to start with a weak or published JWT secret.

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 18 or newer.
- **MongoDB 6.0 or newer** with **transactions**: [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) (the free tier works) or a local replica set. A plain standalone `mongod`, or a version older than 6.0, is **not** supported; the server refuses to start on one.
- A Gmail account with an **App Password** for sending email (see [SETUP_GUIDE.md](SETUP_GUIDE.md)).

### 1. Server environment (`server/.env`)
Copy `server/.env.example` to `server/.env` and fill it in. The server always reads this file, whichever folder you start it from.
```env
MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/bookeven?retryWrites=true&w=majority
JWT_SECRET=paste_a_long_random_secret_here
EMAIL_USER=your_gmail_address
EMAIL_PASS=your_16_letter_gmail_app_password
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
# Optional
# JWT_EXPIRES_IN=7d
# TRUST_PROXY=1
```
| Variable | Required | Notes |
| --- | --- | --- |
| `MONGO_URI` | Yes | Atlas or a replica set (transactions are required). |
| `JWT_SECRET` | Yes | At least 32 characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Never commit it. |
| `EMAIL_USER`, `EMAIL_PASS` | Yes, for email | Gmail address and its 16-letter App Password. Without them, verification codes cannot be delivered (the server warns at startup). |
| `CLIENT_ORIGIN` | No | Frontend URL(s) allowed to call the API, comma-separated. Default `http://localhost:5173`. |
| `PORT` | No | Default `5000`. |
| `JWT_EXPIRES_IN` | No | Login lifetime, default `7d`. |
| `TRUST_PROXY` | When hosted | Set to `1` behind a proxy (Render, Railway, Nginx) so rate limits see real client IPs. |

### 2. Client environment (optional, `client/.env.local`)
Only needed when the API is not at `http://localhost:5000/api`:
```env
VITE_API_URL=https://your-api.example.com/api
```

### 3. Install and run
From the project root (one terminal):
```bash
npm install          # root tools (concurrently); needed before npm run dev
npm run install:all  # server and client packages (same as npm run setup)
npm run dev
```
- `npm run dev` starts the server (`http://localhost:5000`) and the client (`http://localhost:5173`) together.
- `npm run dev:all` installs everything and starts both.
- `npm run start` runs the server and a production preview of the client.

Or in two terminals:
```bash
cd server && npm install --legacy-peer-deps && npm run dev
cd client && npm install && npm run dev
```

### 4. Demo data (development only)
```bash
cd server
npm run seed
```
**This deletes every user, event and booking** in the database from `MONGO_URI`, then creates 10 verified users, 6 events and random bookings. All seeded accounts use the password `password123` (admin: `admin@bookeven.com`). Never run it against a database with real data. It refuses to run when `NODE_ENV=production`.

### 5. First run: accounts and admins
A new database is empty, so no one can log in until you either run the seed above or register in the app. Accounts created through **Register** are always ordinary users; the API ignores any `role` sent with the request. To make an account an admin, change its `role` from `"user"` to `"admin"` in the `users` collection (Atlas → Browse Collections), then log out and back in. Admins land on `/admin` after logging in; users land on `/dashboard`.

A step-by-step walkthrough for testing every feature in the browser is in [SETUP_GUIDE.md](SETUP_GUIDE.md#step-7-test-it-in-the-browser).

---

## Testing
```bash
cd server
npm test
```
Runs every automated test (about 25 seconds) against **in-memory MongoDB replica sets**; it never connects to the database in `.env` and never sends email. It covers:
- the original 102 security and booking checks (`tests/legacy/phase1-checks.js`),
- database integrity: duplicate prevention, transaction rollback, concurrent approvals and cancellations, event deletion (`tests/wp1.integrity.test.js`),
- the data migration script (`tests/wp1.migration.test.js`),
- every API endpoint, email failure handling, pagination, stats and a full user journey (`tests/wp2.api.test.js`),
- auto-approval: instant confirmation, last-seat races, rollback and recording payment (`tests/auto-approval.test.js`),
- hosting events: submission and review, proposed changes, and that organisers can only reach their own events and bookings (`tests/wp5.organiser.test.js`).

Build check for the client: `cd client && npm run build`.

## Database migration (for existing data)
`server/scripts/migrate-phase2.js` brings a database created by an older version up to date: lowercases emails, cancels bookings whose event no longer exists, fills in event snapshots on bookings, recomputes seat counts, marks existing events as published and creates indexes.
```bash
cd server
npm run migrate:phase2                                   # dry run: reports only, changes nothing
npm run migrate:phase2 -- --apply --db=<database name>   # apply (take a backup first)
npm run migrate:phase2 -- --rollback                     # dry run of the rollback
```
It stops without changing anything if two accounts share an email (ignoring case) or a user has two active bookings for one event; those need a manual decision first. A brand-new or empty database does not need it: the server creates its indexes on startup.

---

## API reference
Base URL: `http://localhost:5000/api`. Authenticated requests send `Authorization: Bearer <token>`. A ready-made Postman collection is in [`BookEven_Postman_Collection.json`](BookEven_Postman_Collection.json).

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/register` | Public | Create account; emails a verification code (`503` + `accountCreated` if the email fails) |
| POST | `/auth/verify-otp` | Public | Verify email with the code; returns a token |
| POST | `/auth/resend-otp` | Public | New verification code (`429` with `retryAfterSeconds` within 60 s) |
| POST | `/auth/login` | Public | Log in; `403 needsVerification` for unverified accounts |
| GET | `/events?when=upcoming\|past\|all&search=&category=` | Public | List events (`upcoming`: soonest first) |
| GET | `/events/:id` | Public | Event details (unpublished events only for their organiser and admins) |
| GET | `/events?scope=all` | Admin | Every event, including ones waiting for review or rejected |
| GET | `/events/mine` | User | Events the caller created, any status |
| POST | `/events` | User | Create event (date in the future; `approvalMode`: `manual` (default) or `auto`). Admin: published at once; others: `pending_review` |
| PUT | `/events/:id` | Admin / Organiser | Update any of: title, description, date, location, category, totalSeats, ticketPrice, image, approvalMode. Organiser edits to a published event's title, description, date, location or price go to `pendingChanges` (`changesAwaitingReview` lists them) |
| DELETE | `/events/:id` | Admin / Organiser | Delete event, cancel its active bookings, email users |
| GET | `/events/review` | Admin | Events waiting for review and events with proposed changes |
| PUT | `/events/:id/review` | Admin | `{ decision: "approve" \| "reject", reason? }` for a new event or its proposed changes; emails the organiser |
| POST | `/bookings/send-otp` | User | Email a booking code. Optional `{ eventId }`: refuses up front (no email) if that event cannot be booked by the caller, e.g. unpublished, started, full or their own |
| POST | `/bookings` | User | Request a seat: `{ eventId, otp }`. Pending, or confirmed at once (`autoConfirmed: true`) on auto-approve events |
| GET | `/bookings/my` | User | The caller's own bookings |
| DELETE | `/bookings/:id` | Owner / Organiser / Admin | Cancel; a confirmed seat is returned |
| GET | `/bookings?offset=&limit=&status=&eventId=` | Admin / Organiser | Bookings, newest first, 20 per page (max 100); `offset` = how many to skip (`page=` also accepted); `hasMore` tells whether more remain. Organisers get only their own events' bookings |
| GET | `/bookings/stats?eventId=` | Admin / Organiser | Revenue, paid clients (people who paid more than ₹0), counts by status (organisers: their events only) |
| PUT | `/bookings/:id/confirm` | Admin / Organiser | Approve: `{ paymentStatus: "paid" \| "not_paid" }` |
| PUT | `/bookings/:id/reject` | Admin / Organiser | Decline: `{ reason? }` (max 500 characters) |
| PUT | `/bookings/:id/payment` | Admin / Organiser | Record payment on a confirmed booking: `{ paymentStatus: "paid" \| "not_paid" }` |

"Organiser" means the user who created the booking's event. Booking statuses: `pending` → `confirmed` or `rejected`; `pending`/`confirmed` → `cancelled`. Event statuses: `pending_review` → `published` or `rejected`; `rejected` → `pending_review` when edited.

---

## Troubleshooting
| Message | Cause and fix |
| --- | --- |
| `Invalid server configuration: JWT_SECRET ...` | Set a random secret of 32+ characters in `server/.env`. |
| `This MongoDB deployment does not support transactions` | Use MongoDB Atlas or a replica set, not a standalone `mongod`. |
| `MongoDB Connection Error: bad auth` | Wrong database user or password in `MONGO_URI` (Atlas > Database Access). |
| `MongoDB Connection Error` with an SSL/TLS alert | Your IP is not allowed (Atlas > Network Access > Add Current IP Address). |
| `535 Username and Password not accepted` in the server log | `EMAIL_PASS` must be a Gmail App Password for the `EMAIL_USER` account, not the normal password. |
| `We could not send the email with your code right now` | Same as above, or Gmail is temporarily unavailable. The user can press **Resend code**. |
| Requests from the browser are blocked (CORS) | Add the frontend URL to `CLIENT_ORIGIN`. A common cause: port 5173 was busy, so Vite started on 5174. Free 5173 and restart `npm run dev`. |
| `'concurrently' is not recognized` | Run `npm install` in the project root before `npm run dev`. |
| `Invalid credentials` on a fresh setup | The database has no users yet. Run `npm run seed` or register first. |
| Register says `User already exists` | The account exists but is not verified. Log in with the same email and password; the app asks for a code and emails a new one. |
| `MongoNetworkError: read ECONNRESET` at the end of `npm test` | Harmless noise from the in-memory database shutting down; check the pass/fail counts. |
