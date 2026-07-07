---
name: "dbnomics"
---

# dbnomics

## DBnomics — world macroeconomic time-series

  Fetch economic data from [DBnomics](https://db.nomics.world/), an aggregator that re-serves
  80+ statistical providers (Eurostat, IMF, World Bank, OECD, BLS, national statistics offices)
  through one keyless API. Use this connector for *non-U.S.* or cross-country data, or a
  provider FRED does not carry. Each series is addressed by a `provider / dataset / series`
  code triple (browse db.nomics.world to find codes). For U.S. macro prefer
  `std::data/finance/fred`; for news use `std::data/finance/gdelt`.

  Returns a series as a list of `{ period, value }` observations (period like "2025-01"; a
  missing value is null). No API key required.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L31))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L37))

## Effects

### std::dbnomics

```ts
effect std::dbnomics {
  provider: string;
  dataset: string;
  series: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L28))

## Functions

### buildDbnomicsPath

```ts
buildDbnomicsPath(provider: string, dataset: string, series: string): string
```

Build the DBnomics series path (codes are URL-encoded). Pure — no network.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| provider | `string` |  |
| dataset | `string` |  |
| series | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L52))

### parseDbnomics

```ts
parseDbnomics(raw: any): DbnomicsSeries
```

Reshape a DBnomics series response (zips parallel period/value arrays). Pure — total on null input.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| raw | `any` |  |

**Returns:** [DbnomicsSeries](#dbnomicsseries)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L60))

### dbnomicsFinalize

```ts
dbnomicsFinalize(fetchResult: any): Result
```

Finalize a DBnomics fetch into a Result. Pure — total on missing `series`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fetchResult | `any` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L79))

### dbnomicsSeries

```ts
dbnomicsSeries(provider: string, dataset: string, series: string): Result
```

Fetch a macroeconomic time-series from DBnomics by its provider/dataset/series codes
  (e.g. provider "BLS", dataset "cu", series "CUUR0000SA0" for U.S. CPI). Returns the series
  name, frequency, and a list of { period, value } observations. Use for non-U.S. or
  cross-country economic data. No API key required.

  @param provider - DBnomics provider code, e.g. "Eurostat", "IMF", "BLS"
  @param dataset - Dataset code within the provider, e.g. "cu"
  @param series - Series code within the dataset, e.g. "CUUR0000SA0"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| provider | `string` |  |
| dataset | `string` |  |
| series | `string` |  |

**Returns:** `Result`

**Throws:** `std::dbnomics`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/dbnomics.agency#L92))
