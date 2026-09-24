const CALENDAR_ID = 'f5q9pam7lk03msfakrjqet1sts@group.calendar.google.com';

export const googleCalendarUrl = (() => {
  const url = new URL('https://calendar.google.com/calendar/embed');
  url.searchParams.set('src', CALENDAR_ID);
  url.searchParams.set('ctz', 'Europe/Zurich');
  url.searchParams.set('mode', 'MONTH');
  url.searchParams.set('showTitle', '0');
  url.searchParams.set('showPrint', '0');
  url.searchParams.set('showTabs', '0');
  url.searchParams.set('showCalendars', '0');
  url.searchParams.set('showTz', '0');
  url.searchParams.set('wkst', '2');
  return url.toString();
})();

const icalUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;

export type AvailabilityData = {
  bookedDates: string[];
  syncedAt: string | null;
  available: boolean;
};

let availabilityPromise: Promise<AvailabilityData> | undefined;

const isoDate = (value: string) => {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const unfoldIcal = (source: string) => source.replace(/\r?\n[ \t]/g, '');

const parseBookedDates = (source: string) => {
  const booked = new Set<string>();
  const events = unfoldIcal(source).split('BEGIN:VEVENT').slice(1);

  for (const event of events) {
    if (/\nSTATUS:CANCELLED(?:\r?\n|$)/.test(event)) continue;

    const startValue = event.match(/\nDTSTART[^:]*:([^\r\n]+)/)?.[1];
    const endValue = event.match(/\nDTEND[^:]*:([^\r\n]+)/)?.[1];
    const start = startValue ? isoDate(startValue) : null;
    if (!start) continue;

    const isAllDay = /\nDTSTART[^:\r\n]*VALUE=DATE[^:\r\n]*:/.test(event);
    const parsedEnd = endValue ? isoDate(endValue) : null;

    if (!isAllDay) {
      booked.add(start);
      if (parsedEnd && parsedEnd > start) {
        let current = addDays(start, 1);
        let safety = 0;
        while (current <= parsedEnd && safety < 62) {
          booked.add(current);
          current = addDays(current, 1);
          safety += 1;
        }
      }
      continue;
    }

    const exclusiveEnd = parsedEnd ?? addDays(start, 1);
    let current = start;
    let safety = 0;

    while (current < exclusiveEnd && safety < 62) {
      booked.add(current);
      current = addDays(current, 1);
      safety += 1;
    }
  }

  const now = new Date();
  const minimum = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return [...booked].filter((date) => date >= minimum).sort();
};

const loadAvailability = async (): Promise<AvailabilityData> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(icalUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Google Calendar returned ${response.status}`);

    return {
      bookedDates: parseBookedDates(await response.text()),
      syncedAt: new Date().toISOString(),
      available: true,
    };
  } catch (error) {
    console.warn('[availability] Calendar synchronization failed:', error);
    return { bookedDates: [], syncedAt: null, available: false };
  } finally {
    clearTimeout(timeout);
  }
};

export const getAvailability = () => {
  availabilityPromise ??= loadAvailability();
  return availabilityPromise;
};
