const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { emailProvider, isEmailConfigured, sendWithBrevo } = require('../utils/email');

// No real email is sent: Brevo calls go to a fake fetch.
const fakeFetch = (status, body) => {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, options });
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { impl, calls };
};
const mail = { to: 'someone@example.com', subject: 'Your code', html: '<p>123456</p>' };

describe('choosing the email provider', () => {
    test('Brevo when BREVO_API_KEY is set, Gmail otherwise', () => {
        assert.equal(emailProvider({ BREVO_API_KEY: 'key' }), 'brevo');
        assert.equal(emailProvider({ EMAIL_USER: 'a@gmail.com', EMAIL_PASS: 'p' }), 'gmail');
        assert.equal(emailProvider({}), 'gmail');
    });

    test('configured only with everything the provider needs', () => {
        assert.equal(isEmailConfigured({ BREVO_API_KEY: 'key', EMAIL_FROM: 'me@x.com' }), true);
        assert.equal(isEmailConfigured({ BREVO_API_KEY: 'key', EMAIL_USER: 'me@gmail.com' }), true, 'EMAIL_USER is the fallback sender');
        assert.equal(isEmailConfigured({ BREVO_API_KEY: 'key' }), false, 'Brevo needs a sender');
        assert.equal(isEmailConfigured({ EMAIL_USER: 'me@gmail.com', EMAIL_PASS: 'p' }), true);
        assert.equal(isEmailConfigured({ EMAIL_USER: 'me@gmail.com' }), false);
    });
});

describe('sending through Brevo', () => {
    test('posts the message to the Brevo API with the key and sender', async () => {
        const { impl, calls } = fakeFetch(201, { messageId: 'abc' });
        const env = { BREVO_API_KEY: 'secret-key', EMAIL_FROM: 'sender@example.com', EMAIL_FROM_NAME: 'BookEven Team' };
        await sendWithBrevo(mail, { env, fetchImpl: impl });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls[0].options.headers['api-key'], 'secret-key');
        assert.deepEqual(JSON.parse(calls[0].options.body), {
            sender: { name: 'BookEven Team', email: 'sender@example.com' },
            to: [{ email: 'someone@example.com' }],
            subject: 'Your code',
            htmlContent: '<p>123456</p>'
        });
    });

    test('sender defaults to EMAIL_USER and the name to BookEven', async () => {
        const { impl, calls } = fakeFetch(201, {});
        await sendWithBrevo(mail, { env: { BREVO_API_KEY: 'k', EMAIL_USER: 'me@gmail.com' }, fetchImpl: impl });
        assert.deepEqual(JSON.parse(calls[0].options.body).sender, { name: 'BookEven', email: 'me@gmail.com' });
    });

    test('a refusal throws with the status and Brevo\'s reason (so it is logged)', async () => {
        const { impl } = fakeFetch(401, { code: 'unauthorized', message: 'Key not found' });
        await assert.rejects(
            sendWithBrevo(mail, { env: { BREVO_API_KEY: 'bad', EMAIL_FROM: 'a@b.com' }, fetchImpl: impl }),
            (e) => e.code === 'BREVO_401' && /unauthorized: Key not found/.test(e.message)
        );
    });

    test('a refusal with a non-JSON body still throws a readable error', async () => {
        const impl = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
        await assert.rejects(
            sendWithBrevo(mail, { env: { BREVO_API_KEY: 'k', EMAIL_FROM: 'a@b.com' }, fetchImpl: impl }),
            (e) => e.code === 'BREVO_502' && /HTTP 502/.test(e.message)
        );
    });
});
