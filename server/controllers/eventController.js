const mongoose = require('mongoose');
const Event = require('../models/Event');
const {
    HttpError,
    requireString,
    optionalString,
    requireObjectId,
    requireNumber,
    requireDate,
    optionalUrl,
    escapeRegex
} = require('../utils/validation');

const MAX_SEATS = 1000000;
const MAX_PRICE = 10000000;

// Builds a clean event object from the request, field by field. Fields that are not
// listed here (availableSeats, createdBy, _id, ...) can never be set by a request.
const parseEventInput = (body, { partial }) => {
    const fields = {
        title: (v) => requireString(v, 'Title', { max: 200 }),
        description: (v) => requireString(v, 'Description', { max: 5000 }),
        date: (v) => requireDate(v, 'Date'),
        location: (v) => requireString(v, 'Location', { max: 200 }),
        category: (v) => requireString(v, 'Category', { max: 50 }),
        totalSeats: (v) => requireNumber(v, 'Total seats', { min: 1, max: MAX_SEATS, integer: true }),
        ticketPrice: (v) => requireNumber(v, 'Ticket price', { min: 0, max: MAX_PRICE }),
        image: (v) => optionalUrl(v, 'Image URL') || ''
    };

    const result = {};
    for (const [field, parse] of Object.entries(fields)) {
        const value = body[field];
        const isBlank = value === undefined || value === null || value === '';
        if (isBlank && partial) continue;
        if (isBlank && field === 'ticketPrice') {
            result.ticketPrice = 0;
            continue;
        }
        if (isBlank && field === 'image') {
            result.image = '';
            continue;
        }
        result[field] = parse(value);
    }
    return result;
};

exports.getEvents = async (req, res, next) => {
    try {
        const filters = {};
        const category = optionalString(req.query.category, 'Category', { max: 50 });
        const search = optionalString(req.query.search, 'Search', { max: 100 });
        if (category) filters.category = category;
        // Escaped so user text is matched literally and cannot be a slow regular expression.
        if (search) filters.title = mongoose.trusted({ $regex: escapeRegex(search), $options: 'i' });

        // Only the organiser's name is public; their email stays private.
        const events = await Event.find(filters).populate('createdBy', 'name');
        res.json(events);
    } catch (error) {
        next(error);
    }
};

exports.getEventById = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const event = await Event.findById(eventId).populate('createdBy', 'name');
        if (!event) return res.status(404).json({ message: 'Event not found' });
        res.json(event);
    } catch (error) {
        next(error);
    }
};

exports.createEvent = async (req, res, next) => {
    try {
        const data = parseEventInput(req.body, { partial: false });
        const event = await Event.create({
            ...data,
            availableSeats: data.totalSeats,
            createdBy: req.user._id
        });
        res.status(201).json(event);
    } catch (error) {
        next(error);
    }
};

exports.updateEvent = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const updates = parseEventInput(req.body, { partial: true });

        const event = await Event.findById(eventId);
        if (!event) return res.status(404).json({ message: 'Event not found' });

        const { totalSeats, ...set } = updates;
        const update = { $set: set };
        let filter = { _id: eventId };

        // Changing capacity moves availableSeats by the same amount, so confirmed seats stay counted.
        if (totalSeats !== undefined && totalSeats !== event.totalSeats) {
            const confirmedSeats = event.totalSeats - event.availableSeats;
            if (totalSeats < confirmedSeats) {
                throw new HttpError(400, `Total seats cannot be lower than the ${confirmedSeats} seats already confirmed`);
            }
            const delta = totalSeats - event.totalSeats;
            update.$set.totalSeats = totalSeats;
            update.$inc = { availableSeats: delta };
            // Applies only if nothing changed capacity in between and the result can't go negative.
            filter = {
                _id: eventId,
                totalSeats: event.totalSeats,
                availableSeats: mongoose.trusted({ $gte: Math.max(0, -delta) })
            };
        }

        const updated = await Event.findOneAndUpdate(filter, update, { new: true, runValidators: true });
        if (!updated) {
            throw new HttpError(409, 'Seats changed while saving. Please refresh and try again.');
        }
        res.json(updated);
    } catch (error) {
        next(error);
    }
};

exports.deleteEvent = async (req, res, next) => {
    try {
        const eventId = requireObjectId(req.params.id, 'event id');
        const event = await Event.findByIdAndDelete(eventId);
        if (!event) return res.status(404).json({ message: 'Event not found' });
        res.json({ message: 'Event deleted successfully' });
    } catch (error) {
        next(error);
    }
};
