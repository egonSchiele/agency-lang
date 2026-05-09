const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatWithTimezone(date: Date, timezone: string): string {
  // Get the offset for this date in the target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  });

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

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

function parseToDate(datetime: string): Date {
  const d = new Date(datetime);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date/time: "${datetime}"`);
  }
  return d;
}

// --- Current time ---

export function _now(timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  return formatWithTimezone(new Date(), tz);
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

export function _atTime(date: string, time: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  // Parse date (YYYY-MM-DD) and time (HH:MM or HH:MM:SS)
  const timeParts = time.split(":");
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1], 10);
  const second = timeParts[2] ? parseInt(timeParts[2], 10) : 0;

  // Create a date in the target timezone by trial
  // Start with a guess, then adjust
  const guess = new Date(`${date}T${time.padEnd(8, ":00")}Z`);
  const formatted = formatWithTimezone(guess, tz);

  // Check if the hour/minute match; if not, adjust for timezone offset
  const fParts = formatted.split("T")[1];
  const fHour = parseInt(fParts.slice(0, 2), 10);
  const fMinute = parseInt(fParts.slice(3, 5), 10);

  const hourDiff = hour - fHour;
  const minuteDiff = minute - fMinute;
  const totalDiffMs = (hourDiff * 60 + minuteDiff) * 60 * 1000;

  const adjusted = new Date(guess.getTime() + totalDiffMs);
  // Also adjust seconds
  const adjustedFormatted = formatWithTimezone(adjusted, tz);
  const finalParts = adjustedFormatted.split("T");
  const finalTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  const offset = finalParts[1].slice(8); // extract +/-HH:MM offset

  return `${date}T${finalTime}${offset}`;
}

// --- Range boundaries ---

export function _startOfDay(date?: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  const dateStr = date || _today(tz);
  return _atTime(dateStr, "00:00:00", tz);
}

export function _endOfDay(date?: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  const dateStr = date || _today(tz);
  return _atTime(dateStr, "23:59:59", tz);
}

export function _startOfWeek(date?: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  const dateStr = date || _today(tz);
  const d = new Date(dateStr + "T12:00:00Z"); // noon to avoid DST edge cases
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - day);
  const mondayDate = formatWithTimezone(d, tz).slice(0, 10);
  return _atTime(mondayDate, "00:00:00", tz);
}

export function _endOfWeek(date?: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  const dateStr = date || _today(tz);
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getDay();
  d.setDate(d.getDate() + (6 - day));
  const saturdayDate = formatWithTimezone(d, tz).slice(0, 10);
  return _atTime(saturdayDate, "23:59:59", tz);
}

export function _startOfMonth(date?: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  const dateStr = date || _today(tz);
  const monthDate = dateStr.slice(0, 8) + "01";
  return _atTime(monthDate, "00:00:00", tz);
}

export function _endOfMonth(date?: string, timezone?: string): string {
  const tz = timezone || getLocalTimezone();
  const dateStr = date || _today(tz);
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const lastDay = new Date(year, month, 0).getDate();
  const lastDate = `${dateStr.slice(0, 8)}${String(lastDay).padStart(2, "0")}`;
  return _atTime(lastDate, "23:59:59", tz);
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
