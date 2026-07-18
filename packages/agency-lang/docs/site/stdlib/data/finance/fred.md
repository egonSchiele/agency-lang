---
name: "fred"
description: "FRED — U.S. macroeconomic time-series"
---

# fred

## FRED — U.S. macroeconomic time-series

  Fetch U.S. economic data from the Federal Reserve Bank of St. Louis
  [FRED API](https://fred.stlouisfed.org/docs/api/fred/): interest rates, CPI (inflation),
  unemployment, GDP, and ~800k other series, each addressed by its `series_id`
  (e.g. `UNRATE`, `CPIAUCSL`, `FEDFUNDS`). This is the curated gold standard for *U.S.*
  macro; for non-U.S. or cross-country data use `std::data/finance/dbnomics`; for news use
  `std::data/finance/gdelt`.

  Returns a series as a list of `{ date, value }` observations (a missing value is `null`),
  oldest-first, plus a `fredSeriesInfo` call for a series' title/display-units/frequency/coverage.

  ### Setup

  Requires a free API key. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and
  set it as the `FRED_API_KEY` environment variable.

  > **Note:** FRED's API v1 accepts the key only as a URL query parameter, so when
  > `observability` is enabled the key appears in statelog `fetchJSON` interrupt payloads
  > (the URL is logged). This is a general property of any secret passed in a URL with
  > `std::http`; a follow-up will add URL-secret redaction to statelog. If this matters for
  > your deployment, avoid enabling observability on runs that call FRED, or route statelog
  > to a trusted sink.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L46))

### FredSeries

A FRED data series. `units` is the requested units *transform code* (e.g. "lin", "pch"),
    not the display label — use fredSeriesInfo for the display units.

```ts
/** A FRED data series. `units` is the requested units *transform code* (e.g. "lin", "pch"),
    not the display label — use fredSeriesInfo for the display units. */
export type FredSeries = {
  seriesId: string;
  units: string;
  observations: FredObservation[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L53))

### FredSeriesInfo

Metadata about a FRED series. `units` here IS the human display label (e.g. "Percent").

```ts
/** Metadata about a FRED series. `units` here IS the human display label (e.g. "Percent"). */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L60))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L75))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L79))

## Effects

### std::fred

```ts
effect std::fred {
  seriesId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L43))

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
): Result<FredSeries> raises <std::fred, std::http::fetchJSON>
```

Fetch a U.S. macroeconomic time-series from FRED by its series id (e.g. "UNRATE" for the
  unemployment rate, "CPIAUCSL" for CPI, "FEDFUNDS" for the fed funds rate). Returns the
  series and a list of { date, value } observations, ordered oldest-first (value is null when
  missing). For the most recent data, set observationStart rather than relying on limit
  (limit caps from the oldest observation). Requires the FRED_API_KEY environment variable.

  @param seriesId - FRED series id, e.g. "UNRATE"
  @param observationStart - Optional earliest date, "YYYY-MM-DD" (empty for no bound)
  @param observationEnd - Optional latest date, "YYYY-MM-DD" (empty for no bound)
  @param frequency - Optional frequency aggregation code, e.g. "m", "q", "a" (null for native)
  @param units - Optional units transform code, e.g. "pch" for percent change (null for "lin")
  @param limit - Optional max observations from the oldest, 0 means no limit

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

**Throws:** `std::fred`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L173))

### fredSeriesInfo

```ts
fredSeriesInfo(
  seriesId: string,
): Result<FredSeriesInfo> raises <std::fred, std::http::fetchJSON>
```

Fetch metadata about a FRED series by its id: its human title, display units, frequency, and
  the date range it covers. Requires the FRED_API_KEY environment variable.

  @param seriesId - FRED series id, e.g. "UNRATE"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seriesId | `string` |  |

**Returns:** `Result<FredSeriesInfo>`

**Throws:** `std::fred`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/fred.agency#L200))
