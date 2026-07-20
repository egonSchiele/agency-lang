const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function resolveTz(timezone?: string): string {
  return timezone || getLocalTimezone();
}

function formatWithTimezone(
  date: Date,
  timezone: string,
  includeMillis: boolean = false,
): string {
  // Get the offset for this date in the target timezone
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  };
  if (includeMillis) {
    options.fractionalSecondDigits = 3;
  }
  const formatter = new Intl.DateTimeFormat("en-US", options);

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") === "24" ? "00" : get("hour");
  const minute = get("minute");
  const second = get("second");

  // Extract offset from timeZoneName (e.g., "GMT-07:00" or "GMT+05:30")
  const tzName = get("timeZoneName");
  let offset: string;
  if (tzName === "GMT" || tzName === "UTC") {
    offset = "+00:00";
  } else {
    const match = tzName.match(/GMT([+-]\d{2}:\d{2})/);
    offset = match ? match[1] : "+00:00";
  }

  const frac = includeMillis
    ? `.${(get("fractionalSecond") || "000").padEnd(3, "0")}`
    : "";

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${frac}${offset}`;
}

function parseToDate(datetime: string): Date {
  const d = new Date(datetime);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date/time: "${datetime}"`);
  }
  return d;
}

// --- Bridges between instants (numbers) and strings ---

export function _format(ms: number, timezone?: string): string {
  return formatWithTimezone(new Date(ms), resolveTz(timezone), true);
}

export function _formatDate(ms: number, timezone?: string): string {
  return formatWithTimezone(new Date(ms), resolveTz(timezone)).slice(0, 10);
}

export function _parse(iso: string): number {
  // parseToDate throws when new Date(iso) is NaN.
  return parseToDate(iso).getTime();
}

// --- Current time ---

export function _now(): number {
  return Date.now();
}

export function _today(timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  return formatWithTimezone(new Date(), tz).slice(0, 10);
}

export function _tomorrow(timezone?: string): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const tz = timezone || getLocalTimezone();
  return formatWithTimezone(d, tz).slice(0, 10);
}

// --- Date arithmetic ---

export function _add(datetime: string, ms: number): string {
  const d = parseToDate(datetime);
  d.setTime(d.getTime() + ms);
  const offset = extractOffset(datetime);
  if (offset) {
    return formatWithOffset(d, offset);
  }
  return d.toISOString();
}

export function _addMinutes(datetime: string, minutes: number): string {
  const d = parseToDate(datetime);
  d.setTime(d.getTime() + minutes * 60 * 1000);

  // Preserve the timezone offset from the input
  const offset = extractOffset(datetime);
  if (offset) {
    return formatWithOffset(d, offset);
  }
  return d.toISOString();
}

export function _addHours(datetime: string, hours: number): string {
  return _addMinutes(datetime, hours * 60);
}

// NOTE: This adds a fixed 24 hours per day. On DST transition days, a
// calendar day is 23 or 25 hours, so the wall-clock time may shift by
// an hour. To avoid this, use _atTime with a timezone-aware date instead.
export function _addDays(datetime: string, days: number): string {
  return _addMinutes(datetime, days * 24 * 60);
}

// --- Relative dates ---

export function _nextDayOfWeek(dayName: string, timezone?: string): string {
  const target = DAYS_OF_WEEK.indexOf(dayName.toLowerCase());
  if (target === -1) {
    throw new Error(
      `Invalid day of week: "${dayName}". Use: ${DAYS_OF_WEEK.join(", ")}`
    );
  }

  const now = new Date();
  const current = now.getDay();
  let daysAhead = target - current;
  if (daysAhead <= 0) daysAhead += 7;

  now.setDate(now.getDate() + daysAhead);
  const tz = timezone || getLocalTimezone();
  return formatWithTimezone(now, tz).slice(0, 10);
}

// --- Combining date + time + timezone ---

