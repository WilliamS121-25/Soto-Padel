/**
 * Times inside the domain are "minutes from midnight" integers so that all slot
 * arithmetic is plain integer maths with no timezone or DST surprises. Dates are
 * kept as `YYYY-MM-DD` strings and are only interpreted in the club's local
 * calendar — the app never converts between zones.
 */

export const SLOT_MINUTES = 30;

/** Parse `HH:MM` (24h) into minutes from midnight. */
export function parseTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}"`);
  return hours * 60 + minutes;
}

/** Format minutes from midnight as `HH:MM`. */
export function formatTime(minutes: number): string {
  const normalised = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalised / 60);
  const mins = normalised % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** Inclusive-start, exclusive-end label, e.g. "18:30-19:00". */
export function formatSlotRange(startMinutes: number, slots = 1): string {
  return `${formatTime(startMinutes)}-${formatTime(startMinutes + slots * SLOT_MINUTES)}`;
}

/** Round a time up to the next 30-minute boundary. */
export function roundUpToSlot(minutes: number): number {
  return Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}

/** Human duration for a number of 30-minute slots, e.g. 3 -> "1h30". */
export function formatSlotCount(slots: number): string {
  const total = slots * SLOT_MINUTES;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h${String(mins).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a `YYYY-MM-DD` club-local date as e.g. "Friday 28 Aug 2025".
 *
 * Built from the date parts with a fixed name table rather than `toLocaleDateString`
 * so output never shifts with the host timezone or available ICU data.
 */
export function formatDateLong(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  const monthName = MONTHS[month - 1] ?? "";
  return `${weekday} ${day} ${monthName} ${year}`;
}
