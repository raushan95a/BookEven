import React, { useState, useEffect, useContext, useCallback } from 'react';
import { AuthContext } from '../context/AuthContext';
import api from '../utils/axios';
import { useNavigate, Link } from 'react-router-dom';
import { formatDateTime, toDateTimeLocalValue, fromDateTimeLocalValue, hasStarted } from '../utils/format';
import EventSubmissions from './EventSubmissions';
import useRefreshOnFocus from '../utils/useRefreshOnFocus';

const PAGE_SIZE = 20;
const EMPTY_FORM = { title: '', description: '', date: '', location: '', category: '', totalSeats: '', ticketPrice: '', image: '', approvalMode: 'manual' };
const STATUS_OPTIONS = ['pending', 'confirmed', 'rejected', 'cancelled'];
const inputClass = 'border px-4 py-3 rounded-lg focus:ring-2 focus:ring-gray-700 outline-none transition';

// The form's values for an existing event (numbers and dates as the inputs expect them).
// Changes still waiting for review are shown in place of the live values, so the
// organiser sees what they proposed.
const eventToForm = (event) => {
    const view = { ...event, ...(event.pendingChanges || {}) };
    return {
        title: view.title,
        description: view.description,
        date: toDateTimeLocalValue(view.date),
        location: view.location,
        category: view.category,
        totalSeats: String(view.totalSeats),
        ticketPrice: String(view.ticketPrice),
        image: view.image || '',
        approvalMode: view.approvalMode || 'manual'
    };
};

const REVIEW_FIELD_NAMES = { title: 'title', description: 'description', date: 'date', location: 'location', ticketPrice: 'price' };

// Status labels shown on each event in the list.
const EventStatusBadges = ({ event }) => (
    <>
        {event.status === 'pending_review' && <span className="ml-2 align-middle px-2 py-0.5 text-[10px] font-black rounded uppercase tracking-wider bg-yellow-100 text-yellow-700">Waiting for approval</span>}
        {event.status === 'rejected' && <span className="ml-2 align-middle px-2 py-0.5 text-[10px] font-black rounded uppercase tracking-wider bg-red-100 text-red-700">Not approved</span>}
        {event.pendingChanges && <span className="ml-2 align-middle px-2 py-0.5 text-[10px] font-black rounded uppercase tracking-wider bg-purple-100 text-purple-700">Changes waiting</span>}
    </>
);

const MODE_TEXT = {
    admin: {
        title: 'Admin Dashboard',
        subtitle: 'Manage events and manually confirm bookings.',
        create: '+ Create New Event',
        submit: 'Publish Event',
        eventsHeading: 'All Events',
        loading: 'Loading admin panel...',
        noEvents: 'No events created yet.'
    },
    organiser: {
        title: 'My Events',
        subtitle: 'Host your own events. An admin reviews each new event before it is published.',
        create: '+ Host New Event',
        submit: 'Submit for Approval',
        eventsHeading: 'My Events',
        loading: 'Loading your events...',
        noEvents: 'You have not created any events yet. Use "+ Host New Event" to submit your first one.'
    }
};

/**
 * Event and booking management, shared by two pages:
 * - mode="admin": every event and booking, plus the Event Submissions review list.
 * - mode="organiser": only the events the user created and their bookings.
 * The server enforces the same limits whatever this page shows.
 */
