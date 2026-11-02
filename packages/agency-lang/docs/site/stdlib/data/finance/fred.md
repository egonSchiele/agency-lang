---
name: "fred"
description: "Read FRED economic series and their metadata."
---

# fred

## FRED — U.S. macroeconomic time-series

  Fetch U.S. economic data from the Federal Reserve Bank of St. Louis
  [FRED API](https://fred.stlouisfed.org/docs/api/fred/): interest rates, CPI (inflation),
  unemployment, and GDP. Use a series ID such as `UNRATE`, `CPIAUCSL`,
  or `FEDFUNDS`. For other providers, see `std::data/finance/dbnomics`.

  Returns a series as a list of `{ date, value }` observations (a missing value is `null`),
  oldest-first, plus a `fredSeriesInfo` call for a series' title/display-units/frequency/coverage.

  ### Setup

  Requires a free API key. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and
  set it as the `FRED_API_KEY` environment variable.

  > **Note:** FRED's API v1 accepts the key only as a URL query parameter, so when
  > `observability` is enabled the key appears in statelog `fetchJSON` interrupt payloads
  > (the URL is logged). This is a general property of any secret passed in a URL with
  > `std::http`. Use a trusted statelog destination for runs that call FRED.

  ### Usage

  ```ts
  import { fredSeries } from "std::data/finance/fred"

  node main() {
    const series = fredSeries("UNRATE", "2024-01-01") catch { seriesId: "", units: "", observations: [] }
    for (obs in series.observations) {
      print("${obs.date}: ${obs.value}")
    }
  }
  ```

## Types

### FredObservation

A single FRED observation. `value` is null when FRED reports the value as missing (".").

```ts
/** A single FRED observation. `value` is null when FRED reports the value as missing ("."). */
export type FredObservation = {
  date: string;
  value?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L43))

### FredSeries

A FRED series whose `units` is a transform code, such as "lin" or "pch".
    Use `fredSeriesInfo` for display units.

```ts
/** A FRED series whose `units` is a transform code, such as "lin" or "pch".
    Use `fredSeriesInfo` for display units. */
export type FredSeries = {
  seriesId: string;
  units: string;
  observations: FredObservation[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L50))

### FredSeriesInfo

Metadata about a FRED series, with display units such as "Percent".

```ts
/** Metadata about a FRED series, with display units such as "Percent". */
export type FredSeriesInfo = {
  id: string;
  title: string;
  units: string;
  frequency: string;
  observationStart: string;
  observationEnd: string;
  notes: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L57))

### FredUnits

FRED units-transform codes (the `units` request parameter). `null` = native ("lin").

```ts
/** FRED units-transform codes (the `units` request parameter). `null` = native ("lin"). */
export type FredUnits =
  | "lin"
  | "chg"
  | "ch1"
  | "pch"
  | "pc1"
  | "pca"
  | "cch"
  | "cca"
  | "log"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L73))

### FredFrequency

FRED frequency-aggregation codes (the `frequency` request parameter). `null` = native.
    Includes the weekly-ending variants (wef, weth, …).

```ts
/** FRED frequency-aggregation codes (the `frequency` request parameter). `null` = native.
    Includes the weekly-ending variants (wef, weth, …). */
export type FredFrequency =
  | "d"
  | "w"
  | "bw"
  | "m"
  | "q"
  | "sa"
  | "a"
  | "wef"
  | "weth"
  | "wetu"
  | "wew"
  | "wetdt"
  | "wem"
  | "wesun"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L77))

## Effects

### std::fred

```ts
effect std::fred {
  seriesId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L40))

## Functions

### fredSeries

```ts
fredSeries(
  seriesId: string,
  observationStart: string = "",
  observationEnd: string = "",
  frequency: FredFrequency | null = null,
  units: FredUnits | null = null,
  limit: number = 0,
): Result<FredSeries> raises <std::fred, std::env, std::http::fetchJSON>
```

Fetch observations for a FRED economic series, ordered oldest first.
  Requires FRED_API_KEY.

  @param seriesId - A FRED series ID such as "UNRATE" or "CPIAUCSL".
  @param observationStart - The earliest YYYY-MM-DD date, or empty for no lower bound.
  @param observationEnd - The latest YYYY-MM-DD date, or empty for no upper bound.
  @param frequency - The aggregation frequency, or null to keep the native frequency.
  @param units - The units transform, such as "pch" for percent change, or null for native values.
  @param limit - The maximum observations from the oldest, or zero for the API default.

Set the observation start date when you want recent data. A limit takes
  observations from the oldest end of the selected range. Missing source
  values become null.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seriesId | `string` |  |
| observationStart | `string` | "" |
| observationEnd | `string` | "" |
| frequency | `FredFrequency \| null` | null |
| units | `FredUnits \| null` | null |
| limit | `number` | 0 |

**Returns:** `Result<FredSeries>`

**Throws:** `std::fred`, `std::env`, `std::http::fetchJSON`

**Needs:** `network`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L180))

### fredSeriesInfo

```ts
fredSeriesInfo(
  seriesId: string,
): Result<FredSeriesInfo> raises <std::fred, std::env, std::http::fetchJSON>
```

Fetch a FRED series’ title, display units, frequency, and coverage dates.
  Requires FRED_API_KEY.

  @param seriesId - A FRED series ID such as "UNRATE".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seriesId | `string` |  |

**Returns:** `Result<FredSeriesInfo>`

**Throws:** `std::fred`, `std::env`, `std::http::fetchJSON`

**Needs:** `network`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L206))
