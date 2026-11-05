# Setup Guide: Run and Test BookEven Locally

This guide takes you from a fresh copy of the project to a working app on your computer, then walks through testing every main feature. For a feature overview and the API reference, see [README.md](README.md).

**You need:** [Node.js](https://nodejs.org/) 18 or newer, a free MongoDB Atlas account and a Gmail account.

---

## Step 1: Create the database (MongoDB Atlas)

BookEven needs **MongoDB 6.0 or newer with transactions**. Atlas (including the free tier) qualifies; a plain local `mongod` does not, and the server refuses to start on one.

1. Sign up at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register).
2. **Create a cluster:** choose the free **M0** tier and any provider/region.
3. **Database Access:** add a database user with a username and password. Remember both.
4. **Network Access:** click **Add IP Address** and add your current IP (or `0.0.0.0/0` to allow any IP, convenient for development and hosting).
5. **Connection string:** Database → **Connect** → **Drivers**, and copy the string. It looks like:
   `mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority`
   Replace `<password>` with your password (without the `< >`), and add a database name after `.net/`, for example `.../bookeven?retryWrites=...`.

> **Tip:** use a separate database name for testing, such as `bookeven_test`. The demo-data command in Step 5 wipes the database it points at.

---

## Step 2: Create a Gmail App Password

The app emails verification codes, so it needs to send mail through Gmail. Your normal Gmail password does not work for this.

