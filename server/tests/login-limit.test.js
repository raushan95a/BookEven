const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

const login = (email, password) => t.api('POST', '/auth/login', { body: { email, password } });

test('correct logins never use up the per-account limit', async () => {
    const user = await t.makeUser();
    for (let i = 0; i < 15; i++) {
        const r = await login(user.email, 'Password123');
        assert.equal(r.status, 200, `login ${i + 1} should succeed`);
    }
});

test('wrong passwords are still limited, and lock the account for the window', async () => {
    const user = await t.makeUser();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await login(user.email, `wrong-${i}`)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
    assert.equal(statuses[10], 429);
    const correct = await login(user.email, 'Password123');
    assert.equal(correct.status, 429, 'locked even with the right password until the window ends');
});

test('successes between failures do not reset the failure count', async () => {
    const user = await t.makeUser();
    for (let i = 0; i < 9; i++) assert.equal((await login(user.email, 'nope')).status, 400);
    assert.equal((await login(user.email, 'Password123')).status, 200);
    assert.equal((await login(user.email, 'nope')).status, 400, '10th failure is allowed');
    assert.equal((await login(user.email, 'nope')).status, 429, '11th failure is blocked');
});
