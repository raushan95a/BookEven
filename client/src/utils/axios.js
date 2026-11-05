import axios from 'axios';

// Set VITE_API_URL (see client/.env.example) when the API is not on localhost:5000.
const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
});

api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Called when a logged-in request is refused with 401 (expired or invalid session).
let unauthorizedHandler = null;
export const setUnauthorizedHandler = (handler) => {
    unauthorizedHandler = handler;
};

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const sentToken = Boolean(error.config?.headers?.Authorization);
        if (error.response?.status === 401 && sentToken && unauthorizedHandler) {
            unauthorizedHandler();
        }
        return Promise.reject(error);
    }
);

export default api;
