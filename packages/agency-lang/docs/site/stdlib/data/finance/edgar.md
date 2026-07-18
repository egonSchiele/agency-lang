---
name: "edgar"
description: "SEC EDGAR — U.S. company filings"
---

# edgar

## SEC EDGAR — U.S. company filings

  Look up official filings for a U.S.-listed company from the SEC's
  [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
  Use this connector for *authoritative, mandated* facts about one company — its 10-K
  (annual), 10-Q (quarterly), 8-K (material event), and Form 4 (insider trade) filings — the
  slow-moving ground truth. For news or rumor about a company use `std::data/finance/gdelt`;
  for economic numbers use fred/dbnomics.

  Returns a list of filings with form type, filing/report dates, and a direct URL to the
  primary document. No API key required, but the SEC requires a descriptive User-Agent with
  contact info; set the `SEC_USER_AGENT` environment variable to override the default.

  ### Usage

  ```ts
  import { edgarFilings } from "std::data/finance/edgar"

  node main() {
    const filings = edgarFilings("AAPL", "10-K", 5) catch []
    for (filing in filings) {
      print("${filing.filingDate}  ${filing.form}  ${filing.url}")
    }
  }
  ```

## Types

### Filing

One SEC filing. `url` links directly to the primary document.

```ts
/** One SEC filing. `url` links directly to the primary document. */
export type Filing = {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  description: string;
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L36))

## Effects

### std::edgar

```ts
effect std::edgar {
  company: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L33))

## Functions

### edgarFilingsByCik

```ts
edgarFilingsByCik(
  cik: string,
  formType: string = "",
  limit: number = 20,
): Result<Filing[]> raises <std::edgar, std::http::fetchJSON>
```

List recent SEC filings for a company by its CIK (Central Index Key). Returns filings with
  form type, filing/report dates, and a direct URL to each primary document. Optionally filter
  by form type (e.g. "10-K", "10-Q", "8-K").

  @param cik - The company CIK, with or without leading zeros
  @param formType - Optional filing form to filter by, e.g. "10-K" (empty for all forms)
  @param limit - Maximum filings to return (default 20)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cik | `string` |  |
| formType | `string` | "" |
| limit | `number` | 20 |

**Returns:** `Result<Filing[]>`

**Throws:** `std::edgar`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L132))

### edgarFilings

```ts
edgarFilings(
  ticker: string,
  formType: string = "",
  limit: number = 20,
): Result<Filing[]> raises <std::edgar, std::http::fetchJSON>
```

List recent SEC filings for a U.S.-listed company by its ticker symbol (e.g. "AAPL").
  Resolves the ticker to a CIK, then returns filings with form type, filing/report dates, and
  a direct URL to each primary document. Optionally filter by form type (e.g. "10-K", "8-K").
  This downloads the SEC ticker->CIK map on each call; if you already know the CIK, prefer
  edgarFilingsByCik to skip that fetch.

  @param ticker - The company's stock ticker, e.g. "AAPL"
  @param formType - Optional filing form to filter by, e.g. "10-K" (empty for all forms)
  @param limit - Maximum filings to return (default 20)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ticker | `string` |  |
| formType | `string` | "" |
| limit | `number` | 20 |

**Returns:** `Result<Filing[]>`

**Throws:** `std::edgar`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L150))
