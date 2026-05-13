# calendar

## Usage

  ```ts
  import { authorizeCalendar, isCalendarAuthorized, listEvents, createEvent } from "std::calendar"
  import { env } from "std::system"

  node main() {
    // One-time: opens browser for Google OAuth consent.
    // This uses std::oauth under the hood — tokens are encrypted and
    // stored locally, and refreshed automatically on future runs.
    if (!isCalendarAuthorized()) {
      authorizeCalendar(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"))
    }

    // List upcoming events
    const events = listEvents()
    print(events)

    // Create a new event
    const event = createEvent(
      summary: "Team meeting",
      start: "2026-05-10T10:00:00-07:00",
      end: "2026-05-10T11:00:00-07:00",
      description: "Weekly sync",
      location: "Conference Room A"
    )
    print(event)
  }
  ```

  ### Using std::date for convenient date construction

  ```ts
  import { createEvent, listEvents } from "std::calendar"
  import { tomorrow, atTime, addMinutes, nextDayOfWeek, startOfWeek, endOfWeek } from "std::date"

  node main() {
    const tz = "America/Los_Angeles"

    // "Tomorrow at 3pm for 1 hour"
    const start = atTime(tomorrow(tz), "15:00", tz)
    createEvent(summary: "Dentist", start: start, end: addMinutes(start, 60))

    // "Next Monday at 10am for 30 min"
    const monday = atTime(nextDayOfWeek("monday", tz), "10:00", tz)
    createEvent(summary: "1:1 with manager", start: monday, end: addMinutes(monday, 30))

    // List all events this week
    const events = listEvents(timeMin: startOfWeek(), timeMax: endOfWeek())
    print(events)
  }
  ```

  You can also use `std::oauth` directly for more control over the
  authorization flow (e.g. custom scopes, port, or extra params):

  ```ts
  import { authorize, isAuthorized } from "std::oauth"
  import { env } from "std::system"
  import { listEvents } from "std::calendar"

  node main() {
    if (!isAuthorized("google-calendar")) {
      const clientId = env("GOOGLE_CLIENT_ID") catch ""
      const clientSecret = env("GOOGLE_CLIENT_SECRET") catch ""
      authorize("google-calendar",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: clientId,
        clientSecret: clientSecret,
        scopes: "https://www.googleapis.com/auth/calendar",
        extraAuthParams: "access_type=offline prompt=consent"
      )
    }

    const events = listEvents()
    print(events)
  }
  ```

  ## Setup
  1. Go to https://console.cloud.google.com
  2. Create a project (or use an existing one)
  3. Enable the Google Calendar API
  4. Create OAuth 2.0 credentials (Desktop app type)
  5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars
  6. Run your agent — it will open a browser for consent on first use

  ## Authentication
  `authorizeCalendar` is a convenience wrapper around `std::oauth`. It handles
  the OAuth 2.0 authorization code flow with PKCE, stores tokens in
  `~/.agency/oauth/google-calendar.json`, and automatically refreshes expired
  tokens. Tokens are encrypted at rest if a system keyring (macOS Keychain /
  Linux Secret Service) or `AGENCY_OAUTH_KEY` env var is available; otherwise
  they are stored as plaintext.

  ## Date/time formats
  - For timed events: ISO 8601 with timezone, e.g. "2026-05-10T10:00:00-07:00"
  - For all-day events: date only, e.g. "2026-05-10"
  - Note: for all-day events, `end` is exclusive. A single-day event on May 10
    should have start="2026-05-10" and end="2026-05-11".

## Types

### CalendarEvent

```ts
type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  htmlLink: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L107))

## Functions

### authorizeCalendar

```ts
authorizeCalendar(clientId: string, clientSecret: string): Result
```

Authorize access to Google Calendar. Opens a browser for the user to sign in and grant permission. Only needs to be run once — tokens are stored locally and refreshed automatically.

  @param clientId - Google OAuth client ID
  @param clientSecret - Google OAuth client secret

**Parameters:**

| Name | Type | Default |
|---|---|---|
| clientId | `string` |  |
| clientSecret | `string` |  |

**Returns:** `Result`

**Throws:** `std::authorizeCalendar`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L117))

### isCalendarAuthorized

```ts
isCalendarAuthorized(): boolean
```

Check if Google Calendar has been authorized. Returns true if OAuth tokens exist locally.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L131))

### listEvents

```ts
listEvents(maxResults: number, timeMin: string, timeMax: string, query: string, calendarId: string): Result
```

List upcoming events from Google Calendar. Returns an array of events with id, summary, description, location, start, end, and htmlLink. Parameters: maxResults (default 10), timeMin/timeMax (ISO 8601 datetime to filter range), query (free-text search), calendarId (default "primary").

  @param maxResults - Maximum number of events to return
  @param timeMin - Start of time range (ISO 8601)
  @param timeMax - End of time range (ISO 8601)
  @param query - Free-text search query
  @param calendarId - Calendar ID to query

**Parameters:**

| Name | Type | Default |
|---|---|---|
| maxResults | `number` | 10 |
| timeMin | `string` | "" |
| timeMax | `string` | "" |
| query | `string` | "" |
| calendarId | `string` | "primary" |

**Returns:** `Result`

**Throws:** `std::listEvents`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L138))

### createEvent

```ts
createEvent(summary: string, start: string, end: string, description: string, location: string, calendarId: string): Result
```

Create a new event on Google Calendar. Parameters: summary (title), start (ISO 8601 datetime or YYYY-MM-DD for all-day), end (same format), description (optional), location (optional), calendarId (default "primary"). Returns the created event.

  @param summary - Event title
  @param start - Start time (ISO 8601 or YYYY-MM-DD)
  @param end - End time (ISO 8601 or YYYY-MM-DD)
  @param description - Event description
  @param location - Event location
  @param calendarId - Calendar ID to create on

**Parameters:**

| Name | Type | Default |
|---|---|---|
| summary | `string` |  |
| start | `string` |  |
| end | `string` |  |
| description | `string` | "" |
| location | `string` | "" |
| calendarId | `string` | "primary" |

**Returns:** `Result`

**Throws:** `std::createEvent`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L163))

### updateEvent

```ts
updateEvent(eventId: string, summary: string, start: string, end: string, description: string, location: string, calendarId: string): Result
```

Update an existing event on Google Calendar. Pass the eventId and any fields to change. Empty strings are treated as "don't change". Returns the updated event.

  @param eventId - ID of the event to update
  @param summary - New title (empty to keep)
  @param start - New start time (empty to keep)
  @param end - New end time (empty to keep)
  @param description - New description (empty to keep)
  @param location - New location (empty to keep)
  @param calendarId - Calendar ID

**Parameters:**

| Name | Type | Default |
|---|---|---|
| eventId | `string` |  |
| summary | `string` | "" |
| start | `string` | "" |
| end | `string` | "" |
| description | `string` | "" |
| location | `string` | "" |
| calendarId | `string` | "primary" |

**Returns:** `Result`

**Throws:** `std::updateEvent`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L192))

### deleteEvent

```ts
deleteEvent(eventId: string, calendarId: string): Result
```

Delete an event from Google Calendar by its event ID. Returns { deleted: true } on success.

  @param eventId - ID of the event to delete
  @param calendarId - Calendar ID

**Parameters:**

| Name | Type | Default |
|---|---|---|
| eventId | `string` |  |
| calendarId | `string` | "primary" |

**Returns:** `Result`

**Throws:** `std::deleteEvent`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L222))
