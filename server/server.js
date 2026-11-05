const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Always read server/.env, whatever folder the command is started from.
// A project-root .env is still read as a fallback; values already set are never overridden.
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const { loadConfig, assertSupportedMongoVersion } = require('./utils/config');

let config;
try {
    config = loadConfig();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const { createApp } = require('./app');
const { supportsTransactions } = require('./utils/transaction');

// Connect to the database first; there is no point accepting requests without it.
const start = async () => {
    await mongoose.connect(config.mongoUri);
    console.log('MongoDB Connected');

    // Booking approval, cancellation and event deletion use transactions. A standalone
    // MongoDB cannot run them, so refuse to start rather than risk inconsistent data.
    if (!(await supportsTransactions())) {
        throw new Error('This MongoDB deployment does not support transactions. Use MongoDB Atlas or a replica set.');
    }

    const { version } = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    assertSupportedMongoVersion(version);

    const email = require('./utils/email');
    if (!email.isEmailConfigured()) {
        console.warn(email.emailProvider() === 'brevo'
            ? 'Warning: BREVO_API_KEY is set but no sender address. Set EMAIL_FROM (or EMAIL_USER) to a sender verified in Brevo.'
            : 'Warning: EMAIL_USER / EMAIL_PASS are not set. Verification codes and notifications cannot be emailed.');
    } else {
        console.log(`Email: sending through ${email.emailProvider() === 'brevo' ? 'Brevo' : 'Gmail SMTP'}`);
    }

    const app = createApp(config);
    app.listen(config.port, () => console.log(`Server running on port ${config.port}`));
};

start().catch((err) => {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
});