// The timezone offset (ms east of UTC) in effect at a given instant. EDT
// (-04:00) is -14400000. Parsed from the offset formatWithTimezone renders.
function offsetMsInTz(instant: number, tz: string): number {
  const match = formatWithTimezone(new Date(instant), tz).match(
    /([+-])(\d{2}):(\d{2})$/,
  );
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10)) * 60000;
}

export function _atTime(date: string, time: string, timezone?: string): number {
  const tz = resolveTz(timezone);
  // The wall-clock time treated as if it were UTC. `wall = utc + offset`, so
  // the real instant is `wallAsUtc - offset`.
  const wallAsUtc = Date.parse(`${date}T${time.padEnd(8, ":00").slice(0, 8)}Z`);
  const offset = offsetMsInTz(wallAsUtc, tz);
  const instant = wallAsUtc - offset;
  // Near a DST transition the offset at the candidate instant can differ from
  // the offset at `wallAsUtc`; recompute once against the candidate.
  const settled = offsetMsInTz(instant, tz);
  return settled === offset ? instant : wallAsUtc - settled;
}

// --- Range boundaries ---

// Weekday of a calendar-date string, machine-independent: getUTCDay() on a
// noon-UTC instant. Never getDay(), which reads the runner's local timezone
// and is off by one on far-east zones. 0 = Sunday.
function weekdayOf(dateStr: string): number {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

// Date-string transforms: "YYYY-MM-DD" -> "YYYY-MM-DD", timezone-independent
// because the input is already the tz-local calendar date.
function sundayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - weekdayOf(dateStr));
  return d.toISOString().slice(0, 10);
}
function saturdayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + (6 - weekdayOf(dateStr)));
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + "01";
}
function lastOfMonth(dateStr: string): string {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10); // 1-indexed
  // Date.UTC(y, month, 0) is day 0 of the NEXT month = the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${dateStr.slice(0, 8)}${String(lastDay).padStart(2, "0")}`;
}

// The one place the four-step "instant -> date -> transform -> re-pin" pipeline
// lives. `edge` picks midnight (start) or the last millisecond of the day (end).
function boundary(
  instant: number,
  timezone: string | undefined,
  toDate: (dateStr: string) => string,
  edge: "start" | "end",
): number {
  const tz = resolveTz(timezone);
  const dateStr = toDate(_formatDate(instant, tz));
  return edge === "start"
    ? _atTime(dateStr, "00:00:00", tz)
    : _atTime(dateStr, "23:59:59", tz) + 999; // last ms of the day
}

export function _startOfDay(instant: number, timezone?: string): number {
  return boundary(instant, timezone, (d) => d, "start");
}
export function _endOfDay(instant: number, timezone?: string): number {
  return boundary(instant, timezone, (d) => d, "end");
}
export function _startOfWeek(instant: number, timezone?: string): number {
  return boundary(instant, timezone, sundayOf, "start");
}
export function _endOfWeek(instant: number, timezone?: string): number {
  return boundary(instant, timezone, saturdayOf, "end");
}
export function _startOfMonth(instant: number, timezone?: string): number {
  return boundary(instant, timezone, firstOfMonth, "start");
}
export function _endOfMonth(instant: number, timezone?: string): number {
  return boundary(instant, timezone, lastOfMonth, "end");
}

// --- Utility ---

function extractOffset(datetime: string): string | null {
  // Match +HH:MM or -HH:MM at end of string
  const match = datetime.match(/([+-]\d{2}:\d{2})$/);
  if (match) return match[1];
  // Match Z (UTC)
  if (datetime.endsWith("Z")) return "+00:00";
  return null;
}

function formatWithOffset(date: Date, offset: string): string {
  // Parse offset to minutes
  const sign = offset[0] === "-" ? -1 : 1;
  const hours = parseInt(offset.slice(1, 3), 10);
  const mins = parseInt(offset.slice(4, 6), 10);
  const offsetMs = sign * (hours * 60 + mins) * 60 * 1000;

  // Get the local time in the target offset
  const localTime = new Date(date.getTime() + offsetMs);
  const iso = localTime.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ

  return `${iso.slice(0, 19)}${offset}`;
}
