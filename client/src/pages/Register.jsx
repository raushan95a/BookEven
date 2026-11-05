import React, { useState, useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import api from '../utils/axios';
import ResendCodeButton from '../components/ResendCodeButton';

const Register = () => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [otp, setOtp] = useState('');
    const [showOTP, setShowOTP] = useState(false);
    // False when the account was created but the code email could not be sent.
    const [codeSent, setCodeSent] = useState(true);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');
    const [loading, setLoading] = useState(false);

    const { register, verifyOTP } = useContext(AuthContext);
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        setInfo('');
        try {
            if (!showOTP) {
                await register(name, email, password);
                setCodeSent(true);
                setShowOTP(true);
            } else {
                await verifyOTP(email, otp);
                navigate('/dashboard');
            }
        } catch (err) {
            if (err.accountCreated) {
                setCodeSent(false);
                setShowOTP(true);
                setError(err.message);
            } else {
                setError(err);
            }
        } finally {
            setLoading(false);
        }
    };

    const showMessage = (text, isError) => {
        if (isError) { setError(text); setInfo(''); } else { setInfo(text); setError(''); setCodeSent(true); }
    };

    return (
        <div className="max-w-md mx-auto mt-16 bg-white p-8 rounded-xl shadow-lg border border-gray-100">
            <div className="text-center mb-8">
                <h2 className="text-3xl font-extrabold text-gray-900 mb-2">Create an Account</h2>
                <p className="text-gray-500">Join BookEven today</p>
            </div>

            {error && <div role="alert" className="bg-red-50 text-red-600 p-3 rounded-lg mb-6 text-center shadow-inner border border-red-100">{error}</div>}
            {info && <div role="status" className="bg-green-50 text-green-700 p-3 rounded-lg mb-6 text-center border border-green-200">{info}</div>}

            <form onSubmit={handleSubmit} className="space-y-5">
                {!showOTP ? (
                    <>
                        <div>
                            <label htmlFor="register-name" className="block text-sm font-semibold text-gray-700 mb-2">Full Name</label>
                            <input
                                id="register-name"
                                type="text"
                                required
                                maxLength={100}
                                autoComplete="name"
                                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-gray-700 transition shadow-sm"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                        <div>
                            <label htmlFor="register-email" className="block text-sm font-semibold text-gray-700 mb-2">Email Address</label>
                            <input
                                id="register-email"
                                type="email"
                                required
                                autoComplete="email"
                                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-gray-700 transition shadow-sm"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </div>
                        <div>
                            <label htmlFor="register-password" className="block text-sm font-semibold text-gray-700 mb-2">Password</label>
                            <input
                                id="register-password"
                                type="password"
                                required
                                minLength={8}
                                maxLength={128}
                                autoComplete="new-password"
                                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-gray-700 transition shadow-sm"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                            <p className="text-xs text-gray-500 mt-1">At least 8 characters.</p>
                        </div>
                    </>
                ) : (
                    <div>
                        {codeSent && (
                            <p className="text-sm text-green-700 bg-green-50 p-3 mb-4 rounded border border-green-200">
                                An OTP has been sent to your email. Please verify your account.
                            </p>
                        )}
                        <label htmlFor="register-otp" className="block text-sm font-semibold text-gray-700 mb-2">Verification Code (OTP)</label>
                        <input
                            id="register-otp"
                            type="text"
                            required
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="6-digit code"
                            className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-gray-700 transition shadow-sm font-bold tracking-widest text-center text-lg"
                            value={otp}
                            onChange={(e) => setOtp(e.target.value)}
                            maxLength="6"
                        />
                        <div className="text-center mt-3">
                            <ResendCodeButton
                                // After a failed send there is no cooldown, so allow resending at once.
                                key={codeSent ? 'sent' : 'not-sent'}
                                startWithCooldown={codeSent}
                                onResend={async () => (await api.post('/auth/resend-otp', { email })).data}
                                onMessage={showMessage}
                            />
                        </div>
                    </div>
                )}

                <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-gray-900 text-white font-bold py-3 rounded-lg hover:bg-black focus:ring-4 focus:ring-gray-200 transition shadow-md mt-4"
                >
                    {loading ? 'Processing...' : (showOTP ? 'Verify & Complete' : 'Sign Up')}
                </button>
            </form>

            {!showOTP && (
                <p className="text-center mt-6 text-gray-600">
                    Already have an account? <Link to="/login" className="text-gray-900 font-bold hover:underline">Sign in</Link>
                </p>
            )}
        </div>
    );
};

export default Register;
