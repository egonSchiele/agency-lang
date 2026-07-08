---
name: "calendar"
---

# calendar

Read and write Google Calendar events from Agency code. Authorizes once
  via Google OAuth, then lists, creates, updates, and deletes events.

  Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (OAuth 2.0 desktop
  credentials from the Google Cloud console). The first run opens a browser
  for consent. Agency stores the tokens locally and refreshes them automatically.

  ```ts
  import { authorizeCalendar, isCalendarAuthorized, listEvents, createEvent } from "std::calendar"
  import { env } from "std::system"

  node main() {
    if (!isCalendarAuthorized()) {
      authorizeCalendar(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"))
    }

    print(listEvents())

    createEvent(
      summary: "Team meeting",
      start: "2026-05-10T10:00:00-07:00",
      end: "2026-05-10T11:00:00-07:00"
    )
  }
  ```

  Times use ISO 8601 with a timezone (e.g. "2026-05-10T10:00:00-07:00"), or a
  date only (e.g. "2026-05-10") for all-day events. Pair with `std::date`
  helpers like `tomorrow` and `atTime` for convenient date construction.

## Types

## Effects

### std::authorizeCalendar

```ts
effect std::authorizeCalendar {
  clientId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L52))

### std::listEvents

```ts
effect std::listEvents {
  maxResults: number;
  calendarId: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L53))

### std::createEvent

```ts
effect std::createEvent {
  summary: string;
  start: string;
  end: string;
  description: string;
  location: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L54))

### std::updateEvent

```ts
effect std::updateEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L55))

### std::deleteEvent

```ts
effect std::deleteEvent {
  eventId: string;
  calendarId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L56))

## Functions

### authorizeCalendar

```ts
authorizeCalendar(clientId: string, clientSecret: string): Result
```

Authorize access to Google Calendar. Opens a browser for the user to sign in and grant permission. Only needs to be run once. Agency stores the tokens locally and refreshes them automatically.

  @param clientId - Google OAuth client ID
  @param clientSecret - Google OAuth client secret

**Parameters:**

| Name | Type | Default |
|---|---|---|
| clientId | `string` |  |
| clientSecret | `string` |  |

**Returns:** `Result`

**Throws:** `std::authorizeCalendar`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L58))

### isCalendarAuthorized

```ts
isCalendarAuthorized(): boolean
```

Check if Google Calendar has been authorized. Returns true if OAuth tokens exist locally.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L72))

### listEvents

```ts
listEvents(maxResults: number, timeMin: string, timeMax: string, query: string, calendarId: string): Result
```

List upcoming events from Google Calendar. Returns an array of events, each with id, summary, description, location, start, end, and htmlLink.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L79))

### createEvent

```ts
createEvent(summary: string, start: string, end: string, description: string, location: string, calendarId: string): Result
```

Create a new event on Google Calendar. Returns the created event.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L104))

### updateEvent

```ts
updateEvent(eventId: string, summary: string, start: string, end: string, description: string, location: string, calendarId: string): Result
```

Update an existing event on Google Calendar. Pass the eventId and any fields to change. An empty string means "don't change". Returns the updated event.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L133))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L163))
