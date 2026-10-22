// Sources: commune's rental contract (19.04.2025), Canton of Bern RSB 555.1.
export type Period = 'journee' | 'soiree' | 'complet' | 'consecutif';
export type PaymentMethod = 'ebanking' | 'twint';
export type Holiday = { date: string; name: string };

const names = {
  fr: ['Nouvel An', 'Saint-Berthold', 'Vendredi saint', 'Pâques', 'Lundi de Pâques', 'Ascension', 'Pentecôte', 'Lundi de Pentecôte', 'Fête nationale', 'Jeûne fédéral', 'Noël', 'Saint-Étienne'],
  de: ['Neujahr', 'Berchtoldstag', 'Karfreitag', 'Ostern', 'Ostermontag', 'Auffahrt', 'Pfingsten', 'Pfingstmontag', 'Bundesfeier', 'Eidgenössischer Dank-, Buss- und Bettag', 'Weihnachten', 'Stephanstag'],
  en: ["New Year’s Day", 'Berchtold’s Day', 'Good Friday', 'Easter Sunday', 'Easter Monday', 'Ascension Day', 'Whit Sunday', 'Whit Monday', 'Swiss National Day', 'Federal Day of Thanksgiving', 'Christmas Day', 'St Stephen’s Day'],
};

export const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && isoDate(date) === value;
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

export function bernHolidays(year: number, locale: keyof typeof names = 'fr'): Holiday[] {
  if (!Number.isInteger(year) || year < 1900 || year > 2199) return [];
  // Gregorian Easter, Meeus/Jones/Butcher algorithm, calculated for every year.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = isoDate(new Date(Date.UTC(year, month - 1, day, 12)));
  const firstSeptember = new Date(Date.UTC(year, 8, 1, 12));
  const fastingDay = 1 + ((7 - firstSeptember.getUTCDay()) % 7) + 14;
  const dates = [
    `${year}-01-01`, `${year}-01-02`, addDays(easter, -2), easter,
    addDays(easter, 1), addDays(easter, 39), addDays(easter, 49), addDays(easter, 50),
    `${year}-08-01`, `${year}-09-${String(fastingDay).padStart(2, '0')}`, `${year}-12-25`, `${year}-12-26`,
  ];
  return dates.map((date, index) => ({ date, name: names[locale][index]! })).sort((x, y) => x.date.localeCompare(y.date));
}

export function holidayForDate(date: string, locale: keyof typeof names = 'fr') {
  return validDate(date) ? bernHolidays(Number(date.slice(0, 4)), locale).find((holiday) => holiday.date === date) : undefined;
}

export function weekendRate(date: string) {
  if (!validDate(date)) return false;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 5 || weekday === 6 || Boolean(holidayForDate(date));
}

export type Rental = {
  date: string; period: Period; days: number; people: number;
  pizza: boolean; wood: boolean; cleaning: boolean;
};

export function rentalPrice(rental: Rental, verifiedMember = false) {
  const base = rental.period === 'consecutif' ? rental.days * 16000
    : rental.period === 'complet' ? (weekendRate(rental.date) ? 19000 : 15000) : 9000;
  const discount = verifiedMember ? Math.round(base * .2) : 0;
  const deposit = verifiedMember ? 0 : 15000;
  const options = deposit + (rental.pizza ? 5000 : 0) + (rental.wood ? 3000 : 0);
  return { base, discount, deposit, options, total: base - discount + options };
}

export function rentalDates(rental: Pick<Rental, 'date' | 'period' | 'days'>) {
  return Array.from({ length: rental.period === 'consecutif' ? rental.days : 1 }, (_, index) => addDays(rental.date, index));
}

export function swissToday(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function holdDeadline(createdAt: Date, rentalDate: string, period: Period = 'complet') {
  const deadline = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  // Convert the local rental start into UTC, including the Swiss DST offset.
  const hour = period === 'soiree' ? 18 : 10;
  const probe = new Date(`${rentalDate}T${hour}:00:00Z`);
  const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(probe));
  const start = new Date(probe.getTime() - (localHour - hour) * 3600000);
  return (deadline < start ? deadline : start).toISOString();
}
