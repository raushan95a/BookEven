import React, { createContext, useState, useEffect, useCallback } from 'react';
import api, { setUnauthorizedHandler } from '../utils/axios';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const logout = useCallback(() => {
        setUser(null);
        localStorage.removeItem('userInfo');
        localStorage.removeItem('token');
    }, []);

    useEffect(() => {
        const userInfo = localStorage.getItem('userInfo');
        if (userInfo) {
            setUser(JSON.parse(userInfo));
        }
        setLoading(false);
    }, []);

    // An expired or invalid session: clear it and send the user to log in again.
    useEffect(() => {
        setUnauthorizedHandler(() => {
            logout();
            if (window.location.pathname !== '/login') {
                window.location.replace('/login?expired=1');
            }
        });
        return () => setUnauthorizedHandler(null);
    }, [logout]);

    const login = async (email, password) => {
        try {
            const { data } = await api.post('/auth/login', { email, password });
            setUser(data);
            localStorage.setItem('userInfo', JSON.stringify(data));
            localStorage.setItem('token', data.token);
            return data;
        } catch (error) {
            if (error.response?.data?.needsVerification) throw error.response.data;
            throw error.response?.data?.message || 'Login failed';
        }
    };

    const register = async (name, email, password) => {
        try {
            const { data } = await api.post('/auth/register', { name, email, password });
            return data; // Returns { message, email }
        } catch (error) {
            // Account created but the code email failed: the caller shows the code step with "Resend".
            if (error.response?.data?.accountCreated) throw error.response.data;
            throw error.response?.data?.message || 'Registration failed';
        }
    };

    const verifyOTP = async (email, otp) => {
        try {
            const { data } = await api.post('/auth/verify-otp', { email, otp });
            setUser(data);
            localStorage.setItem('userInfo', JSON.stringify(data));
            localStorage.setItem('token', data.token);
            return data;
        } catch (error) {
            throw error.response?.data?.message || 'OTP verification failed';
        }
    };

    return (
        <AuthContext.Provider value={{ user, login, register, verifyOTP, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};
