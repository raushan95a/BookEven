import React, { useState, useEffect, useCallback } from 'react';
import api from '../utils/axios';
import { formatDateTime } from '../utils/format';

const FIELD_LABELS = { title: 'Title', description: 'Description', date: 'Date & time', location: 'Location', ticketPrice: 'Ticket price' };

const showValue = (field, value) => {
    if (value === undefined || value === null || value === '') return '—';
    if (field === 'date') return formatDateTime(value);
    if (field === 'ticketPrice') return Number(value) === 0 ? 'Free' : `₹${value}`;
    return String(value);
};

/**
 * Admin-only list of events waiting for review: new submissions, and published events
 * with changes proposed by their organiser. Approve or reject each one.
 */
const EventSubmissions = ({ onReviewed, onNotice }) => {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get('/events/review');
            setItems(data);
        } catch (error) {
            onNotice?.({ type: 'error', text: error.response?.data?.message || 'Error loading event submissions' });
        } finally {
            setLoading(false);
        }
    }, [onNotice]);

    useEffect(() => { load(); }, [load]);

    const review = async (event, decision) => {
        let reason;
        if (decision === 'reject') {
            reason = window.prompt(`Reject "${event.title}"?\n\nReason (optional, emailed to the organiser):`, '');
            if (reason === null) return;
        }
        setBusyId(event._id);
        try {
            const { data } = await api.put(`/events/${event._id}/review`, { decision, reason: reason?.trim() || undefined });
            const what = data.reviewed === 'changes' ? 'Changes to' : 'Event';
            let text = `${what} "${data.event.title}" ${decision === 'approve' ? 'approved' : 'rejected'}.`;
            if (!data.emailSent) text += ' The organiser could not be emailed.';
            onNotice?.({ type: data.emailSent ? 'success' : 'warning', text });
            await load();
            onReviewed?.();
        } catch (error) {
            alert(error.response?.data?.message || 'Error reviewing event');
            await load();
        } finally {
            setBusyId(null);
        }
    };

    if (loading || items.length === 0) return null;

    return (
        <div className="mb-8">
            <h2 className="text-2xl font-bold mb-4 text-gray-800 flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-purple-100 text-purple-700 text-sm font-bold">{items.length}</span>
                Event Submissions
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {items.map((event) => {
                    const isNew = event.status === 'pending_review';
                    const changes = event.pendingChanges
                        ? Object.keys(FIELD_LABELS).filter((f) => event.pendingChanges[f] !== undefined && event.pendingChanges[f] !== null)
                        : [];
                    return (
                        <div key={event._id} className="bg-white rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-purple-400 p-6">
                            <div className="flex justify-between items-start gap-4 mb-3">
                                <h3 className="font-bold text-gray-900 text-lg leading-tight">{event.title}</h3>
                                <span className="shrink-0 px-2 py-1 text-[10px] font-black rounded uppercase tracking-wider bg-purple-100 text-purple-700">
                                    {isNew ? 'New event' : 'Changes'}
                                </span>
                            </div>
                            <p className="text-sm text-gray-600 mb-3">
                                By <span className="font-semibold">{event.createdBy?.name || 'Unknown'}</span>
                                {event.createdBy?.email && <span className="text-gray-400"> ({event.createdBy.email})</span>}
                            </p>

                            {isNew ? (
                                <div className="bg-gray-50 rounded-lg p-3 mb-4 border border-gray-100 text-sm space-y-1">
                                    <p><strong className="text-gray-500">When:</strong> {formatDateTime(event.date)}</p>
                                    <p><strong className="text-gray-500">Where:</strong> {event.location}</p>
                                    <p><strong className="text-gray-500">Category:</strong> {event.category}</p>
                                    <p><strong className="text-gray-500">Seats / price:</strong> {event.totalSeats} · {showValue('ticketPrice', event.ticketPrice)}</p>
                                    <p className="text-gray-600 pt-1 whitespace-pre-line">{event.description}</p>
                                </div>
                            ) : (
                                <div className="mb-4 text-sm overflow-x-auto">
                                    <table className="w-full border border-gray-100 rounded-lg">
                                        <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                                            <tr><th className="text-left p-2">Field</th><th className="text-left p-2">Now</th><th className="text-left p-2">Proposed</th></tr>
                                        </thead>
                                        <tbody>
                                            {changes.map((f) => (
                                                <tr key={f} className="border-t border-gray-100 align-top">
                                                    <td className="p-2 font-semibold text-gray-700">{FIELD_LABELS[f]}</td>
                                                    <td className="p-2 text-gray-500">{showValue(f, event[f])}</td>
                                                    <td className="p-2 text-gray-900 font-medium">{showValue(f, event.pendingChanges[f])}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="flex gap-2">
                                <button disabled={busyId === event._id} onClick={() => review(event, 'approve')} className="flex-1 bg-green-50 text-green-700 hover:bg-green-600 hover:text-white border border-green-200 text-xs font-bold py-2.5 px-3 rounded-lg shadow-sm transition">
                                    ✓ Approve {isNew ? '& Publish' : 'Changes'}
                                </button>
                                <button disabled={busyId === event._id} onClick={() => review(event, 'reject')} className="flex-1 bg-red-50 text-red-600 hover:bg-red-500 hover:text-white border border-red-200 text-xs font-bold py-2.5 px-3 rounded-lg transition">
                                    ✕ Reject
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default EventSubmissions;
