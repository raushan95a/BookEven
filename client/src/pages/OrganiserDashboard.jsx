import React from 'react';
import EventManager from '../components/EventManager';

// Any signed-in user can host events here; an admin approves each one before it is published.
const OrganiserDashboard = () => <EventManager mode="organiser" />;

export default OrganiserDashboard;
