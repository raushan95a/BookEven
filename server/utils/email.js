const nodemailer = require('nodemailer');
const path = require('path');
const dotenv = require('dotenv');
const { escapeHtml } = require('./validation');

// Read server/.env even when this file is loaded on its own (e.g. by a script).
dotenv.config({ path: path.join(__dirname, '../.env') });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const isEmailConfigured = () => Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

// Subjects are plain text: strip line breaks so user text can't add email headers.
const oneLine = (text) => String(text).replace(/[\r\n]/g, ' ');

/**
 * Sends one email. Every send function returns true when the mail server accepted
 * the message and false when it failed, so callers can tell the user instead of
 * pretending it worked. Failures are logged without the message body.
 */
const deliver = async (label, mailOptions) => {
    // Safety net: automated tests must never send real email, even if a test forgets a stub.
    if (process.env.NODE_ENV === 'test') return true;
    try {
        await transporter.sendMail({ from: process.env.EMAIL_USER, ...mailOptions });
        console.log(`${label} email sent to`, mailOptions.to);
        return true;
    } catch (error) {
        console.error(`Error sending ${label} email to ${mailOptions.to}:`, error.code || '', error.message);
        return false;
    }
};

const sendBookingEmail = (userEmail, userName, eventTitle) => deliver('Booking confirmation', {
    to: userEmail,
    subject: `Booking Confirmed: ${oneLine(eventTitle)}`,
    // Names and titles are user-supplied: escape them before putting them in HTML.
    html: `
        <h2>Hi ${escapeHtml(userName)}!</h2>
        <p>Your booking for the event <strong>${escapeHtml(eventTitle)}</strong> is successfully confirmed.</p>
        <p>Thank you for choosing BookEven.</p>
      `
});

const sendOTPEmail = (userEmail, otp, type) => {
    const title = type === 'account_verification' ? 'Verify your BookEven Account' : 'BookEven Booking Verification';
    const msg = type === 'account_verification'
        ? 'Please use the following OTP to verify your new BookEven account.'
        : 'Please use the following OTP to verify and confirm your event booking.';

    return deliver('OTP', {
        to: userEmail,
        subject: title,
        html: `
                <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                    <h2 style="color: #111;">${title}</h2>
                    <p style="color: #555; font-size: 16px;">${msg}</p>
                    <div style="margin: 20px auto; padding: 15px; font-size: 24px; font-weight: bold; background: #f4f4f4; width: max-content; letter-spacing: 5px;">
                        ${otp}
                    </div>
                    <p style="color: #999; font-size: 12px;">This code expires in 5 minutes. If you didn't request this, please ignore this email.</p>
                </div>
            `
    });
};

// Sent when an admin deletes an event that this user had a pending or confirmed booking for.
const sendEventCancelledEmail = (userEmail, userName, eventTitle) => deliver('Event cancellation', {
    to: userEmail,
    subject: `Event Cancelled: ${oneLine(eventTitle)}`,
    html: `
        <h2>Hi ${escapeHtml(userName)},</h2>
        <p>Unfortunately the event <strong>${escapeHtml(eventTitle)}</strong> has been cancelled by the organiser, and your booking has been cancelled with it.</p>
        <p>If you paid for this booking, the organiser will contact you about a refund.</p>
        <p>Thank you for using BookEven.</p>
      `
});

// Sent when an admin declines a pending booking request.
const sendBookingRejectedEmail = (userEmail, userName, eventTitle, reason) => deliver('Booking rejection', {
    to: userEmail,
    subject: `Booking Request Declined: ${oneLine(eventTitle)}`,
    html: `
        <h2>Hi ${escapeHtml(userName)},</h2>
        <p>Your booking request for <strong>${escapeHtml(eventTitle)}</strong> was not approved by the organiser.</p>
        ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
        <p>You can request a seat again from the event page if seats are still available.</p>
        <p>Thank you for using BookEven.</p>
      `
});

// To an admin when an organiser submits a new event, resubmits one, or proposes changes.
// kind: 'new' | 'resubmitted' | 'changes'
const sendEventSubmittedEmail = (adminEmail, organiserName, eventTitle, kind) => {
    const what = {
        new: 'submitted a new event',
        resubmitted: 'resubmitted an event after changes',
        changes: 'proposed changes to a published event'
    }[kind] || 'submitted an event';
    return deliver('Event submission', {
        to: adminEmail,
        subject: `Review needed: ${oneLine(eventTitle)}`,
        html: `
        <h2>An event needs your review</h2>
        <p><strong>${escapeHtml(organiserName)}</strong> ${what}: <strong>${escapeHtml(eventTitle)}</strong>.</p>
        <p>Open the Admin Dashboard and look under <em>Event submissions</em> to approve or reject it.</p>
      `
    });
};

// To the organiser after an admin reviews their event or their proposed changes.
// decision: 'approve' | 'reject'; kind: 'event' | 'changes'
const sendEventReviewEmail = (organiserEmail, organiserName, eventTitle, decision, kind, reason) => {
    const approved = decision === 'approve';
    const subject = kind === 'changes'
        ? `Changes ${approved ? 'approved' : 'not approved'}: ${oneLine(eventTitle)}`
        : `Event ${approved ? 'approved' : 'not approved'}: ${oneLine(eventTitle)}`;
    const body = kind === 'changes'
        ? (approved
            ? 'Your changes have been approved and are now live.'
            : 'Your proposed changes were not approved. The event stays as it was.')
        : (approved
            ? 'Your event has been approved. It is now public and open for bookings.'
            : 'Your event was not approved. You can edit it and it will be sent for review again.');
    return deliver('Event review', {
        to: organiserEmail,
        subject,
        html: `
        <h2>Hi ${escapeHtml(organiserName)},</h2>
        <p><strong>${escapeHtml(eventTitle)}</strong>: ${body}</p>
        ${!approved && reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
        <p>Thank you for hosting with BookEven.</p>
      `
    });
};

module.exports = {
    sendEventSubmittedEmail,
    sendEventReviewEmail,
    isEmailConfigured,
    sendBookingEmail,
    sendOTPEmail,
    sendEventCancelledEmail,
    sendBookingRejectedEmail
};
