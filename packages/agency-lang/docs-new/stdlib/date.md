# date

## Date and Time Utilities

  Helpers for constructing timezone-aware ISO 8601 date strings — the format
  used by APIs like Google Calendar. All functions return strings, not Date objects.

  ### Getting the current time

  ```ts
  import { now, today, tomorrow } from "std::date"

  node main() {
    print(now())        // "2026-05-05T10:30:00-07:00"
    print(today())      // "2026-05-05"
    print(tomorrow())   // "2026-05-06"
  }
  ```

  ### Building dates for calendar events

  ```ts
  import { atTime, addMinutes, tomorrow, nextDayOfWeek } from "std::date"
  import { createEvent } from "std::calendar"

  node main() {
    // "Tomorrow at 3pm Pacific for 1 hour"
    const tz = "America/Los_Angeles"
    const start = atTime(tomorrow(tz), "15:00", tz)
    createEvent(summary: "Dentist", start: start, end: addMinutes(start, 60))

    // "Next Tuesday at 10am for 30 min"
    const tuesday = nextDayOfWeek("tuesday", tz)
    const meetingStart = atTime(tuesday, "10:00", tz)
    createEvent(summary: "Team sync", start: meetingStart, end: addMinutes(meetingStart, 30))
  }
  ```

  ### Querying date ranges

  ```ts
  import { startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "std::date"
  import { listEvents } from "std::calendar"

  node main() {
    // All events this week
    const events = listEvents(timeMin: startOfWeek(), timeMax: endOfWeek())
    print(events)

    // All events this month
    const monthly = listEvents(timeMin: startOfMonth(), timeMax: endOfMonth())
    print(monthly)
  }
  ```

  ### Date arithmetic

  ```ts
  import { now, addHours, addDays, addMinutes } from "std::date"

  node main() {
    const inTwoHours = addHours(now(), 2)
    const nextWeek = addDays(now(), 7)
    const in90min = addMinutes(now(), 90)
    print(inTwoHours)
    print(nextWeek)
    print(in90min)
  }
  ```

  ### Timezone parameter
  Most functions accept an optional `timezone` parameter (IANA timezone name).
  If omitted, your system's local timezone is used.
  Examples: "America/New_York", "Europe/London", "Asia/Tokyo", "America/Los_Angeles"

## Functions

### now

```ts
now(timezone: string): string
```

Get the current date and time as a timezone-aware ISO 8601 string (e.g. "2026-05-05T10:30:00-07:00"). Uses local timezone by default, or pass a timezone like "America/New_York".

Get the current date and time as an ISO 8601 string with timezone offset.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L79))

### today

```ts
today(timezone: string): string
```

Get today's date as a YYYY-MM-DD string (e.g. "2026-05-05"). Uses local timezone by default.

Get today's date as a YYYY-MM-DD string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L87))

### tomorrow

```ts
tomorrow(timezone: string): string
```

Get tomorrow's date as a YYYY-MM-DD string (e.g. "2026-05-06"). Uses local timezone by default.

Get tomorrow's date as a YYYY-MM-DD string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L95))

### add

```ts
add(datetime: string, ms: number): string
```

Add a duration in milliseconds to a datetime string. Returns a new ISO 8601 datetime string. Use with unit literals for clarity: add(now(), 2h), add(start, 30m), add(start, 7d). Negative values subtract.

  @param datetime - The ISO 8601 datetime string
  @param ms - Duration in milliseconds (e.g. 2h, 30m, 7d)

Add a duration to a datetime string. Use with unit literals: add(now(), 2h), add(start, 7d)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| ms | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L103))

### addMinutes

```ts
addMinutes(datetime: string, minutes: number): string
```

Add minutes to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract minutes.

  @param datetime - The ISO 8601 datetime string
  @param minutes - Number of minutes to add (negative to subtract)

Add minutes to a datetime string and return the new datetime.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| minutes | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L114))

### addHours

```ts
addHours(datetime: string, hours: number): string
```

Add hours to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract hours.

  @param datetime - The ISO 8601 datetime string
  @param hours - Number of hours to add (negative to subtract)

Add hours to a datetime string and return the new datetime.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| hours | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L125))

### addDays

```ts
addDays(datetime: string, days: number): string
```

Add days to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract days. Note: adds a fixed 24 hours per day — on DST transition days the wall-clock time may shift by an hour. For DST-safe day arithmetic, compute the target date separately and use atTime().

  @param datetime - The ISO 8601 datetime string
  @param days - Number of days to add (negative to subtract)

Add days to a datetime string and return the new datetime. Note: adds a fixed 24 hours per day, which may shift the wall-clock time by an hour on DST transition days. For DST-safe day arithmetic, use atTime with a date string instead.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| days | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L136))

### nextDayOfWeek

```ts
nextDayOfWeek(day: string, timezone: string): string
```

Get the next occurrence of a given day of the week as a YYYY-MM-DD string. For example, nextDayOfWeek("tuesday") returns the date of next Tuesday. Valid days: sunday, monday, tuesday, wednesday, thursday, friday, saturday.

  @param day - The day of the week
  @param timezone - The timezone to use

Get the date of the next occurrence of a day of the week (e.g. "monday").

**Parameters:**

| Name | Type | Default |
|---|---|---|
| day | `string` |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L147))

### atTime

```ts
atTime(date: string, time: string, timezone: string): string
```

Combine a date and time into a full timezone-aware ISO 8601 string. For example, atTime("2026-05-10", "15:00", "America/Los_Angeles") returns "2026-05-10T15:00:00-07:00". Uses local timezone if not specified.

  @param date - The date string (YYYY-MM-DD)
  @param time - The time string (HH:MM)
  @param timezone - The timezone to use

Combine a date (YYYY-MM-DD) and time (HH:MM) into a timezone-aware ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` |  |
| time | `string` |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L158))

### startOfDay

```ts
startOfDay(date: string, timezone: string): string
```

Get midnight (00:00:00) of a given date as a timezone-aware ISO 8601 string. Uses today if no date provided.

  @param date - The date string
  @param timezone - The timezone to use

Get the start of the day (midnight) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L170))

### endOfDay

```ts
endOfDay(date: string, timezone: string): string
```

Get the end of the day (23:59:59) of a given date as a timezone-aware ISO 8601 string. Uses today if no date provided.

  @param date - The date string
  @param timezone - The timezone to use

Get the end of the day (23:59:59) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L181))

### startOfWeek

```ts
startOfWeek(date: string, timezone: string): string
```

Get midnight on Sunday of the week containing the given date. Uses this week if no date provided.

  @param date - A date within the week
  @param timezone - The timezone to use

Get the start of the current week (Sunday midnight) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L192))

### endOfWeek

```ts
endOfWeek(date: string, timezone: string): string
```

Get 23:59:59 on Saturday of the week containing the given date. Uses this week if no date provided.

  @param date - A date within the week
  @param timezone - The timezone to use

Get the end of the current week (Saturday 23:59:59) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L203))

### startOfMonth

```ts
startOfMonth(date: string, timezone: string): string
```

Get midnight on the 1st of the month containing the given date. Uses this month if no date provided.

  @param date - A date within the month
  @param timezone - The timezone to use

Get the start of the month (1st at midnight) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L214))

### endOfMonth

```ts
endOfMonth(date: string, timezone: string): string
```

Get 23:59:59 on the last day of the month containing the given date. Uses this month if no date provided.

  @param date - A date within the month
  @param timezone - The timezone to use

Get the end of the month (last day at 23:59:59) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L225))
