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

Get the current time as milliseconds since the Unix epoch.

Use `format(now(), timezone)` to display the instant in a timezone.
The numeric instant itself identifies the same moment in every timezone.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L34))

### today

```ts
today(timezone: string = ""): string
```

Get today's date as a YYYY-MM-DD string (e.g. "2026-05-05").

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| timezone | `string` | "" | IANA timezone name (defaults to the local timezone) |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L54))

### tomorrow

```ts
tomorrow(timezone: string = ""): string
```

Get tomorrow's date as a YYYY-MM-DD string (e.g. "2026-05-06").

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| timezone | `string` | "" | IANA timezone name (defaults to the local timezone) |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L63))

### nextDayOfWeek

```ts
nextDayOfWeek(day: DayOfWeek, timezone: string = ""): string
```

Get the next occurrence of a weekday as a YYYY-MM-DD date.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| day | [DayOfWeek](#dayofweek) |  |  |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L72))

### atTime

```ts
atTime(date: string, time: string, timezone: string = ""): number
```

Convert a calendar date and local time to epoch milliseconds.

Use `atTime("2026-05-05", "09:00", "America/New_York")` to schedule a
local wall-clock time. Invalid dates and times throw an error.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| date | `string` |  | Calendar date in YYYY-MM-DD form. |
| time | `string` |  | Wall-clock time in HH:MM or HH:MM:SS form. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L85))

### startOfDay

```ts
startOfDay(instant: number | null = null, timezone: string = ""): number
```

Get midnight of the day containing the instant, as epoch milliseconds.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| instant | `number \| null` | null | Epoch milliseconds within the day, or omit for now. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L96))

### endOfDay

```ts
endOfDay(instant: number | null = null, timezone: string = ""): number
```

Get the last millisecond of the day containing the instant.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| instant | `number \| null` | null | Epoch milliseconds within the day, or omit for now. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L107))

### startOfWeek

```ts
startOfWeek(instant: number | null = null, timezone: string = ""): number
```

Get midnight on Sunday of the week containing the instant, as epoch milliseconds.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| instant | `number \| null` | null | Epoch milliseconds within the week, or omit for now. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L118))

### endOfWeek

```ts
endOfWeek(instant: number | null = null, timezone: string = ""): number
```

Get the last millisecond of Saturday of the week containing the instant.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| instant | `number \| null` | null | Epoch milliseconds within the week, or omit for now. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L129))

### startOfMonth

```ts
startOfMonth(instant: number | null = null, timezone: string = ""): number
```

Get midnight on the first day of the month containing the instant, as epoch milliseconds.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| instant | `number \| null` | null | Epoch milliseconds within the month, or omit for now. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L140))

### endOfMonth

```ts
endOfMonth(instant: number | null = null, timezone: string = ""): number
```

Get the last millisecond of the month containing the instant.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| instant | `number \| null` | null | Epoch milliseconds within the month, or omit for now. |
| timezone | `string` | "" | IANA timezone name, or empty for the local timezone. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L151))

### format

```ts
format(ms: number, timezone: string = ""): string
```

Format an instant (epoch milliseconds) as an ISO 8601 string with
  milliseconds and offset, e.g. "2026-05-05T10:30:00.123-07:00".

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| ms | `number` |  | The instant to format |
| timezone | `string` | "" | IANA timezone name (defaults to local) |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L162))

### formatDate

```ts
formatDate(ms: number, timezone: string = ""): string
```

Format an instant as the "YYYY-MM-DD" calendar date it falls on in a timezone.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| ms | `number` |  | The instant to format |
| timezone | `string` | "" | IANA timezone name (defaults to local) |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L173))

### parse

```ts
parse(iso: string): number
```

Parse a datetime string into epoch milliseconds.

Parsing follows JavaScript Date rules, so inputs such as `"2026"` and
`"2026-05"` are also accepted. Invalid input throws an error.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| iso | `string` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L187))

### formatDuration

```ts
formatDuration(ms: number): string
```

Format a duration in milliseconds as text such as "5m 32s".

Output uses whole seconds, with weeks as the largest unit.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L197))

### elapsedTime

```ts
elapsedTime(since: number): string
```

Format the time since an earlier instant as a duration such as "5m 32s".

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| since | `number` |  | Starting time in epoch milliseconds, such as a value from now(). |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/date.agency#L204))
