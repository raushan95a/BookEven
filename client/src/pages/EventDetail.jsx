import React, { useState, useEffect, useContext } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { formatDateTimeLong, hasStarted } from '../utils/format';
import ResendCodeButton from '../components/ResendCodeButton';
import { FaCalendarAlt, FaMapMarkerAlt, FaChair, FaMoneyBillWave } from 'react-icons/fa';

const ACTIVE_STATUSES = ['pending', 'confirmed'];

const EventDetail = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { user } = useContext(AuthContext);
    const [event, setEvent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [bookingLoading, setBookingLoading] = useState(false);
    const [otp, setOtp] = useState('');
    const [showOTP, setShowOTP] = useState(false);
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');
    // The signed-in user's pending/confirmed booking for this event, if any.
    const [myBooking, setMyBooking] = useState(null);
    // Their most recent declined request, shown as a note.
    const [declined, setDeclined] = useState(null);

    useEffect(() => {
        const fetchEvent = async () => {
            try {
                const { data } = await api.get(`/events/${id}`);
                setEvent(data);
            } catch (err) {
                setError('Failed to load event details.');
            } finally {
                setLoading(false);
            }
        };
        fetchEvent();
    }, [id]);

    useEffect(() => {
        if (!user) return;
        const fetchMyBooking = async () => {
            try {
                const { data } = await api.get('/bookings/my');
                const forThisEvent = data.filter((b) => (b.eventId?._id || b.eventId) === id);
                setMyBooking(forThisEvent.find((b) => ACTIVE_STATUSES.includes(b.status)) || null);
                setDeclined(forThisEvent.find((b) => b.status === 'rejected') || null);
            } catch {
                // Not critical: the server still blocks duplicate bookings.
            }
        };
        fetchMyBooking();
    }, [user, id]);

    const handleBooking = async () => {
        if (!user) {
            navigate('/login');
            return;
        }
        setBookingLoading(true);
        setError('');
        setSuccessMsg('');

        try {
            if (!showOTP) {
                const { data } = await api.post('/bookings/send-otp');
                setShowOTP(true);
                setSuccessMsg(data.retryAfterSeconds
                    ? 'A code was sent to your email less than a minute ago. Enter it below.'
                    : 'OTP sent to your email. Please verify to confirm booking.');
            } else {
                const { data } = await api.post('/bookings', { eventId: event._id, otp });
                setMyBooking(data.booking);
                setDeclined(null);
                setShowOTP(false);
                setOtp('');
                if (data.autoConfirmed) {
                    // Auto-approve events take the seat now: show the new count from the server.
                    const fresh = await api.get(`/events/${event._id}`);
                    setEvent(fresh.data);
                    setSuccessMsg('Booking confirmed! A confirmation email is on its way.');
                } else {
                    // Seats are only taken when the organiser approves, so the count shown stays as it is.
                    setSuccessMsg('Booking requested! Awaiting admin confirmation.');
                }
            }
        } catch (err) {
            setError(err.response?.data?.message || 'Booking failed');
        } finally {
            setBookingLoading(false);
        }
    };

    if (loading) return <div className="text-center py-20 text-xl font-semibold">Loading...</div>;
    if (error && !event) return <div className="text-center py-20 text-xl text-red-500">{error || 'Event not found'}</div>;

    const isSoldOut = event.availableSeats <= 0;
    // Only the organiser and admins can open an unpublished event; it cannot be booked yet.
    const isUnpublished = event.status === 'pending_review' || event.status === 'rejected';
    const isClosed = hasStarted(event.date) || isUnpublished;
    const buttonDisabled = isSoldOut || isClosed || bookingLoading || (showOTP && !otp);

    let buttonLabel = 'Confirm Registration';
    if (bookingLoading) buttonLabel = 'Processing...';
    else if (showOTP) buttonLabel = 'Verify OTP & Confirm';
    else if (isUnpublished) buttonLabel = 'Not Published Yet';
    else if (isClosed) buttonLabel = 'Booking Closed';
    else if (isSoldOut) buttonLabel = 'Sold Out';

    return (
        <div className="max-w-4xl mx-auto mt-8">
        {isUnpublished && (
            <div role="status" className={`mb-4 p-4 rounded-xl border ${event.status === 'rejected' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-yellow-50 border-yellow-200 text-yellow-800'}`}>
                <p className="font-bold">{event.status === 'rejected' ? 'This event was not approved.' : 'This event is waiting for admin approval.'}</p>
                <p className="text-sm">Only you (and admins) can see this page. It is not listed or bookable until it is approved.{event.reviewNote ? ` Admin note: ${event.reviewNote}` : ''}</p>
            </div>
        )}
        {event.pendingChanges && (
            <div role="status" className="mb-4 p-4 rounded-xl border bg-purple-50 border-purple-200 text-purple-800 text-sm">
                Your latest changes are waiting for admin approval. This page shows the current published version.
            </div>
        )}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
            {event.image ? (
                <img src={event.image} alt={event.title} className="w-full h-80 object-cover" />
            ) : (
                <div className="w-full h-64 bg-gray-900 flex items-center justify-center text-white/50 text-6xl font-black uppercase tracking-widest">
                    {event.category}
                </div>
            )}

            <div className="p-8 md:p-12">
                <div className="flex flex-col md:flex-row justify-between items-start mb-8 gap-6">
                    <div>
                        <div className="flex flex-wrap gap-2 mb-3">
                            <div className="inline-block bg-gray-200 text-gray-800 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide">
                                {event.category}
                            </div>
                            {event.approvalMode === 'auto' && (
                                <div className="inline-block bg-blue-100 text-blue-700 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide">
                                    Instant confirmation
                                </div>
                            )}
                        </div>
                        <h1 className="text-4xl font-extrabold text-gray-900 mb-4">{event.title}</h1>
                        <p className="text-gray-600 text-lg leading-relaxed mb-6">{event.description}</p>
                    </div>

                    <div className="bg-gray-50 p-6 rounded-xl border border-gray-100 w-full md:w-auto md:min-w-[300px] shrink-0 shadow-sm">
                        <h3 className="text-xl font-bold text-gray-800 mb-6">Booking Details</h3>

                        <div className="space-y-4 mb-8">
                            <div className="flex items-center gap-4 text-gray-600">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-900 shrink-0">
                                    <FaMoneyBillWave />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-gray-400 uppercase">Ticket Price</p>
                                    <p className="font-bold text-gray-800 text-lg">{event.ticketPrice === 0 ? <span className="text-green-500">Free</span> : `₹${event.ticketPrice}`}</p>
                                </div>
                            </div>

                            <div className="flex items-center gap-4 text-gray-600">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-900 shrink-0">
                                    <FaChair />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-gray-400 uppercase">Availability</p>
                                    <p className="font-bold text-gray-800">
                                        <span className={event.availableSeats < 10 ? 'text-orange-500' : ''}>{event.availableSeats}</span> / {event.totalSeats}
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center gap-4 text-gray-600">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-900 shrink-0">
                                    <FaCalendarAlt />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-gray-400 uppercase">Date &amp; Time</p>
                                    <p className="font-bold text-gray-800">{formatDateTimeLong(event.date)}</p>
                                </div>
                            </div>

                            <div className="flex items-center gap-4 text-gray-600">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-900 shrink-0">
                                    <FaMapMarkerAlt />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-gray-400 uppercase">Location</p>
                                    <p className="font-bold text-gray-800">{event.location}</p>
                                </div>
                            </div>
                        </div>

                        {myBooking ? (
                            // Already requested or booked: show the status instead of the button.
                            <div role="status" className={`p-4 rounded-xl border text-center ${myBooking.status === 'confirmed' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-yellow-50 border-yellow-200 text-yellow-800'}`}>
                                <p className="font-bold text-lg mb-1">
                                    {myBooking.status === 'confirmed' ? "You're booked!" : 'Request pending'}
                                </p>
                                <p className="text-sm mb-3">
                                    {myBooking.status === 'confirmed'
                                        ? 'Your seat is confirmed.'
                                        : 'The organiser will review your request and confirm your seat.'}
                                </p>
                                <Link to="/dashboard" className="text-sm font-semibold underline">View in My Bookings</Link>
                            </div>
                        ) : (
                            <>
                                {declined && (
                                    <p className="text-sm text-orange-700 bg-orange-50 border border-orange-200 p-3 rounded-lg mb-4">
                                        Your previous request was declined{declined.statusReason ? `: ${declined.statusReason}` : '.'} You can request a seat again.
                                    </p>
                                )}

                                {showOTP && (
                                    <div className="mb-4">
                                        <label htmlFor="booking-otp" className="block text-sm font-semibold text-gray-700 mb-2">Enter OTP to Confirm</label>
                                        <input
                                            id="booking-otp"
                                            type="text"
                                            required
                                            inputMode="numeric"
                                            autoComplete="one-time-code"
                                            placeholder="6-digit code"
                                            className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-gray-700 transition shadow-sm font-bold tracking-widest text-center text-lg"
                                            value={otp}
                                            onChange={(e) => setOtp(e.target.value)}
                                            maxLength="6"
                                        />
                                        <div className="text-center mt-2">
                                            <ResendCodeButton
                                                onResend={async () => (await api.post('/bookings/send-otp')).data}
                                                onMessage={(text, isError) => {
                                                    if (isError) { setError(text); setSuccessMsg(''); } else { setSuccessMsg(text); setError(''); }
                                                }}
                                            />
                                        </div>
                                    </div>
                                )}

                                <button
                                    onClick={handleBooking}
                                    disabled={buttonDisabled}
                                    className={`w-full py-4 px-6 rounded-xl font-bold text-lg transition shadow-lg ${isSoldOut || isClosed
                                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                        : 'bg-gray-900 hover:bg-black text-white hover:shadow-xl hover:-translate-y-1'
                                        }`}
                                >
                                    {buttonLabel}
                                </button>
                            </>
                        )}
                        {error && <p role="alert" className="text-red-500 mt-4 text-center font-medium bg-red-50 p-2 rounded">{error}</p>}
                        {successMsg && <p role="status" className="text-green-600 mt-4 text-center font-medium bg-green-50 p-2 rounded">{successMsg}</p>}
                    </div>
                </div>
            </div>
        </div>
        </div>
    );
};

export default EventDetail;
