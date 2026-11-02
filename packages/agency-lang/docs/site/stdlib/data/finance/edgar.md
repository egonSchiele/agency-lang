---
name: "edgar"
description: "Find recent SEC filings by ticker or company CIK."
---

# edgar

## SEC EDGAR — U.S. company filings

  Look up official filings for a U.S.-listed company from the SEC's
  [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
  Find annual reports (10-K), quarterly reports (10-Q), material-event
  reports (8-K), or other filings by ticker or CIK.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L34))

## Effects

### std::edgar

```ts
effect std::edgar {
  company: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L31))

## Functions

### edgarFilingsByCik

```ts
edgarFilingsByCik(
  cik: string,
  formType: string = "",
  limit: number = 20,
): Result<Filing[]> raises <std::edgar, std::http::fetchJSON>
```

List recent SEC filings for a company by CIK.

  @param cik - The company Central Index Key, with or without leading zeros.
  @param formType - A form such as "10-K" or "8-K", or empty for all forms.
  @param limit - The maximum filings to return, or zero or less for all recent filings.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cik | `string` |  |
| formType | `string` | "" |
| limit | `number` | 20 |

**Returns:** `Result<Filing[]>`

**Throws:** `std::edgar`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L133))

### edgarFilings

```ts
edgarFilings(
  ticker: string,
  formType: string = "",
  limit: number = 20,
): Result<Filing[]> raises <std::edgar, std::http::fetchJSON>
```

List recent SEC filings for a company by stock ticker.

  @param ticker - A stock ticker such as "AAPL", matched without regard to case.
  @param formType - A form such as "10-K" or "8-K", or empty for all forms.
  @param limit - The maximum filings to return, or zero or less for all recent filings.

Use `edgarFilingsByCik` when you already know the company CIK to skip
  the ticker-directory request. These functions read the recent-filings
  section of SEC submissions data, rather than the full filing archive.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ticker | `string` |  |
| formType | `string` | "" |
| limit | `number` | 20 |

**Returns:** `Result<Filing[]>`

**Throws:** `std::edgar`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/finance/edgar.agency#L155))
