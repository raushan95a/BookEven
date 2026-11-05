import React, { useState, useEffect } from 'react';

const COOLDOWN_SECONDS = 60;

/**
 * "Resend code" link with a countdown, matching the server's 60-second resend limit.
 * `onResend` performs the request and returns the axios response data.
 * Reports success or failure text through `onMessage(text, isError)`.
 */
const ResendCodeButton = ({ onResend, onMessage, startWithCooldown = true }) => {
    const [secondsLeft, setSecondsLeft] = useState(startWithCooldown ? COOLDOWN_SECONDS : 0);
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (secondsLeft <= 0) return undefined;
        const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
        return () => clearTimeout(timer);
    }, [secondsLeft]);

    const handleClick = async () => {
        setSending(true);
        try {
            const data = await onResend();
            setSecondsLeft(data?.retryAfterSeconds || COOLDOWN_SECONDS);
            onMessage?.(data?.message || 'A new code has been sent to your email.', false);
        } catch (err) {
            const data = err.response?.data;
            if (data?.retryAfterSeconds) setSecondsLeft(data.retryAfterSeconds);
            onMessage?.(data?.message || 'Could not resend the code. Please try again.', true);
        } finally {
            setSending(false);
        }
    };

    const disabled = sending || secondsLeft > 0;

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={disabled}
            className={`text-sm font-semibold transition ${disabled ? 'text-gray-400 cursor-not-allowed' : 'text-gray-900 hover:underline'}`}
        >
            {sending ? 'Sending...' : secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : 'Resend code'}
        </button>
    );
};

export default ResendCodeButton;
