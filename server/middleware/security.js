// Basic security headers for a JSON API. Written by hand to avoid adding a dependency.
const securityHeaders = (isProduction) => (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    // The API only returns JSON, so nothing should ever be rendered from it.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (isProduction) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
};

/**
 * Fixed-window, in-memory rate limiter.
 * Fine for a single server process. With several instances behind a load balancer,
 * each instance counts separately; move to a shared store (e.g. Redis) at that point.
 */
const rateLimit = ({ windowMs, max, keyGenerator, message = 'Too many requests. Please try again later.', countOnlyFailures = false }) => {
    const hits = new Map();

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    sweep.unref();

    return (req, res, next) => {
        const key = keyGenerator(req);
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;

        if (entry.count > max) {
            res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
            return res.status(429).json({ message });
        }
        // countOnlyFailures: a successful request (status below 400) is not counted, so
        // logging in correctly any number of times never locks anyone out, while wrong
        // passwords still are limited.
        if (countOnlyFailures) {
            const counted = entry;
            res.on('finish', () => {
                if (res.statusCode < 400 && counted.count > 0) counted.count -= 1;
            });
        }
        next();
    };
};

const byIp = (prefix) => (req) => `${prefix}:${req.ip}`;

// Falls back to the IP when the body has no usable email.
const byEmail = (prefix) => (req) => {
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email ? `${prefix}:${email}` : `${prefix}:ip:${req.ip}`;
};

// For routes behind `protect`.
const byUser = (prefix) => (req) => `${prefix}:${req.user ? req.user.id : req.ip}`;

module.exports = { securityHeaders, rateLimit, byIp, byEmail, byUser };
