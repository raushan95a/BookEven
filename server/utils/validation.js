const mongoose = require('mongoose');

// An error whose message is safe to show to API clients.
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}

const badRequest = (message) => new HttpError(400, message);

// Request bodies are parsed as JSON, so any field may arrive as an object such as
// { "$ne": null }. Every helper below accepts only the primitive type it expects,
// which is what keeps MongoDB query operators out of our filters.

const requireString = (value, field, { min = 1, max = 200, trim = true } = {}) => {
    if (typeof value !== 'string') throw badRequest(`${field} is required`);
    const result = trim ? value.trim() : value;
    if (result.length < min) {
        throw badRequest(min <= 1 ? `${field} is required` : `${field} must be at least ${min} characters`);
    }
    if (result.length > max) throw badRequest(`${field} must be at most ${max} characters`);
    return result;
};

// Returns undefined when the value is absent or blank.
const optionalString = (value, field, options = {}) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw badRequest(`${field} must be text`);
    if (value.trim() === '') return undefined;
    return requireString(value, field, options);
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requireEmail = (value) => {
    const email = requireString(value, 'Email', { max: 254 });
    if (!EMAIL_PATTERN.test(email)) throw badRequest('Email address is not valid');
    return email;
};

const requireOtp = (value) => {
    if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) {
        throw badRequest('OTP must be a 6-digit code');
    }
    return value.trim();
};

const requireObjectId = (value, field = 'id') => {
    if (typeof value !== 'string' || !mongoose.isValidObjectId(value) || !/^[a-f\d]{24}$/i.test(value)) {
        throw badRequest(`Invalid ${field}`);
    }
    return value;
};

// Accepts numbers and numeric strings (HTML forms send strings).
const requireNumber = (value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) => {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) throw badRequest(`${field} must be a number`);
    if (integer && !Number.isInteger(number)) throw badRequest(`${field} must be a whole number`);
    if (number < min) throw badRequest(`${field} must be at least ${min}`);
    if (number > max) throw badRequest(`${field} must be at most ${max}`);
    return number;
};

const requireDate = (value, field) => {
    if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${field} is required`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw badRequest(`${field} is not a valid date`);
    return date;
};

const optionalUrl = (value, field) => {
    const url = optionalString(value, field, { max: 2048 });
    if (url === undefined) return undefined;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw badRequest(`${field} must be a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw badRequest(`${field} must start with http:// or https://`);
    }
    return url;
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

module.exports = {
    HttpError,
    badRequest,
    requireString,
    optionalString,
    requireEmail,
    requireOtp,
    requireObjectId,
    requireNumber,
    requireDate,
    optionalUrl,
    escapeRegex,
    escapeHtml,
};
