const mongoose = require('mongoose');
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

    const app = createApp(config);
    app.listen(config.port, () => console.log(`Server running on port ${config.port}`));
};

start().catch((err) => {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
});
