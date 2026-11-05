// Date helpers shared by every page, so event times look the same everywhere.

// "Mon, 12 Jan 2026, 6:30 pm" (in the viewer's own locale and time zone)
export const formatDateTime = (value) =>
    new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// "Monday, 12 January 2026 at 6:30 pm"
export const formatDateTimeLong = (value) =>
    new Date(value).toLocaleString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });

// <input type="datetime-local"> works in local time without a zone ("2026-01-12T18:30").
export const toDateTimeLocalValue = (value) => {
    const date = new Date(value);
    const offsetMs = date.getTimezoneOffset() * 60 * 1000;
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
};

// The browser reads "2026-01-12T18:30" as local time; send it to the API as UTC.
export const fromDateTimeLocalValue = (value) => new Date(value).toISOString();

export const hasStarted = (value) => new Date(value).getTime() <= Date.now();
