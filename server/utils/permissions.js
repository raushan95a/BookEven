// Who may manage an event and its bookings: an admin, or the user who created the event.

const isAdmin = (user) => Boolean(user && user.role === 'admin');

const ownsEvent = (user, event) => {
    if (!user || !event || !event.createdBy) return false;
    const ownerId = event.createdBy._id || event.createdBy;
    return String(ownerId) === String(user._id);
};

const canManageEvent = (user, event) => isAdmin(user) || ownsEvent(user, event);

module.exports = { isAdmin, ownsEvent, canManageEvent };
