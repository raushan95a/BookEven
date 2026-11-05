const express = require('express');
const router = express.Router();
const {
    getEvents,
    getEventById,
    getMyEvents,
    createEvent,
    updateEvent,
    deleteEvent,
    getReviewQueue,
    reviewEvent
} = require('../controllers/eventController');
const { protect, optionalAuth, admin } = require('../middleware/auth');
const { rateLimit, byUser } = require('../middleware/security');

// Any signed-in user can submit events, so cap how many per hour.
const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyGenerator: byUser('event-create'),
    message: 'Too many events created. Please try again later.' });

router.get('/', optionalAuth, getEvents);
router.get('/mine', protect, getMyEvents);
router.get('/review', protect, admin, getReviewQueue);
router.get('/:id', optionalAuth, getEventById);
router.post('/', protect, createLimiter, createEvent);
router.put('/:id/review', protect, admin, reviewEvent);
// Edit and delete check "admin or the event's organiser" inside the controller.
router.put('/:id', protect, updateEvent);
router.delete('/:id', protect, deleteEvent);

module.exports = router;
