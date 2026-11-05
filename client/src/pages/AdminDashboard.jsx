import React from 'react';
import EventManager from '../components/EventManager';

// Admins manage every event and booking, and review event submissions.
const AdminDashboard = () => <EventManager mode="admin" />;

export default AdminDashboard;
