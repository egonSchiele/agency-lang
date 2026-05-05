import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _listEvents, _createEvent, _updateEvent, _deleteEvent, _isCalendarAuthorized, _authorizeCalendar } from "../calendar.js";

// Mock the oauth module
const mockAuthorize = vi.fn().mockResolvedValue({ success: true });
const mockIsAuthorized = vi.fn().mockResolvedValue(true);

vi.mock("../oauth.js", () => ({
  _getAccessToken: vi.fn().mockResolvedValue("mock-access-token"),
  _isAuthorized: (...args: unknown[]) => mockIsAuthorized(...args),
  _authorize: (...args: unknown[]) => mockAuthorize(...args),
}));

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("_listEvents", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches upcoming events from primary calendar", async () => {
    const mockFetch = mockFetchResponse({
      items: [
        {
          id: "evt1",
          summary: "Team standup",
          description: "Daily sync",
          location: "Room A",
          start: { dateTime: "2026-05-10T09:00:00-07:00" },
          end: { dateTime: "2026-05-10T09:30:00-07:00" },
          htmlLink: "https://calendar.google.com/event?eid=evt1",
        },
      ],
    });
    globalThis.fetch = mockFetch;

    const events = await _listEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: "evt1",
      summary: "Team standup",
      description: "Daily sync",
      location: "Room A",
      start: "2026-05-10T09:00:00-07:00",
      end: "2026-05-10T09:30:00-07:00",
      htmlLink: "https://calendar.google.com/event?eid=evt1",
    });
  });

  it("sends auth token in header", async () => {
    const mockFetch = mockFetchResponse({ items: [] });
    globalThis.fetch = mockFetch;

    await _listEvents();

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["Authorization"]).toBe("Bearer mock-access-token");
  });

  it("passes query params", async () => {
    const mockFetch = mockFetchResponse({ items: [] });
    globalThis.fetch = mockFetch;

    await _listEvents({
      maxResults: 5,
      timeMin: "2026-05-01T00:00:00Z",
      timeMax: "2026-05-31T23:59:59Z",
      query: "standup",
    });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("maxResults")).toBe("5");
    expect(parsed.searchParams.get("timeMin")).toBe("2026-05-01T00:00:00Z");
    expect(parsed.searchParams.get("timeMax")).toBe("2026-05-31T23:59:59Z");
    expect(parsed.searchParams.get("q")).toBe("standup");
  });

  it("handles all-day events", async () => {
    globalThis.fetch = mockFetchResponse({
      items: [
        {
          id: "evt2",
          summary: "Vacation",
          start: { date: "2026-06-01" },
          end: { date: "2026-06-08" },
        },
      ],
    });

    const events = await _listEvents();
    expect(events[0].start).toBe("2026-06-01");
    expect(events[0].end).toBe("2026-06-08");
  });

  it("throws on API error", async () => {
    globalThis.fetch = mockFetchResponse({ error: { message: "Not Found" } }, 404);
    await expect(_listEvents()).rejects.toThrow("Google Calendar API error (404)");
  });
});

describe("_createEvent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a timed event", async () => {
    const mockFetch = mockFetchResponse({
      id: "new-evt",
      summary: "Lunch",
      start: { dateTime: "2026-05-10T12:00:00-07:00" },
      end: { dateTime: "2026-05-10T13:00:00-07:00" },
    });
    globalThis.fetch = mockFetch;

    const event = await _createEvent({
      summary: "Lunch",
      start: "2026-05-10T12:00:00-07:00",
      end: "2026-05-10T13:00:00-07:00",
      description: "Team lunch",
      location: "Cafe",
    });

    expect(event.id).toBe("new-evt");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/calendars/primary/events");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    expect(body.summary).toBe("Lunch");
    expect(body.start).toEqual({ dateTime: "2026-05-10T12:00:00-07:00" });
    expect(body.end).toEqual({ dateTime: "2026-05-10T13:00:00-07:00" });
    expect(body.description).toBe("Team lunch");
    expect(body.location).toBe("Cafe");
  });

  it("creates an all-day event", async () => {
    const mockFetch = mockFetchResponse({
      id: "allday",
      summary: "Holiday",
      start: { date: "2026-12-25" },
      end: { date: "2026-12-26" },
    });
    globalThis.fetch = mockFetch;

    await _createEvent({
      summary: "Holiday",
      start: "2026-12-25",
      end: "2026-12-26",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.start).toEqual({ date: "2026-12-25" });
    expect(body.end).toEqual({ date: "2026-12-26" });
  });

  it("includes attendees when provided", async () => {
    const mockFetch = mockFetchResponse({ id: "evt", summary: "Meeting" });
    globalThis.fetch = mockFetch;

    await _createEvent({
      summary: "Meeting",
      start: "2026-05-10T10:00:00Z",
      end: "2026-05-10T11:00:00Z",
      attendees: ["alice@example.com", "bob@example.com"],
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.attendees).toEqual([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
  });
});

describe("_updateEvent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("patches an event with PATCH method", async () => {
    const mockFetch = mockFetchResponse({
      id: "evt1",
      summary: "Updated title",
      start: { dateTime: "2026-05-10T10:00:00Z" },
      end: { dateTime: "2026-05-10T11:00:00Z" },
    });
    globalThis.fetch = mockFetch;

    await _updateEvent({ eventId: "evt1", summary: "Updated title" });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/events/evt1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body.summary).toBe("Updated title");
  });
});

describe("_deleteEvent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends DELETE request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    globalThis.fetch = mockFetch;

    const result = await _deleteEvent("evt1");

    expect(result).toEqual({ deleted: true });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/events/evt1");
    expect(init.method).toBe("DELETE");
  });

  it("treats 410 Gone as success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 410, text: async () => "Gone" });
    const result = await _deleteEvent("evt-gone");
    expect(result).toEqual({ deleted: true });
  });
});

describe("_isCalendarAuthorized", () => {
  it("delegates to _isAuthorized with google-calendar provider", async () => {
    const result = await _isCalendarAuthorized();
    expect(result).toBe(true);
    expect(mockIsAuthorized).toHaveBeenCalledWith("google-calendar");
  });
});

describe("_authorizeCalendar", () => {
  it("calls _authorize with correct Google config", async () => {
    await _authorizeCalendar("my-client-id", "my-client-secret");

    expect(mockAuthorize).toHaveBeenCalledWith("google-calendar", {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "my-client-id",
      clientSecret: "my-client-secret",
      scopes: "https://www.googleapis.com/auth/calendar",
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    });
  });
});

describe("_updateEvent empty string handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits empty-string fields from PATCH body", async () => {
    const mockFetch = mockFetchResponse({
      id: "evt1",
      summary: "Unchanged",
      start: { dateTime: "2026-05-10T10:00:00Z" },
      end: { dateTime: "2026-05-10T11:00:00Z" },
    });
    globalThis.fetch = mockFetch;

    await _updateEvent({
      eventId: "evt1",
      summary: "New title",
      start: "",
      end: "",
      description: "",
      location: "",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.summary).toBe("New title");
    expect(body).not.toHaveProperty("start");
    expect(body).not.toHaveProperty("end");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("location");
  });
});
