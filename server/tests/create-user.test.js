const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestServer } = require('./helpers');

let t;
let createOrUpdateUser;
let parseArgs;
before(async () => {
    t = await startTestServer();
    ({ createOrUpdateUser, parseArgs } = require('../scripts/create-user'));
});
after(async () => { await t.stop(); });

describe('create-user script', () => {
    test('parses --key=value arguments, keeping "=" inside values', () => {
        assert.deepEqual(parseArgs(['--email=a@b.com', '--password=x=y', '--role=admin', 'stray']),
            { email: 'a@b.com', password: 'x=y', role: 'admin' });
    });

    test('creates a verified user who can log in straight away; other data untouched', async () => {
        const other = await t.makeUser();
        const event = await t.makeEvent();
        const { user, created } = await createOrUpdateUser({ email: 'Demo@Example.com', name: 'Demo User', password: 'DemoPass123' });
        assert.equal(created, true);
        assert.equal(user.email, 'demo@example.com');
        assert.equal(user.role, 'user');
        assert.equal(user.isVerified, true);
        const r = await t.api('POST', '/auth/login', { body: { email: 'demo@example.com', password: 'DemoPass123' } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.ok(await t.models.User.findById(other._id));
        assert.ok(await t.models.Event.findById(event._id));
    });

    test('creates an admin with --role=admin', async () => {
        const { user } = await createOrUpdateUser({ email: 'demo-admin@example.com', name: 'Demo Admin', password: 'AdminPass123', role: 'admin' });
        assert.equal(user.role, 'admin');
        const r = await t.api('POST', '/auth/login', { body: { email: 'demo-admin@example.com', password: 'AdminPass123' } });
        assert.equal(r.data.role, 'admin');
    });

    test('promotes an existing unverified account to admin without changing its password', async () => {
        const existing = await t.makeUser({ isVerified: false });
        const { user, created } = await createOrUpdateUser({ email: existing.email, role: 'admin' });
        assert.equal(created, false);
        assert.equal(user.role, 'admin');
        assert.equal(user.isVerified, true);
        assert.equal(user.password, existing.password);
    });

    test('can reset an existing account\'s password', async () => {
        const existing = await t.makeUser();
        await createOrUpdateUser({ email: existing.email, password: 'BrandNew123' });
        const saved = await t.models.User.findById(existing._id);
        assert.ok(await bcrypt.compare('BrandNew123', saved.password));
    });

    test('rejects bad input', async () => {
        await assert.rejects(createOrUpdateUser({ email: 'new@example.com', name: 'No Password' }), /needs --name and --password/);
        await assert.rejects(createOrUpdateUser({ email: 'new@example.com', name: 'Short', password: 'short' }), /Password/);
        await assert.rejects(createOrUpdateUser({ email: 'new@example.com', name: 'X', password: 'LongEnough1', role: 'superuser' }), /--role must be/);
        await assert.rejects(createOrUpdateUser({ email: 'not-an-email', name: 'X', password: 'LongEnough1' }), /not valid/);
        assert.equal(await t.models.User.countDocuments({ email: 'new@example.com' }), 0);
    });
});
