---
name: "date"
description: "Builds timezone-aware ISO 8601 date strings, the format that APIs like Google Calendar expect."
---

# date

Builds timezone-aware ISO 8601 date strings, the format that APIs like Google
Calendar expect. Every function returns a string, not a Date object. Most
accept an optional IANA `timezone` (e.g. "America/New_York"). Omit it to
use your local timezone.

```ts
import { atTime, addMinutes, tomorrow } from "std::date"
import { createEvent } from "std::calendar"

node main() {
  // Tomorrow at 3pm Pacific for one hour
  const tz = "America/Los_Angeles"
  const start = atTime(tomorrow(tz), "15:00", tz)
  createEvent(summary: "Dentist", start: start, end: addMinutes(start, 60))
}
```

## Types

### DayOfWeek

A day of the week, lowercase.

```ts
/** A day of the week, lowercase. */
export type DayOfWeek =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L24))

## Functions

### now

```ts
now(timezone: string = ""): string
```

Get the current date and time as a timezone-aware ISO 8601 string (e.g. "2026-05-05T10:30:00-07:00").

  @param timezone - IANA timezone name like "America/New_York" (defaults to the local timezone)

Get the current date and time as an ISO 8601 string with timezone offset.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L27))

### today

```ts
today(timezone: string = ""): string
```

Get today's date as a YYYY-MM-DD string (e.g. "2026-05-05").

  @param timezone - IANA timezone name (defaults to the local timezone)

Get today's date as a YYYY-MM-DD string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L37))

### tomorrow

```ts
tomorrow(timezone: string = ""): string
```

Get tomorrow's date as a YYYY-MM-DD string (e.g. "2026-05-06").

  @param timezone - IANA timezone name (defaults to the local timezone)

Get tomorrow's date as a YYYY-MM-DD string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L47))

### add

```ts
add(datetime: string, ms: number): string
```

Add a duration in milliseconds to a datetime string, returning a new ISO 8601 datetime string. Negative values subtract.

  @param datetime - The ISO 8601 datetime string
  @param ms - The number of milliseconds to add (negative to subtract)

Add a duration to a datetime string. Use with unit literals: add(now(), 2h), add(start, 7d)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| ms | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L57))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L68))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L79))

### addDays

```ts
addDays(datetime: string, days: number): string
```

Add days to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract days. Note: adds a fixed 24 hours per day. On DST transition days the wall-clock time may shift by an hour. For DST-safe day arithmetic, compute the target date separately and use atTime().

  @param datetime - The ISO 8601 datetime string
  @param days - Number of days to add (negative to subtract)

Add days to a datetime string and return the new datetime. Note: adds a fixed 24 hours per day, which may shift the wall-clock time by an hour on DST transition days. For DST-safe day arithmetic, use atTime with a date string instead.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| days | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L90))

### nextDayOfWeek

```ts
nextDayOfWeek(day: DayOfWeek, timezone: string = ""): string
```

Get the next occurrence of a given day of the week as a YYYY-MM-DD string. For example, passing "tuesday" returns the date of next Tuesday.

  @param day - The day of the week
  @param timezone - IANA timezone name (defaults to the local timezone)

Get the date of the next occurrence of a day of the week (e.g. "monday").

**Parameters:**

| Name | Type | Default |
|---|---|---|
| day | [DayOfWeek](#dayofweek) |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L101))

### atTime

```ts
atTime(date: string, time: string, timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L112))

### startOfDay

```ts
startOfDay(date: string = "", timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L124))

### endOfDay

```ts
endOfDay(date: string = "", timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L135))

### startOfWeek

```ts
startOfWeek(date: string = "", timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L146))

### endOfWeek

```ts
endOfWeek(date: string = "", timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L157))

### startOfMonth

```ts
startOfMonth(date: string = "", timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L168))

### endOfMonth

```ts
endOfMonth(date: string = "", timezone: string = ""): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L179))