const EventManager = ({ mode }) => {
    const isAdminMode = mode === 'admin';
    const text = MODE_TEXT[mode];
    const { user } = useContext(AuthContext);
    const navigate = useNavigate();
    const [events, setEvents] = useState([]);
    const [bookings, setBookings] = useState([]);
    const [pageInfo, setPageInfo] = useState({ loadedMore: false, hasMore: false, total: 0 });
    const [filters, setFilters] = useState({ status: '', eventId: '' });
    const [stats, setStats] = useState({ totalRevenue: 0, paidClients: 0, pendingRequests: 0 });
    const [loading, setLoading] = useState(true);
    const [listLoading, setListLoading] = useState(false);
    const [notice, setNotice] = useState(null); // { type: 'success' | 'warning' | 'error', text }

    const [showEventForm, setShowEventForm] = useState(false);
    const [editingEvent, setEditingEvent] = useState(null); // null = creating a new event
    const [formData, setFormData] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);

    const fetchEvents = useCallback(async () => {
        const { data } = isAdminMode
            ? await api.get('/events', { params: { scope: 'all' } })
            : await api.get('/events/mine');
        setEvents(data);
    }, [isAdminMode]);

    const fetchStats = useCallback(async () => {
        const { data } = await api.get('/bookings/stats');
        setStats(data);
    }, []);

    // offset = how many matching bookings are already shown (0 for a fresh list).
    const fetchBookings = useCallback(async (offset, append) => {
        setListLoading(true);
        try {
            const { data } = await api.get('/bookings', {
                params: { offset, limit: PAGE_SIZE, status: filters.status || undefined, eventId: filters.eventId || undefined }
            });
            setBookings((current) => {
                if (!append) return data.items;
                // New bookings arriving meanwhile can shift results; never show one twice.
                const seen = new Set(current.map((b) => b._id));
                return [...current, ...data.items.filter((b) => !seen.has(b._id))];
            });
            setPageInfo({ loadedMore: append || offset > 0, hasMore: data.hasMore, total: data.total });
        } finally {
            setListLoading(false);
        }
    }, [filters]);

    const allowed = Boolean(user) && (!isAdminMode || user.role === 'admin');

    useEffect(() => {
        if (!allowed) {
            navigate('/login');
            return;
        }
        Promise.all([fetchEvents(), fetchStats()])
            .catch((error) => setNotice({ type: 'error', text: error.response?.data?.message || 'Error loading admin data' }))
            .finally(() => setLoading(false));
    }, [allowed, navigate, fetchEvents, fetchStats]);

    // Reload the first page whenever a filter changes.
    useEffect(() => {
        if (!allowed) return;
        fetchBookings(0, false).catch((error) =>
            setNotice({ type: 'error', text: error.response?.data?.message || 'Error loading bookings' }));
    }, [allowed, fetchBookings]);

    // Seat counts and stats change after every booking action.
    const refreshCounts = () => Promise.all([fetchEvents(), fetchStats()]).catch(() => {});

    // Coming back to the tab shows new requests, seat counts and stats. The booking list
    // is reloaded only while on its first page, so "Load more" results are not lost.
    useRefreshOnFocus(() => {
        if (!allowed) return undefined;
        return Promise.all([refreshCounts(), pageInfo.loadedMore ? null : fetchBookings(0, false)]);
    });

    const replaceBooking = (updated) => {
        setBookings((current) => current.map((b) => (b._id === updated._id ? updated : b)));
    };

    const openCreateForm = () => {
        setEditingEvent(null);
        setFormData(EMPTY_FORM);
        setShowEventForm(true);
    };

    const openEditForm = (event) => {
        setEditingEvent(event);
        setFormData(eventToForm(event));
        setShowEventForm(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const closeForm = () => {
        setShowEventForm(false);
        setEditingEvent(null);
        setFormData(EMPTY_FORM);
    };

    const handleSubmitEvent = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            if (editingEvent) {
                // Send only the fields that changed, so an untouched date is never re-validated.
                const original = eventToForm(editingEvent);
                const changes = {};
                for (const key of Object.keys(formData)) {
                    if (formData[key] !== original[key]) {
                        changes[key] = key === 'date' ? fromDateTimeLocalValue(formData.date) : formData[key];
                    }
                }
                let saved = null;
                if (Object.keys(changes).length) saved = (await api.put(`/events/${editingEvent._id}`, changes)).data;
                const waiting = saved?.changesAwaitingReview || [];
                if (waiting.length) {
                    const names = waiting.map((f) => REVIEW_FIELD_NAMES[f] || f).join(', ');
                    setNotice({ type: 'success', text: `Changes to the ${names} were sent to an admin for approval; the event stays as it is until then. Any other changes are saved.` });
                } else if (editingEvent.status === 'rejected' && saved?.status === 'pending_review') {
                    setNotice({ type: 'success', text: `"${formData.title}" updated and sent for review again.` });
                } else {
                    setNotice({ type: 'success', text: `"${formData.title}" updated.` });
                }
            } else {
                const { data } = await api.post('/events', { ...formData, date: fromDateTimeLocalValue(formData.date) });
                setNotice(data.status === 'pending_review'
                    ? { type: 'success', text: `"${formData.title}" submitted. An admin will review it; you will get an email when it is approved.` }
                    : { type: 'success', text: `"${formData.title}" published.` });
            }
            closeForm();
            await refreshCounts();
        } catch (error) {
            alert(error.response?.data?.message || (editingEvent ? 'Error updating event' : 'Error creating event'));
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteEvent = async (event) => {
        const message = `Delete "${event.title}"?\n\nAny pending or confirmed bookings for it will be cancelled and those users will be emailed. This cannot be undone.`;
        if (!window.confirm(message)) return;
        try {
            const { data } = await api.delete(`/events/${event._id}`);
            let text = `"${event.title}" deleted.`;
            if (data.cancelledBookings) text += ` ${data.cancelledBookings} booking(s) cancelled.`;
            if (data.emailsFailed) text += ` ${data.emailsFailed} notification email(s) could not be sent; please contact those users directly.`;
            setNotice({ type: data.emailsFailed ? 'warning' : 'success', text });
            if (filters.eventId === event._id) {
                // Clearing the filter reloads the list by itself.
                setFilters((f) => ({ ...f, eventId: '' }));
                await refreshCounts();
            } else {
                await Promise.all([refreshCounts(), fetchBookings(0, false)]);
            }
        } catch (error) {
            alert(error.response?.data?.message || 'Error deleting event');
        }
    };

    const handleConfirmBooking = async (booking, paymentStatus) => {
        try {
            const { data } = await api.put(`/bookings/${booking._id}/confirm`, { paymentStatus });
            replaceBooking(data.booking);
            if (!data.emailSent) {
                setNotice({ type: 'warning', text: `Booking approved, but the confirmation email to ${booking.userId?.email} could not be sent.` });
            }
            await refreshCounts();
        } catch (error) {
            alert(error.response?.data?.message || 'Error confirming booking');
        }
    };

    const handleMarkPaid = async (booking) => {
        try {
            const { data } = await api.put(`/bookings/${booking._id}/payment`, { paymentStatus: 'paid' });
            replaceBooking(data.booking);
            await refreshCounts();
        } catch (error) {
            alert(error.response?.data?.message || 'Error updating payment');
        }
    };

    const handleRejectBooking = async (booking) => {
        const reason = window.prompt(`Decline ${booking.userId?.name || 'this user'}'s request?\n\nReason (optional, shown to the user):`, '');
        if (reason === null) return; // dialog cancelled
        try {
            const { data } = await api.put(`/bookings/${booking._id}/reject`, { reason: reason.trim() });
            replaceBooking(data.booking);
            if (!data.emailSent) {
                setNotice({ type: 'warning', text: `Request declined, but the email to ${booking.userId?.email} could not be sent.` });
            }
            await refreshCounts();
        } catch (error) {
            alert(error.response?.data?.message || 'Error declining booking');
        }
    };

    if (!allowed) return null;
    if (loading) return <div className="text-center py-20 text-xl font-semibold">{text.loading}</div>;

    const eventsById = Object.fromEntries(events.map((e) => [e._id, e]));
    const noticeStyles = {
        success: 'bg-green-50 text-green-800 border-green-200',
        warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
        error: 'bg-red-50 text-red-700 border-red-200'
    };

    return (
        <div className="max-w-7xl mx-auto">
            <div className="bg-black text-white rounded-2xl p-6 sm:p-8 mb-8 shadow-lg flex flex-col md:flex-row justify-between items-center gap-6 text-center md:text-left">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold mb-2">{text.title}</h1>
                    <p className="text-gray-300">{text.subtitle}</p>
                </div>
                <button
                    onClick={() => (showEventForm ? closeForm() : openCreateForm())}
                    className="w-full md:w-auto bg-white text-black font-bold py-3 px-6 rounded-lg hover:bg-gray-100 transition shadow-md"
                >
                    {showEventForm ? (editingEvent ? 'Cancel Editing' : 'Cancel Creation') : text.create}
                </button>
            </div>

            {notice && (
                <div role="status" className={`mb-8 p-4 rounded-xl border flex justify-between items-start gap-4 ${noticeStyles[notice.type]}`}>
                    <p className="font-medium">{notice.text}</p>
                    <button onClick={() => setNotice(null)} aria-label="Dismiss message" className="font-bold shrink-0">✕</button>
                </div>
            )}

            {isAdminMode && <EventSubmissions onNotice={setNotice} onReviewed={refreshCounts} />}

            {/* Stats Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                    <div>
                        <p className="text-gray-500 text-sm font-bold uppercase tracking-wider mb-1">Total Revenue</p>
                        <h3 className="text-3xl font-black text-green-600">₹{stats.totalRevenue}</h3>
                    </div>
                    <div aria-hidden="true" className="w-12 h-12 bg-green-100 text-green-500 rounded-full flex items-center justify-center text-xl font-bold">₹</div>
                </div>
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                    <div>
                        <p className="text-gray-500 text-sm font-bold uppercase tracking-wider mb-1">Paid Clients</p>
                        <h3 className="text-3xl font-black text-blue-600">{stats.paidClients}</h3>
                    </div>
                    <div aria-hidden="true" className="w-12 h-12 bg-blue-100 text-blue-500 rounded-full flex items-center justify-center text-xl font-bold">👤</div>
                </div>
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                    <div>
                        <p className="text-gray-500 text-sm font-bold uppercase tracking-wider mb-1">Pending Requests</p>
                        <h3 className="text-3xl font-black text-yellow-600">{stats.pendingRequests}</h3>
                    </div>
                    <div aria-hidden="true" className="w-12 h-12 bg-yellow-100 text-yellow-600 rounded-full flex items-center justify-center text-xl font-bold">⏳</div>
                </div>
            </div>

            {showEventForm && (
                <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 mb-8 animation-slideDown">
                    <h2 className="text-2xl font-bold mb-2 text-gray-800">{editingEvent ? `Edit "${editingEvent.title}"` : (isAdminMode ? 'Create New Event' : 'Host New Event')}</h2>
                    {isAdminMode ? <div className="mb-6" /> : (
                        <p className="text-sm text-gray-500 mb-6">
                            {!editingEvent && 'Your event will be reviewed by an admin before it appears on BookEven.'}
                            {editingEvent?.status === 'published' && 'Changes to the title, description, date, location or price are reviewed by an admin first; the event stays as it is until then. Seats, image, category and booking approval change immediately.'}
                            {editingEvent?.status === 'rejected' && 'Saving will send this event for review again.'}
                            {editingEvent?.status === 'pending_review' && 'This event is waiting for approval; your changes will be part of that review.'}
                        </p>
                    )}
                    <form onSubmit={handleSubmitEvent} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <input required type="text" aria-label="Event title" placeholder="Event Title" maxLength={200} className={inputClass} value={formData.title} onChange={e => setFormData({ ...formData, title: e.target.value })} />
                        <input required type="text" aria-label="Category" placeholder="Category (e.g., Tech, Music)" maxLength={50} className={inputClass} value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })} />
                        <input required type="datetime-local" aria-label="Event date and start time" min={editingEvent ? undefined : toDateTimeLocalValue(Date.now())} className={inputClass} value={formData.date} onChange={e => setFormData({ ...formData, date: e.target.value })} />
                        <input required type="text" aria-label="Location" placeholder="Location" maxLength={200} className={inputClass} value={formData.location} onChange={e => setFormData({ ...formData, location: e.target.value })} />
                        <input required type="number" min="1" step="1" aria-label="Total seats" placeholder="Total Seats" className={inputClass} value={formData.totalSeats} onChange={e => setFormData({ ...formData, totalSeats: e.target.value })} />
                        <input required type="number" min="0" step="any" aria-label="Ticket price" placeholder="Ticket Price (0 for free)" className={inputClass} value={formData.ticketPrice} onChange={e => setFormData({ ...formData, ticketPrice: e.target.value })} />

                        <div className="md:col-span-2">
                            <label htmlFor="approval-mode" className="block text-sm font-semibold text-gray-700 mb-2">Booking approval</label>
                            <select id="approval-mode" className={`w-full bg-white ${inputClass}`} value={formData.approvalMode} onChange={e => setFormData({ ...formData, approvalMode: e.target.value })}>
                                <option value="manual">Admin approves each request</option>
                                <option value="auto">Auto-approve (confirmed instantly while seats last)</option>
                            </select>
                            <p className="text-xs text-gray-500 mt-1">
                                {formData.approvalMode === 'auto'
                                    ? 'Bookings are confirmed and take a seat immediately. For paid events, record payment later with "Mark as paid".'
                                    : 'Each request waits in Booking Requests until it is approved or rejected.'}
                            </p>
                        </div>

                        <div className="md:col-span-2">
                            <input type="url" aria-label="Image URL" placeholder="Image URL (Provide any direct link to an image)" className={`w-full ${inputClass}`} value={formData.image} onChange={e => setFormData({ ...formData, image: e.target.value })} />
                        </div>

                        <textarea required aria-label="Event description" placeholder="Event Description" maxLength={5000} className={`${inputClass} md:col-span-2 h-32`} value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} />
                        <button type="submit" disabled={saving} className="md:col-span-2 bg-gray-900 text-white font-bold py-3 mt-2 rounded-lg hover:bg-black transition shadow-md">
                            {saving ? 'Saving...' : (editingEvent ? 'Save Changes' : text.submit)}
                        </button>
                    </form>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Events Section */}
                <div className="flex flex-col">
                    <h2 className="text-2xl font-bold mb-6 text-gray-800 flex items-center gap-3">
                        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-sm">{events.length}</span>
                        {text.eventsHeading}
                    </h2>
                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                        <ul className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                            {events.length === 0 ? <li className="p-6 text-gray-500 text-center">{text.noEvents}</li> :
                                events.map(event => (
                                    <li key={event._id} className="p-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:bg-gray-50 transition border-b border-gray-100 last:border-0">
                                        <div>
                                            <h4 className="font-bold text-gray-900 mb-1 leading-tight">
                                                {event.title}
                                                <EventStatusBadges event={event} />
                                                {event.approvalMode === 'auto' && <span className="ml-2 align-middle px-2 py-0.5 text-[10px] font-black rounded uppercase tracking-wider bg-blue-100 text-blue-700">Auto-approve</span>}
                                                {hasStarted(event.date) && <span className="ml-2 align-middle px-2 py-0.5 text-[10px] font-black rounded uppercase tracking-wider bg-gray-200 text-gray-600">Past</span>}
                                            </h4>
                                            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
                                                <span className="flex items-center gap-1 font-medium"><div className="w-2 h-2 rounded-full bg-blue-500"></div> {formatDateTime(event.date)}</span>
                                                <span className="flex items-center gap-1 font-medium"><div className={`w-2 h-2 rounded-full ${event.availableSeats > 0 ? 'bg-green-500' : 'bg-red-500'}`}></div> {event.availableSeats}/{event.totalSeats} seats</span>
                                                {isAdminMode && event.createdBy?.name && <span className="font-medium">by {event.createdBy.name}</span>}
                                            </div>
                                            {event.reviewNote && (
                                                <p className="text-sm text-red-600 mt-1"><strong>Admin note:</strong> {event.reviewNote}</p>
                                            )}
                                        </div>
                                        <div className="flex gap-2 w-full sm:w-auto shrink-0">
                                            <Link to={`/events/${event._id}`} className="flex-1 sm:flex-none text-center text-gray-700 hover:bg-gray-100 border border-gray-200 px-4 py-2 rounded-lg text-sm font-bold transition shadow-sm">
                                                View
                                            </Link>
                                            <button onClick={() => openEditForm(event)} className="flex-1 sm:flex-none text-gray-700 hover:text-white hover:bg-gray-800 border border-gray-200 px-4 py-2 rounded-lg text-sm font-bold transition shadow-sm">
                                                Edit
                                            </button>
                                            <button onClick={() => handleDeleteEvent(event)} className="flex-1 sm:flex-none text-red-500 hover:text-white hover:bg-red-500 border border-red-200 px-4 py-2 rounded-lg text-sm font-bold transition shadow-sm">
                                                Delete
                                            </button>
                                        </div>
                                    </li>
                                ))
                            }
                        </ul>
                    </div>
                </div>

                {/* Bookings Section */}
                <div className="flex flex-col">
                    <h2 className="text-2xl font-bold mb-4 text-gray-800 flex items-center gap-3">
                        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-yellow-100 text-yellow-700 text-sm font-bold">{pageInfo.total}</span>
                        Booking Requests
                    </h2>
                    <div className="flex flex-col sm:flex-row gap-3 mb-4">
                        <select aria-label="Filter by status" className="border px-3 py-2 rounded-lg bg-white text-sm focus:ring-2 focus:ring-gray-700 outline-none" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
                            <option value="">All statuses</option>
                            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                        </select>
                        <select aria-label="Filter by event" className="border px-3 py-2 rounded-lg bg-white text-sm flex-1 focus:ring-2 focus:ring-gray-700 outline-none" value={filters.eventId} onChange={e => setFilters({ ...filters, eventId: e.target.value })}>
                            <option value="">All events</option>
                            {events.map((e) => <option key={e._id} value={e._id}>{e.title}</option>)}
                        </select>
                    </div>
                    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                        <ul className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                            {bookings.length === 0 ? <li className="p-6 text-gray-500 text-center">{listLoading ? 'Loading bookings...' : 'No bookings match.'}</li> :
                                bookings.map(booking => {
                                    const liveEvent = booking.eventId ? (eventsById[booking.eventId._id] || booking.eventId) : null;
                                    const title = liveEvent?.title || booking.eventSnapshot?.title || 'Deleted Event';
                                    const borderColor = { pending: 'border-l-yellow-400', confirmed: 'border-l-green-400', rejected: 'border-l-orange-400' }[booking.status] || 'border-l-red-400';
                                    const badgeColor = { confirmed: 'bg-green-100 text-green-700', cancelled: 'bg-red-100 text-red-700', rejected: 'bg-orange-100 text-orange-700' }[booking.status] || 'bg-yellow-100 text-yellow-700';
                                    const isActive = booking.status === 'pending' || booking.status === 'confirmed';
                                    return (
                                        <li key={booking._id} className={`p-6 hover:bg-gray-50 transition border-l-4 ${borderColor}`}>
                                            <div className="flex justify-between items-start mb-3">
                                                <h4 className="font-bold text-gray-900 text-lg leading-tight">{title}</h4>
                                                <div className="flex flex-col gap-1 items-end shrink-0 ml-4">
                                                    <span className={`px-2 py-1 text-[10px] font-black rounded uppercase tracking-wider ${badgeColor}`}>{booking.status}</span>
                                                    {isActive && <span className={`px-2 py-1 text-[10px] font-black rounded uppercase tracking-wider ${booking.paymentStatus === 'paid' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-200 text-gray-800'}`}>{booking.paymentStatus.replace('_', ' ')}</span>}
                                                </div>
                                            </div>
                                            <div className="bg-gray-50 rounded-lg p-3 mb-3 border border-gray-100 text-sm">
                                                <p className="text-gray-700 flex items-center gap-2 mb-1">
                                                    <span className="font-bold w-16 text-gray-500 uppercase text-xs">User:</span>
                                                    <span className="font-semibold">{booking.userId?.name}</span>
                                                    <span className="text-gray-400">({booking.userId?.email})</span>
                                                </p>
                                                <p className="text-gray-700 flex items-center gap-2 mb-1">
                                                    <span className="font-bold w-16 text-gray-500 uppercase text-xs">Amount:</span>
                                                    <span className={`font-semibold ${booking.amount === 0 ? 'text-green-600' : ''}`}>{booking.amount === 0 ? 'Free' : `₹${booking.amount}`}</span>
                                                </p>
                                                <p className="text-gray-700 flex items-center gap-2 mb-1">
                                                    <span className="font-bold w-16 text-gray-500 uppercase text-xs">Date:</span>
                                                    <span>{formatDateTime(booking.bookedAt)}</span>
                                                </p>
                                                {booking.statusReason && (
                                                    <p className="text-gray-700 flex items-center gap-2 mb-1">
                                                        <span className="font-bold w-16 text-gray-500 uppercase text-xs">Reason:</span>
                                                        <span>{booking.statusReason}</span>
                                                    </p>
                                                )}
                                                {liveEvent && (
                                                    <p className="text-gray-700 flex items-center gap-2 mt-2 pt-2 border-t border-gray-200">
                                                        <span className="font-bold w-16 text-gray-500 uppercase text-xs">Seats:</span>
                                                        <span className={`font-bold ${liveEvent.availableSeats > 0 ? 'text-green-600' : 'text-red-500'}`}>{liveEvent.availableSeats}</span> remaining of {liveEvent.totalSeats}
                                                    </p>
                                                )}
                                            </div>

                                            {booking.status === 'confirmed' && booking.paymentStatus === 'not_paid' && booking.amount > 0 && (
                                                <button onClick={() => handleMarkPaid(booking)} className="w-full mt-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-600 hover:text-white border border-indigo-200 text-xs font-bold py-2.5 px-3 rounded-lg shadow-sm transition">
                                                    ₹ Mark as paid
                                                </button>
                                            )}

                                            {/* Approve / reject actions */}
                                            {booking.status === 'pending' && liveEvent && hasStarted(liveEvent.date) && (
                                                <div className="flex flex-wrap items-center gap-2 mt-2">
                                                    <p className="flex-1 text-xs text-gray-500 italic">The event has started, so this request can only be declined.</p>
                                                    <button onClick={() => handleRejectBooking(booking)} className="w-[80px] bg-red-50 text-red-600 hover:bg-red-500 hover:text-white border border-red-200 text-xs font-bold py-2.5 px-3 rounded-lg transition">
                                                        ✕ Reject
                                                    </button>
                                                </div>
                                            )}
                                            {booking.status === 'pending' && !(liveEvent && hasStarted(liveEvent.date)) && (
                                                <div className="flex flex-wrap gap-2 mt-2">
                                                    <button onClick={() => handleConfirmBooking(booking, 'paid')} className="flex-1 min-w-[120px] bg-green-50 text-green-700 hover:bg-green-600 hover:text-white border border-green-200 text-xs font-bold py-2.5 px-3 rounded-lg shadow-sm transition">
                                                        ✓ Approve as Paid
                                                    </button>
                                                    <button onClick={() => handleConfirmBooking(booking, 'not_paid')} className="flex-1 min-w-[120px] bg-gray-50 text-gray-700 hover:bg-gray-800 hover:text-white border border-gray-200 text-xs font-bold py-2.5 px-3 rounded-lg shadow-sm transition">
                                                        ✓ Approve Undecided
                                                    </button>
                                                    <button onClick={() => handleRejectBooking(booking)} className="w-[80px] bg-red-50 text-red-600 hover:bg-red-500 hover:text-white border border-red-200 text-xs font-bold py-2.5 px-3 rounded-lg transition">
                                                        ✕ Reject
                                                    </button>
                                                </div>
                                            )}
                                        </li>
                                    );
                                })
                            }
                        </ul>
                        {pageInfo.hasMore && (
                            <button
                                // Skip only bookings that still match the filter: ones approved or
                                // rejected while viewing e.g. "Pending" have left the server's list.
                                onClick={() => fetchBookings(bookings.filter((b) => !filters.status || b.status === filters.status).length, true)}
                                disabled={listLoading}
                                className="w-full py-3 text-sm font-bold text-gray-700 hover:bg-gray-50 border-t border-gray-100 transition"
                            >
                                {listLoading ? 'Loading...' : `Load more (${bookings.length} of ${pageInfo.total})`}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EventManager;
