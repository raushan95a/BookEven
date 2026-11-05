const mongoose = require('mongoose');

/**
 * Runs `work(session)` inside a MongoDB transaction: either every write in it is
 * saved, or none is. If two transactions clash on the same document, MongoDB
 * reports a temporary conflict and the driver re-runs `work` from the start, so
 * `work` must only read and write through `session` and have no other side
 * effects (send emails after this returns, not inside).
 *
 * Requires a replica set (MongoDB Atlas, or a local replica set). The server
 * checks this at startup.
 */
const withTransaction = async (work) => {
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            result = await work(session);
        });
        return result;
    } finally {
        await session.endSession();
    }
};

// True when the connected deployment can run transactions (replica set or sharded cluster).
const supportsTransactions = async (connection = mongoose.connection) => {
    const hello = await connection.db.admin().command({ hello: 1 });
    return Boolean(hello.setName) || hello.msg === 'isdbgrid';
};

module.exports = { withTransaction, supportsTransactions };
