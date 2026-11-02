---
name: "calendar"
description: "Read and manage Google Calendar events."
---

# calendar

Read and write Google Calendar events from Agency code. Authorizes once
  via Google OAuth, then lists, creates, updates, and deletes events.

  Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (OAuth 2.0 desktop
  credentials from the Google Cloud console) for the example below.
  `authorizeCalendar` opens a browser for consent. Agency stores the tokens
  locally and refreshes them when possible.

  ```ts
  import { authorizeCalendar, isCalendarAuthorized, listEvents, createEvent } from "std::calendar"
  import { env } from "std::system"

  node main() {
    if (!isCalendarAuthorized()) {
      const clientId = env("GOOGLE_CLIENT_ID") with approve
      const clientSecret = env("GOOGLE_CLIENT_SECRET") with approve
      authorizeCalendar(clientId, clientSecret)
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

## Effects

### std::authorizeCalendar

```ts
@always(clientId)
effect std::authorizeCalendar {
  clientId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L50))

### std::listEvents

```ts
@always(calendarId)
effect std::listEvents {
  maxResults: number;
  calendarId: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L52))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L53))

### std::updateEvent

```ts
effect std::updateEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L54))

### std::deleteEvent

```ts
@always(calendarId)
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

Open the browser to authorize Google Calendar access.

Set up Google OAuth desktop credentials before authorizing. Tokens use
  the `google-calendar` provider in `std::auth/oauth` and refresh when
  possible. Use that module directly for custom scopes or callback ports.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| clientId | `string` |  | The client ID from Google OAuth desktop credentials. |
| clientSecret | `string` |  | The matching Google OAuth client secret. |

**Returns:** `Result`

**Throws:** `std::authorizeCalendar`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L64))

### isCalendarAuthorized

```ts
isCalendarAuthorized(): boolean
```

Check whether Google Calendar tokens are stored locally, without verifying their validity.

**Returns:** `boolean`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L79))

### listEvents

```ts
listEvents(
  maxResults: number = 10,
  timeMin: string = "",
  timeMax: string = "",
  query: string = "",
  calendarId: string = "primary",
): Result
```

List Google Calendar events in start-time order.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| maxResults | `number` | 10 |  |
| timeMin | `string` | "" | An ISO 8601 timestamp with timezone, or empty to start at the current time. |
| timeMax | `string` | "" | An ISO 8601 timestamp with timezone, or empty for no upper bound. |
| query | `string` | "" | Free-text terms to match against events. |
| calendarId | `string` | "primary" | Use "primary" for the signed-in user's primary calendar. |

**Returns:** `Result`

**Throws:** `std::listEvents`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L87))

### createEvent

```ts
createEvent(
  summary: string,
  start: string,
  end: string,
  description: string = "",
  location: string = "",
  calendarId: string = "primary",
): Result
```

Create a Google Calendar event.

For an all-day event, pass dates with an exclusive end date. For example,
  May 10 alone uses start `"2026-05-10"` and end `"2026-05-11"`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| summary | `string` |  |  |
| start | `string` |  | An ISO 8601 timestamp with timezone, or YYYY-MM-DD for an all-day event. |
| end | `string` |  | An ISO 8601 timestamp with timezone, or the exclusive end date for an all-day event. |
| description | `string` | "" |  |
| location | `string` | "" |  |
| calendarId | `string` | "primary" | Use "primary" for the signed-in user's primary calendar. |

**Returns:** `Result`

**Throws:** `std::createEvent`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L116))

### updateEvent

```ts
updateEvent(
  eventId: string,
  summary: string = "",
  start: string = "",
  end: string = "",
  description: string = "",
  location: string = "",
  calendarId: string = "primary",
): Result
```

Update the supplied fields of a Google Calendar event, leaving empty fields unchanged.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| eventId | `string` |  | The event id returned by a calendar listing or creation. |
| summary | `string` | "" |  |
| start | `string` | "" | A timestamp with timezone or all-day date, or empty to leave unchanged. |
| end | `string` | "" | A timestamp with timezone or exclusive all-day end date, or empty to leave unchanged. |
| description | `string` | "" |  |
| location | `string` | "" |  |
| calendarId | `string` | "primary" | The calendar containing the event. |

**Returns:** `Result`

**Throws:** `std::updateEvent`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L145))

### deleteEvent

```ts
deleteEvent(eventId: string, calendarId: string = "primary"): Result
```

Delete a Google Calendar event.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| eventId | `string` |  | The event id returned by a calendar listing or creation. |
| calendarId | `string` | "primary" | The calendar containing the event. |

**Returns:** `Result`

**Throws:** `std::deleteEvent`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/calendar.agency#L175))
