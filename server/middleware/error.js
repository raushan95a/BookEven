const notFound = (req, res) => {
    res.status(404).json({ message: 'Not found' });
};

// Central error handler: known errors get a clear message, everything else a generic one.
// Internal details are logged on the server and never sent to the client.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ message: 'Request body is too large' });
    }
    if (err.expose && err.status) {
        return res.status(err.status).json({ message: err.message });
    }
    if (err.name === 'CastError') {
        return res.status(400).json({ message: 'Invalid id or value' });
    }
    if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Invalid data' });
    }
    if (err.code === 11000) {
        return res.status(409).json({ message: 'Record already exists' });
    }

    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ message: 'Server Error' });
};

module.exports = { notFound, errorHandler };
