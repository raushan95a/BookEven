import { useEffect, useRef } from 'react';

/**
 * Calls `refresh` when the user comes back to this tab or window, so a page shows
 * changes made elsewhere (e.g. an approval in another tab) without a manual reload.
 * Runs at most once every `minIntervalMs`.
 */
const useRefreshOnFocus = (refresh, { minIntervalMs = 2000 } = {}) => {
    const latest = useRef(refresh);
    latest.current = refresh;
    const lastRun = useRef(Date.now());

    useEffect(() => {
        const run = () => {
            if (document.visibilityState !== 'visible') return;
            const now = Date.now();
            if (now - lastRun.current < minIntervalMs) return;
            lastRun.current = now;
            Promise.resolve(latest.current()).catch(() => {});
        };
        window.addEventListener('focus', run);
        document.addEventListener('visibilitychange', run);
        return () => {
            window.removeEventListener('focus', run);
            document.removeEventListener('visibilitychange', run);
        };
    }, [minIntervalMs]);
};

export default useRefreshOnFocus;
