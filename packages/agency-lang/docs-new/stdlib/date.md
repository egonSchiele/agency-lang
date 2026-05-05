# date

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L80))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L88))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L96))

### addMinutes

```ts
addMinutes(datetime: string, minutes: number): string
```

Add minutes to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract minutes.

Add minutes to a datetime string and return the new datetime.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| minutes | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L104))

### addHours

```ts
addHours(datetime: string, hours: number): string
```

Add hours to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract hours.

Add hours to a datetime string and return the new datetime.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| hours | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L112))

### addDays

```ts
addDays(datetime: string, days: number): string
```

Add days to a datetime string. Returns a new ISO 8601 datetime string. Negative values subtract days.

Add days to a datetime string and return the new datetime.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| datetime | `string` |  |
| days | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L120))

### nextDayOfWeek

```ts
nextDayOfWeek(day: string, timezone: string): string
```

Get the next occurrence of a given day of the week as a YYYY-MM-DD string. For example, nextDayOfWeek("tuesday") returns the date of next Tuesday. Valid days: sunday, monday, tuesday, wednesday, thursday, friday, saturday.

Get the date of the next occurrence of a day of the week (e.g. "monday").

**Parameters:**

| Name | Type | Default |
|---|---|---|
| day | `string` |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L128))

### atTime

```ts
atTime(date: string, time: string, timezone: string): string
```

Combine a date and time into a full timezone-aware ISO 8601 string. For example, atTime("2026-05-10", "15:00", "America/Los_Angeles") returns "2026-05-10T15:00:00-07:00". Uses local timezone if not specified.

Combine a date (YYYY-MM-DD) and time (HH:MM) into a timezone-aware ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` |  |
| time | `string` |  |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L136))

### endAfter

```ts
endAfter(start: string, minutes: number): string
```

Compute an end time by adding a duration in minutes to a start time. Useful for creating calendar events: endAfter(start, 60) gives you an end time 1 hour after start.

Compute an end time by adding minutes to a start time.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| start | `string` |  |
| minutes | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L144))

### startOfDay

```ts
startOfDay(date: string, timezone: string): string
```

Get midnight (00:00:00) of a given date as a timezone-aware ISO 8601 string. Uses today if no date provided.

Get the start of the day (midnight) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L152))

### endOfDay

```ts
endOfDay(date: string, timezone: string): string
```

Get the end of the day (23:59:59) of a given date as a timezone-aware ISO 8601 string. Uses today if no date provided.

Get the end of the day (23:59:59) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L160))

### startOfWeek

```ts
startOfWeek(date: string, timezone: string): string
```

Get midnight on Sunday of the week containing the given date. Uses this week if no date provided.

Get the start of the current week (Sunday midnight) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L168))

### endOfWeek

```ts
endOfWeek(date: string, timezone: string): string
```

Get 23:59:59 on Saturday of the week containing the given date. Uses this week if no date provided.

Get the end of the current week (Saturday 23:59:59) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L176))

### startOfMonth

```ts
startOfMonth(date: string, timezone: string): string
```

Get midnight on the 1st of the month containing the given date. Uses this month if no date provided.

Get the start of the month (1st at midnight) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L184))

### endOfMonth

```ts
endOfMonth(date: string, timezone: string): string
```

Get 23:59:59 on the last day of the month containing the given date. Uses this month if no date provided.

Get the end of the month (last day at 23:59:59) as an ISO 8601 string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| date | `string` | "" |
| timezone | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/date.agency#L192))
