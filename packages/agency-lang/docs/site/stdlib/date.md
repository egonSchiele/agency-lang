---
name: "date"
description: "Work with instants as epoch-millisecond numbers, and calendar dates as strings."
---

# date

An instant — a specific moment in time — is a number: milliseconds since 1970,
the same value JavaScript's Date.now() gives. Do math on it directly with the
usual operators and duration literals: `now() + 2h`, `deadline - now()`. A
calendar date — a whole day, like "today" — stays a "YYYY-MM-DD" string, because
which day it is depends on the timezone. Use `format` to turn an instant into a
readable string, `formatDate` for its calendar date, and `parse` to read an ISO
string back into an instant.

```ts
import { now, atTime, nextDayOfWeek, format } from "std::date"
import { createEvent } from "std::calendar"

node main() {
  // 3pm next Monday Pacific for one hour
  const tz = "America/Los_Angeles"
  const start = atTime(nextDayOfWeek("monday", tz), "15:00", tz)
  createEvent(summary: "Dentist", start: format(start, tz), end: format(start + 1h, tz))
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L28))

## Functions

### now

```ts
now(): number
```

Get the current instant as epoch milliseconds (a number). To display it as a
  string, use format(now(), timezone). An instant is absolute and has no
  timezone of its own.

Get the current instant as epoch milliseconds.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L31))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L54))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L64))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L74))

### atTime

```ts
atTime(date: string, time: string, timezone: string = ""): number
```

Get the instant (epoch milliseconds) of a wall-clock time on a calendar date,
  in a timezone. Example: atTime("2026-05-05", "09:00", "America/New_York").
  Throws if the date or time cannot be parsed, so bad input fails loudly instead
  of becoming a silent NaN.

  @param date - The calendar date, "YYYY-MM-DD"
  @param time - The wall-clock time, "HH:MM" or "HH:MM:SS"
  @param timezone - IANA timezone name (defaults to local)

Get the instant of a wall-clock time on a calendar date, in a timezone.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` |  |
| time | `string` |  |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L85))

### startOfDay

```ts
startOfDay(instant: number | null = null, timezone: string = ""): number
```

Get midnight (00:00:00) of the day containing `instant`, in a timezone, as
  epoch milliseconds. Defaults to now(). Display it with format(...).

  @param instant - The instant whose day to use (defaults to now())
  @param timezone - IANA timezone name (defaults to local)

Get midnight of the day containing an instant, as epoch milliseconds.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| instant | `number \| null` | null |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L100))

### endOfDay

```ts
endOfDay(instant: number | null = null, timezone: string = ""): number
```

Get the last millisecond (23:59:59.999) of the day containing `instant`, in a
  timezone, as epoch milliseconds. Defaults to now(). An instant is always
  within [startOfDay, endOfDay] of its own day.

  @param instant - The instant whose day to use (defaults to now())
  @param timezone - IANA timezone name (defaults to local)

Get the last millisecond of the day containing an instant.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| instant | `number \| null` | null |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L113))

### startOfWeek

```ts
startOfWeek(instant: number | null = null, timezone: string = ""): number
```

Get midnight on Sunday of the week containing `instant`, in a timezone, as
  epoch milliseconds. Weeks begin on Sunday. Defaults to now().

  @param instant - An instant within the week (defaults to now())
  @param timezone - IANA timezone name (defaults to local)

Get midnight on Sunday of the week containing an instant.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| instant | `number \| null` | null |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L127))

### endOfWeek

```ts
endOfWeek(instant: number | null = null, timezone: string = ""): number
```

Get the last millisecond (23:59:59.999) of Saturday of the week containing
  `instant`, in a timezone, as epoch milliseconds. Weeks end on Saturday.
  Defaults to now().

  @param instant - An instant within the week (defaults to now())
  @param timezone - IANA timezone name (defaults to local)

Get the last millisecond of Saturday of the week containing an instant.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| instant | `number \| null` | null |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L140))

### startOfMonth

```ts
startOfMonth(instant: number | null = null, timezone: string = ""): number
```

Get midnight on the 1st of the month containing `instant`, in a timezone, as
  epoch milliseconds. Defaults to now().

  @param instant - An instant within the month (defaults to now())
  @param timezone - IANA timezone name (defaults to local)

Get midnight on the 1st of the month containing an instant.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| instant | `number \| null` | null |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L154))

### endOfMonth

```ts
endOfMonth(instant: number | null = null, timezone: string = ""): number
```

Get the last millisecond (23:59:59.999) of the last day of the month
  containing `instant`, in a timezone, as epoch milliseconds. Defaults to now().

  @param instant - An instant within the month (defaults to now())
  @param timezone - IANA timezone name (defaults to local)

Get the last millisecond of the last day of the month containing an instant.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| instant | `number \| null` | null |
| timezone | `string` | "" |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L167))

### format

```ts
format(ms: number, timezone: string = ""): string
```

Format an instant (epoch milliseconds) as an ISO 8601 string with
  milliseconds and offset, e.g. "2026-05-05T10:30:00.123-07:00".

  @param ms - The instant to format
  @param timezone - IANA timezone name (defaults to local)

Format an instant as an ISO 8601 string with milliseconds and offset.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L180))

### formatDate

```ts
formatDate(ms: number, timezone: string = ""): string
```

Format an instant as the "YYYY-MM-DD" calendar date it falls on in a timezone.

  @param ms - The instant to format
  @param timezone - IANA timezone name (defaults to local)

Format an instant as the "YYYY-MM-DD" calendar date it falls on.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L192))

### parse

```ts
parse(iso: string): number
```

Parse an ISO 8601 datetime string into an instant (epoch milliseconds). Throws
  if the string cannot be parsed, so bad input fails loudly instead of becoming
  a silent NaN. Strictness matches JavaScript's Date, not RFC 3339: loosely
  valid strings like "2026" or "2026-05" are accepted.

  @param iso - The ISO 8601 datetime string

Parse an ISO 8601 datetime string into an instant (epoch milliseconds).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| iso | `string` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L203))

### formatDuration

```ts
formatDuration(ms: number): string
```

Render a duration in milliseconds as a compact human string, largest unit
  first: "5m 32s", "1h 1s", "2d 3h". The granularity is whole seconds (a
  sub-second duration is "0s") and the largest unit is days (a long duration
  reads like "40d", never weeks or months). A negative duration gets a leading "-".

  @param ms - The duration in milliseconds

Render a millisecond duration as a readable string like "5m 32s".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L216))

### elapsedTime

```ts
elapsedTime(since: number): string
```

Returns how long has elapsed since the given instant, as a readable duration
  like "5m 32s". Capture the start with `now()`, then call this to see the time
  since. The largest unit is days, so a multi-day span reads like "2d 3h". If
  you need the raw milliseconds for math, use `now() - since` instead.

  @param since - The starting instant (epoch milliseconds), e.g. from now()

How long has elapsed since an instant, as a readable duration string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| since | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L229))