1. Open your [Google Account](https://myaccount.google.com/) → **Security**.
2. Turn on **2-Step Verification** if it is off.
3. Search for **App passwords**, create one named `BookEven` and copy the 16-letter password.

---

## Step 3: Fill in `server/.env`

Copy `server/.env.example` to `server/.env` and fill it in:

```env
MONGO_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/bookeven?retryWrites=true&w=majority

# At least 32 random characters. The server refuses short or example values. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=paste_the_generated_value_here

EMAIL_USER=yourgmail@gmail.com
EMAIL_PASS=your16letterapppassword

PORT=5000
CLIENT_ORIGIN=http://localhost:5173
```

Never commit this file.

---

## Step 4: Install

From the project root (`BookEven/`):

```bash
npm install          # root tools (starts server and client together)
npm run setup        # server and client packages
```

Both commands are needed. If you skip the first, `npm run dev` fails with `'concurrently' is not recognized`.

---

## Step 5: Add accounts (the database starts empty)

A new database has **no users and no events**, so nobody can log in yet. Choose one option:

**Option A: Demo data (quickest)**
```bash
npm run seed --prefix server
```
This **deletes all users, events and bookings** in the database, then adds 10 verified users, 6 events and sample bookings. Every demo account uses the password `password123`:

| Account | Role |
| --- | --- |
| `admin@bookeven.com` | Admin |
| `user@bookeven.com`, `alice@bookeven.com`, `bob@bookeven.com`, ... | User |

Run it once, before you create anything you want to keep.

**Option B: Your own account**
Register in the app with your real email (Step 7). New accounts are always ordinary users. To make yours an admin, open Atlas → **Browse Collections** → your database → `users`, edit your account, change `role` from `"user"` to `"admin"`, then log out and log in again.

There is no other way to become admin: the app never lets a user choose their own role.

---

## Step 6: Start the app

```bash
npm run dev
```

You should see:
```
[server] MongoDB Connected
[server] Server running on port 5000
[client] Local: http://localhost:5173/
```

Open **http://localhost:5173**. Stop both with `Ctrl+C`.

> If the client says `Local: http://localhost:5174/` instead, port 5173 is taken by another program (often an old dev server). Close it and restart, or the browser shows CORS errors on every request. See [Troubleshooting](#troubleshooting).

---

## Step 7: Test it in the browser

Use a normal window for one account and a private/incognito window for another, so you can be logged in as two people at once.

### Accounts
1. **Register** with your real email. A 6-digit code arrives by email (valid 5 minutes, 5 tries). Enter it to finish.
2. If you leave the page before entering the code, registering again says *User already exists*. Go to **Login** instead and sign in with the same email and password: the app asks for the code and emails a new one.
3. **Log in** as `admin@bookeven.com` (Option A). Admins land on the **Admin dashboard**; users land on **My Bookings**.

### Hosting an event (organiser → admin)
1. As a **user**, click **Host an Event** and submit an event with **Auto-approve** booking. It shows as *Waiting for approval* and does not appear on the home page.
2. As the **admin**, open **Event Submissions** and approve it. It now appears on the home page.
3. As the organiser, edit the event's title. The public page keeps the old title until the admin approves the change under **Event Submissions**.

### Booking
1. As a **different user** (one with a real email, since the booking code is emailed), open the event and book it. Enter the emailed code.
   - On the **auto-approve** event the booking is **confirmed at once** and the available seats drop by 1.
   - Booking the same event again is refused.
2. As the **organiser or admin**, mark that booking **Paid**.
3. As the user, **cancel** the booking from *My Bookings*. The seat is returned.

### Manual approval
1. As the **admin**, create an event with **Admin approves each request**. It is published immediately.
2. A user books it: the request is **Pending** and takes no seat yet.
3. As the admin, approve it as **Not paid**, then later **Mark as paid**. Revenue and *Paid clients* on the dashboard update. Try **Decline** with a reason on another request; the user sees the reason in *My Bookings*.

### Permissions
- An organiser sees only their own events and bookings in *My Events*.
- Only admins can open the Admin dashboard and Event Submissions.

---

## Step 8: Automated tests

```bash
npm test --prefix server
```

About 25 seconds, 107 tests. They run on a temporary in-memory database: they **never** touch the database in `.env` and never send email. A `MongoNetworkError: read ECONNRESET` line near the end is harmless shutdown noise; check the final `pass` / `fail` counts.

Client build check: `npm run build`.

---

## Step 9: Test the API with Postman (optional)

1. Open [Postman](https://www.postman.com/downloads/) → **Import** → choose `BookEven_Postman_Collection.json` from the project root.
2. Requests save tokens and IDs into collection variables as you go. A typical run:
   - **Auth:** *Login (admin)* and *Login (user)* (or *Register* → *Verify code* with your emailed code).
   - **Events:** *Submit event (organiser)* → *Review queue (admin)* → *Review event (admin)*. Or *Create event (admin)* to publish directly.
   - **Bookings (user):** *Send booking code* → *Request a seat* (with the emailed code) → *My bookings*.
   - **Bookings (admin):** *List all bookings* → *Approve booking* / *Reject booking* → *Mark as paid* → *Booking stats*.
   - *Cancel booking* and *Delete event (admin)* to clean up.

---

## Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| `'concurrently' is not recognized` | Run `npm install` in the project root (Step 4). |
| Login says **Invalid credentials** right after setup | The database is empty. Run the seed or register first (Step 5). Otherwise the email or password is wrong. |
| Register says **User already exists** | The account was created but not verified. Log in with the same email and password to get a new code. |
| Code rejected (**Invalid or expired OTP**) | Use the code from the **newest** email, within 5 minutes. Each new code replaces the old one; after 5 wrong tries, request a new one with **Resend code**. |
| Browser console: **blocked by CORS policy** from `localhost:5174` | The client started on a different port. Free port 5173 and restart, or add that URL to `CLIENT_ORIGIN` and restart the server. |
| Browser console: `ERR_CONNECTION_REFUSED` on `:5000` | The server is not running or crashed at startup. Check the `[server]` lines in the terminal. |
| `Invalid server configuration: JWT_SECRET ...` | Set a random secret of 32+ characters (Step 3). |
| `This MongoDB deployment does not support transactions` | Use Atlas or a replica set, not a standalone `mongod`. |
| `MongoDB Connection Error: bad auth` | Wrong database user or password in `MONGO_URI`. |
| `MongoDB Connection Error` with an SSL/TLS alert | Your IP is not allowed: Atlas → Network Access → Add Current IP Address. |
| `535 Username and Password not accepted` in the server log | `EMAIL_PASS` must be a Gmail App Password for `EMAIL_USER` (Step 2). |
