import React, { useState, useEffect, useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import api from '../utils/axios';
import { Link, useNavigate } from 'react-router-dom';
import { formatDateTime } from '../utils/format';
import useRefreshOnFocus from '../utils/useRefreshOnFocus';
import { FaTicketAlt, FaTimesCircle } from 'react-icons/fa';

const STATUS_STYLES = {
    confirmed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
    rejected: 'bg-orange-100 text-orange-700',
    pending: 'bg-yellow-100 text-yellow-700'
};

const UserDashboard = () => {
    const { user } = useContext(AuthContext);
    const navigate = useNavigate();
    const [bookings, setBookings] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!user) {
            navigate('/login');
            return;
        }
        fetchBookings();
    }, [user, navigate]);

    const fetchBookings = async () => {
        try {
            const { data } = await api.get('/bookings/my');
            setBookings(data);
        } catch (error) {
            console.error('Error fetching bookings', error);
        } finally {
            setLoading(false);
        }
    };

    // Show approvals and rejections made while this tab was in the background.
    useRefreshOnFocus(() => (user ? fetchBookings() : undefined));

    const cancelBooking = async (id) => {
        if (window.confirm('Are you sure you want to cancel this booking request?')) {
            try {
                await api.delete(`/bookings/${id}`);
                fetchBookings();
            } catch (error) {
                alert(error.response?.data?.message || 'Error cancelling booking');
            }
        }
    };

    if (loading) return <div className="text-center py-20 text-xl font-semibold">Loading dashboard...</div>;

    return (
        <div className="max-w-6xl mx-auto">
            <div className="bg-white rounded-2xl shadow-sm p-6 sm:p-8 mb-8 border border-gray-100 flex flex-col sm:flex-row items-center sm:items-start text-center sm:text-left gap-4 sm:gap-6">
                <div className="w-20 h-20 bg-gray-200 text-gray-900 rounded-full flex items-center justify-center text-3xl font-bold uppercase tracking-widest shrink-0">
                    {user?.name.charAt(0)}
                </div>
                <div className="flex flex-col items-center sm:items-start">
                    <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 mb-2">Welcome, {user?.name}!</h1>
                    <p className="text-gray-500 flex items-center justify-center sm:justify-start gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-500"></span> User Dashboard
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl sm:text-2xl font-bold text-gray-800 flex items-center gap-2 sm:gap-3">
                    <FaTicketAlt className="text-gray-700" /> My Bookings
                </h2>
            </div>

            {bookings.length === 0 ? (
                <div className="bg-white rounded-xl shadow-sm p-12 text-center border border-gray-100">
                    <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <FaTicketAlt className="text-gray-300 text-3xl" />
                    </div>
                    <p className="text-xl text-gray-500 mb-6 mt-4 font-medium">You haven't booked any events yet.</p>
                    <Link to="/" className="inline-block bg-gray-900 hover:bg-black text-white font-bold py-3 px-8 rounded-lg transition shadow-md">
                        Browse Events
                    </Link>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {bookings.map((booking) => {
                        // The live event, or the copy saved at booking time if the event was deleted.
                        const event = booking.eventId || booking.eventSnapshot;
                        const eventDeleted = !booking.eventId;
                        const isActive = booking.status === 'pending' || booking.status === 'confirmed';

                        return (
                            <div key={booking._id} className="bg-white rounded-xl overflow-hidden shadow-sm hover:shadow-md transition border border-gray-100 flex flex-col">
                                <div className="p-6 border-b border-gray-50 flex-grow">
                                    {event?.title ? (
                                        <>
                                            <div className="flex justify-between items-start mb-4">
                                                <h3 className="text-lg font-bold text-gray-900 leading-tight">{event.title}</h3>
                                                <div className="flex flex-col gap-1 items-end">
                                                    <span className={`px-2 py-1 text-[10px] font-black rounded uppercase tracking-wider ${STATUS_STYLES[booking.status] || STATUS_STYLES.pending}`}>
                                                        {booking.status}
                                                    </span>
                                                    {isActive && (
                                                        <span className={`px-2 py-1 text-[10px] font-black rounded uppercase tracking-wider ${booking.paymentStatus === 'paid' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'
                                                            }`}>
                                                            {booking.paymentStatus.replace('_', ' ')}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="text-sm text-gray-500 mb-4 space-y-1">
                                                {event.date && <p><strong className="text-gray-700">Date:</strong> {formatDateTime(event.date)}</p>}
                                                <p><strong className="text-gray-700">Amount:</strong> {booking.amount === 0 ? 'Free' : `₹${booking.amount}`}</p>
                                                <p><strong className="text-gray-700">Requested:</strong> {formatDateTime(booking.bookedAt)}</p>
                                                {booking.statusReason && (
                                                    <p className={booking.status === 'rejected' ? 'text-orange-700' : 'text-red-600'}>
                                                        <strong>Reason:</strong> {booking.statusReason}
                                                    </p>
                                                )}
                                                {eventDeleted && !booking.statusReason && (
                                                    <p className="text-red-600 italic">This event is no longer available.</p>
                                                )}
                                            </div>
                                        </>
                                    ) : (
                                        <p className="text-red-500 italic">Event details unavailable (might have been deleted)</p>
                                    )}
                                </div>
                                <div className="p-4 bg-gray-50 flex justify-between items-center shrink-0">
                                    {!eventDeleted && isActive ? (
                                        <>
                                            <Link to={`/events/${booking.eventId._id}`} className="text-gray-900 font-semibold text-sm hover:underline">View Event</Link>
                                            <button
                                                onClick={() => cancelBooking(booking._id)}
                                                className="text-red-500 font-semibold text-sm hover:text-red-700 transition flex items-center gap-1"
                                            >
                                                <FaTimesCircle /> Cancel
                                            </button>
                                        </>
                                    ) : booking.status === 'rejected' && !eventDeleted ? (
                                        <>
                                            <span className="text-sm text-gray-500 italic">Request declined</span>
                                            <Link to={`/events/${booking.eventId._id}`} className="text-gray-900 font-semibold text-sm hover:underline">Request again</Link>
                                        </>
                                    ) : (
                                        <div className="w-full text-center text-sm text-gray-500 italic">
                                            {booking.status === 'rejected' ? 'Request declined' : 'Booking Cancelled'}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default UserDashboard;
