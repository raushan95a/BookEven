#!/usr/bin/env node
/**
 * Creates or updates one verified account, without touching anything else in the database.
 * Use it for demo accounts on a deployed site, or to make an existing user an admin.
 *
 *   npm run create-user -- --email=demo@example.com --name="Demo User" --password=DemoPass123
 *   npm run create-user -- --email=admin@example.com --name="Demo Admin" --password=AdminPass123 --role=admin
 *   npm run create-user -- --email=you@gmail.com --role=admin        (existing account: role only)
 *
 * - New account: --email, --name and --password (8+ characters) are required; --role defaults to user.
 * - Existing account: only the options you pass are changed; it is also marked verified.
 * Connects to MONGO_URI from server/.env (or the environment).
 */
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const { requireEmail, requireString } = require('../utils/validation');

const ROLES = ['user', 'admin'];

const parseArgs = (argv) => Object.fromEntries(argv
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
        const [key, ...rest] = arg.slice(2).split('=');
        return [key, rest.join('=')];
    }));

/**
 * Creates or updates the account described by `options` and returns { user, created }.
 * Throws with a readable message on invalid input.
 */
const createOrUpdateUser = async (options) => {
    const email = requireEmail(options.email);
    const role = options.role === undefined ? undefined : options.role;
    if (role !== undefined && !ROLES.includes(role)) throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
    const name = options.name === undefined ? undefined : requireString(options.name, 'Name', { max: 100 });
    const password = options.password === undefined
        ? undefined
        : requireString(options.password, 'Password', { min: 8, max: 128, trim: false });

    const existing = await User.findOne({ email });
    if (!existing) {
        if (!name || !password) throw new Error('A new account needs --name and --password (8+ characters).');
        const user = await User.create({
            name,
            email,
            password: await bcrypt.hash(password, 10),
            role: role || 'user',
            isVerified: true
        });
        return { user, created: true };
    }

    const update = { isVerified: true };
    if (name) update.name = name;
    if (role) update.role = role;
    if (password) update.password = await bcrypt.hash(password, 10);
    const user = await User.findByIdAndUpdate(existing._id, update, { new: true });
    return { user, created: false };
};

const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    if (!options.email) {
        console.error('Usage: npm run create-user -- --email=<email> [--name="<name>"] [--password=<password>] [--role=user|admin]');
        process.exit(1);
    }
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set (server/.env).');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    try {
        const { user, created } = await createOrUpdateUser(options);
        console.log(`${created ? 'Created' : 'Updated'} ${user.role} account ${user.email} (verified) in database "${mongoose.connection.db.databaseName}".`);
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { createOrUpdateUser, parseArgs };
