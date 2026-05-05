# calendar

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L3))

## Functions

### authorizeCalendar

```ts
authorizeCalendar(clientId: string, clientSecret: string): Result
```

Authorize access to Google Calendar. Opens a browser for the user to sign in and grant permission. Only needs to be run once — tokens are stored locally and refreshed automatically.

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
  import { tomorrow, atTime, endAfter, nextDayOfWeek, startOfWeek, endOfWeek } from "std::date"

  node main() {
    // "Tomorrow at 3pm for 1 hour"
    const start = atTime(tomorrow(), "15:00", "America/Los_Angeles")
    createEvent(summary: "Dentist", start: start, end: endAfter(start, 60))

    // "Next Monday at 10am for 30 min"
    const monday = atTime(nextDayOfWeek("monday"), "10:00")
    createEvent(summary: "1:1 with manager", start: monday, end: endAfter(monday, 30))

    // List all events this week
    const events = listEvents(timeMin: startOfWeek(), timeMax: endOfWeek())
    print(events)
  }
  ```

  You can also use `std::oauth` directly for more control over the
  authorization flow (e.g. custom scopes, port, or extra params):

  ```ts
  import { authorize, getAccessToken, isAuthorized } from "std::oauth"
  import { listEvents } from "std::calendar"

  node main() {
    if (!isAuthorized("google-calendar")) {
      authorize("google-calendar",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: env("GOOGLE_CLIENT_ID"),
        clientSecret: env("GOOGLE_CLIENT_SECRET"),
        scopes: "https://www.googleapis.com/auth/calendar",
        extraAuthParams: "access_type=offline prompt=consent"
      )
    }

    // std::calendar functions use the "google-calendar" OAuth token automatically
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
  the OAuth 2.0 authorization code flow with PKCE, stores tokens encrypted
  in `~/.agency/oauth/google-calendar.json` (encrypted via system keyring or
  `AGENCY_OAUTH_KEY` env var), and automatically refreshes expired tokens.

  ## Date/time formats
  - For timed events: ISO 8601 with timezone, e.g. "2026-05-10T10:00:00-07:00"
  - For all-day events: date only, e.g. "2026-05-10"
  - Note: for all-day events, `end` is exclusive. A single-day event on May 10
    should have start="2026-05-10" and end="2026-05-11".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| clientId | `string` |  |
| clientSecret | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L111))

### isCalendarAuthorized

```ts
isCalendarAuthorized(): boolean
```

Check if Google Calendar has been authorized. Returns true if OAuth tokens exist locally.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L122))

### listEvents

```ts
listEvents(maxResults: number, timeMin: string, timeMax: string, query: string, calendarId: string): Result
```

List upcoming events from Google Calendar. Returns an array of events with id, summary, description, location, start, end, and htmlLink. Parameters: maxResults (default 10), timeMin/timeMax (ISO 8601 datetime to filter range), query (free-text search), calendarId (default "primary").

**Parameters:**

| Name | Type | Default |
|---|---|---|
| maxResults | `number` | 10 |
| timeMin | `string` | "" |
| timeMax | `string` | "" |
| query | `string` | "" |
| calendarId | `string` | "primary" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L129))

### createEvent

```ts
createEvent(summary: string, start: string, end: string, description: string, location: string, calendarId: string): Result
```

Create a new event on Google Calendar. Parameters: summary (title), start (ISO 8601 datetime or YYYY-MM-DD for all-day), end (same format), description (optional), location (optional), calendarId (default "primary"). Returns the created event.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L148))

### updateEvent

```ts
updateEvent(eventId: string, summary: string, start: string, end: string, description: string, location: string, calendarId: string): Result
```

Update an existing event on Google Calendar. Pass the eventId and any fields to change. Empty strings are treated as "don't change". Returns the updated event.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L170))

### deleteEvent

```ts
deleteEvent(eventId: string, calendarId: string): Result
```

Delete an event from Google Calendar by its event ID. Returns { deleted: true } on success.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| eventId | `string` |  |
| calendarId | `string` | "primary" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/calendar.agency#L192))
