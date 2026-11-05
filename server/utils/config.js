// Values that have appeared in this project's docs or examples. A secret that is
// published anywhere lets anyone sign their own admin token, so these are refused.
const KNOWN_PUBLIC_SECRETS = new Set([
    'supersecretjwtkey_bookeven',
    'secret',
    'changeme',
    'your_jwt_secret',
]);

const MIN_SECRET_LENGTH = 32;

const DEFAULT_CLIENT_ORIGIN = 'http://localhost:5173';

// Throws with a readable message when required configuration is missing or unsafe.
const loadConfig = (env = process.env) => {
    const problems = [];
    const secret = env.JWT_SECRET;

    if (!secret) {
        problems.push('JWT_SECRET is not set.');
    } else if (KNOWN_PUBLIC_SECRETS.has(secret.trim())) {
        problems.push('JWT_SECRET is a publicly known example value.');
    } else if (secret.length < MIN_SECRET_LENGTH) {
        problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
    }

    if (env.NODE_ENV === 'production' && !env.MONGO_URI) {
        problems.push('MONGO_URI must be set in production.');
    }

    if (problems.length) {
        const hint = 'Generate a secret with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
        throw new Error(`Invalid server configuration:\n  - ${problems.join('\n  - ')}\n${hint}`);
    }

    const clientOrigins = (env.CLIENT_ORIGIN || DEFAULT_CLIENT_ORIGIN)
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    return {
        port: Number(env.PORT) || 5000,
        mongoUri: env.MONGO_URI || 'mongodb://localhost:27017/bookeven',
        clientOrigins,
        trustProxy: env.TRUST_PROXY,
        isProduction: env.NODE_ENV === 'production',
    };
};

// The "one active booking per user per event" index uses $in in a partial filter,
// which MongoDB supports from 6.0. On older servers that index cannot be built.
const MIN_MONGO_MAJOR = 6;
const assertSupportedMongoVersion = (version) => {
    const major = Number.parseInt(String(version), 10);
    if (!Number.isFinite(major) || major < MIN_MONGO_MAJOR) {
        throw new Error(`MongoDB ${version} is not supported: version ${MIN_MONGO_MAJOR}.0 or newer is required (MongoDB Atlas qualifies).`);
    }
};

module.exports = { loadConfig, assertSupportedMongoVersion, KNOWN_PUBLIC_SECRETS, MIN_SECRET_LENGTH };
