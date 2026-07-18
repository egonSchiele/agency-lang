---
name: "browser"
description: "Run browser automation tasks described in plain language via the Browser Use cloud API."
---

# browser

Run browser automation tasks described in plain language via the Browser Use
  cloud API.

  ```ts
  import { browserUse } from "std::web/browser"

  node main() {
    const result = browserUse("Find the top 3 trending repos on GitHub today")
    print(result.output)
  }
  ```

  Set `BROWSER_USE_API_KEY` to your Browser Use API key. Get one at
  https://cloud.browser-use.com/settings.

## Types

## Effects

### std::browserUse

```ts
effect std::browserUse {
  task: string;
  model: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/browser.agency#L26))

## Functions

### browserUse

```ts
browserUse(
  task: string,
  model: string = "",
  maxCostUsd: number = 0,
  proxyCountryCode: string = "",
  timeout: number = 0,
  apiKey: string = "",
  allowedDomains: string[] = [],
): Result
```

Run a browser automation task described in natural language via the Browser Use cloud API. The managed browser has stealth capabilities, CAPTCHA solving, and residential proxies. Returns the task output, status, and session ID.

  @param task - Natural language description of the browser task
  @param model - Model to use: "bu-mini" (default), "bu-max", or "bu-ultra"
  @param maxCostUsd - Maximum spend limit in USD
  @param proxyCountryCode - Two-letter country code for geographic routing (e.g. "US", "DE")
  @param timeout - Timeout in milliseconds (default 120000)
  @param apiKey - Browser Use API key (defaults to the BROWSER_USE_API_KEY env var)
  @param allowedDomains - Restrict the browser to only visit these domains

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| model | `string` | "" |
| maxCostUsd | `number` | 0 |
| proxyCountryCode | `string` | "" |
| timeout | `number` | 0 |
| apiKey | `string` | "" |
| allowedDomains | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::browserUse`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/browser.agency#L28))
