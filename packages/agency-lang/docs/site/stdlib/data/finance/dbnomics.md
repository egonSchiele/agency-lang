---
name: "dbnomics"
description: "Read economic time series from DBnomics."
---

# dbnomics

## DBnomics — world macroeconomic time-series

  Fetch economic data from [DBnomics](https://db.nomics.world/) using a
  provider, dataset, and series code. Browse the DBnomics directory to find
  codes for national or cross-country statistics. No API key is required.
  For U.S. macro data, prefer `std::data/finance/fred`.

  Returns a series as a list of `{ period, value }` observations (period like "2025-01"; a
  missing value is null).

  ### Usage

  ```ts
  import { dbnomicsSeries } from "std::data/finance/dbnomics"

  node main() {
    const series = dbnomicsSeries("BLS", "cu", "CUUR0000SA0") catch { providerCode: "", datasetCode: "", seriesCode: "", seriesName: "", frequency: "", observations: [] }
    print("${series.seriesName}: ${series.observations.length} observations")
  }
  ```

## Types

### DbnomicsObservation

A single DBnomics observation. `period` is a label like "2025-01"; `value` may be null.

```ts
/** A single DBnomics observation. `period` is a label like "2025-01"; `value` may be null. */
export type DbnomicsObservation = {
  period: string;
  value?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L30))

### DbnomicsSeries

A DBnomics data series with its provider/dataset/series identity and observations.

```ts
/** A DBnomics data series with its provider/dataset/series identity and observations. */
export type DbnomicsSeries = {
  providerCode: string;
  datasetCode: string;
  seriesCode: string;
  seriesName: string;
  frequency: string;
  observations: DbnomicsObservation[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L36))

## Effects

### std::dbnomics

```ts
effect std::dbnomics {
  provider: string;
  dataset: string;
  series: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L27))

## Functions

### dbnomicsSeries

```ts
dbnomicsSeries(
  provider: string,
  dataset: string,
  series: string,
): Result<DbnomicsSeries> raises <std::dbnomics, std::http::fetchJSON>
```

Fetch an economic time series from DBnomics. Use it for non-U.S. or
  cross-country data; prefer fredSeries for U.S. macro data.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| provider | `string` |  | The DBnomics provider code, such as "BLS" or "IMF". |
| dataset | `string` |  | The dataset code within that provider, such as "cu". |
| series | `string` |  | The series code within that dataset, such as "CUUR0000SA0". |

**Returns:** `Result<DbnomicsSeries>`

**Throws:** `std::dbnomics`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L96))
