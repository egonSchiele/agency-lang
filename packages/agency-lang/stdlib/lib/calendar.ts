import { _getAccessToken, _isAuthorized, _authorize } from "./oauth.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const PROVIDER_NAME = "google-calendar";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/calendar";

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  htmlLink: string;
};

export type CreateEventParams = {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
};

export type ListEventsParams = {
  calendarId?: string;
  maxResults?: number;
  timeMin?: string;
  timeMax?: string;
  query?: string;
};

export type UpdateEventParams = {
  eventId: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  calendarId?: string;
};

async function getToken(): Promise<string> {
  return _getAccessToken(PROVIDER_NAME);
}

function parseEventTime(dt: { dateTime?: string; date?: string }): string {
  return dt.dateTime || dt.date || "";
}

function formatEvent(raw: Record<string, unknown>): CalendarEvent {
  return {
    id: (raw.id as string) || "",
    summary: (raw.summary as string) || "",
    description: (raw.description as string) || "",
    location: (raw.location as string) || "",
    start: parseEventTime((raw.start as { dateTime?: string; date?: string }) || {}),
    end: parseEventTime((raw.end as { dateTime?: string; date?: string }) || {}),
    htmlLink: (raw.htmlLink as string) || "",
  };
}

function buildEventTime(datetime: string): { dateTime: string; timeZone?: string } | { date: string } {
  // If it looks like a date-only string (YYYY-MM-DD), use date field
  if (/^\d{4}-\d{2}-\d{2}$/.test(datetime)) {
    return { date: datetime };
  }
  return { dateTime: datetime };
}

export async function _authorizeCalendar(
  clientId: string,
  clientSecret: string
): Promise<{ success: boolean }> {
  return _authorize(PROVIDER_NAME, {
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    clientId,
    clientSecret,
    scopes: SCOPES,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  });
}

export async function _listEvents(
  params?: ListEventsParams
): Promise<CalendarEvent[]> {
  const token = await getToken();
  const calendarId = params?.calendarId || "primary";

  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  if (params?.maxResults) url.searchParams.set("maxResults", String(params.maxResults));
  if (params?.timeMin) url.searchParams.set("timeMin", params.timeMin);
  if (params?.timeMax) url.searchParams.set("timeMax", params.timeMax);
  if (params?.query) url.searchParams.set("q", params.query);

  if (!params?.timeMin) {
    url.searchParams.set("timeMin", new Date().toISOString());
  }
  if (!params?.maxResults) {
    url.searchParams.set("maxResults", "10");
  }

  const response = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${token}` },
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await response.json() as { items?: Record<string, unknown>[] };
  return (data.items || []).map(formatEvent);
}

export async function _createEvent(
  params: CreateEventParams
): Promise<CalendarEvent> {
  const token = await getToken();
  const calendarId = params.calendarId || "primary";

  const body: Record<string, unknown> = {
    summary: params.summary,
    start: buildEventTime(params.start),
    end: buildEventTime(params.end),
  };

  if (params.description) body.description = params.description;
  if (params.location) body.location = params.location;
  if (params.attendees) {
    body.attendees = params.attendees.map((email) => ({ email }));
  }

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${responseBody.slice(0, 200)}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return formatEvent(data);
}

export async function _updateEvent(
  params: UpdateEventParams
): Promise<CalendarEvent> {
  const token = await getToken();
  const calendarId = params.calendarId || "primary";

  const body: Record<string, unknown> = {};
  if (params.summary) body.summary = params.summary;
  if (params.start) body.start = buildEventTime(params.start);
  if (params.end) body.end = buildEventTime(params.end);
  if (params.description) body.description = params.description;
  if (params.location) body.location = params.location;

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${responseBody.slice(0, 200)}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return formatEvent(data);
}

export async function _deleteEvent(
  eventId: string,
  calendarId?: string
): Promise<{ deleted: boolean }> {
  const token = await getToken();
  const cal = calendarId || "primary";

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
    }
  );

  if (!response.ok && response.status !== 410) {
    const responseBody = await response.text();
    throw new Error(`Google Calendar API error (${response.status}): ${responseBody.slice(0, 200)}`);
  }

  return { deleted: true };
}

export async function _isCalendarAuthorized(): Promise<boolean> {
  return _isAuthorized(PROVIDER_NAME);
}
