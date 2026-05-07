# browser

Usage from Agency code:

  ```ts
  import { browserUse } from "std::browser"

  node main() {
    const result = browserUse("Find the top 3 trending repos on GitHub today")
    print(result.output)
  }
  ```

  Environment Variables:
  Set `BROWSER_USE_API_KEY` to your Browser Use API key.
  Get one at https://cloud.browser-use.com/settings.

## Types

### BrowserUseResult

```ts
type BrowserUseResult = {
  output: string;
  status: string;
  sessionId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/browser.agency#L20))

## Functions

### browserUse

```ts
browserUse(task: string, model: string, maxCostUsd: number, proxyCountryCode: string, timeout: number, apiKey: string): Result
```

Run a browser automation task using natural language via the Browser Use cloud API. Sends the task to a managed browser with stealth capabilities, CAPTCHA solving, and residential proxies. Returns the task output, status, and session ID. Requires a BROWSER_USE_API_KEY environment variable or pass apiKey directly. Available models: "bu-mini" (default), "bu-max", "bu-ultra". Set maxCostUsd to limit spending. Set proxyCountryCode (e.g. "US", "DE") to control geographic routing. Set timeout to control how long to wait for completion (default: 120000ms / 2 minutes).

  @param task - Natural language description of the browser task
  @param model - Model to use ("bu-mini", "bu-max", "bu-ultra")
  @param maxCostUsd - Maximum cost limit
  @param proxyCountryCode - Geographic routing code
  @param timeout - Timeout in milliseconds (e.g. 2m)
  @param apiKey - Browser Use API key

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| model | `string` | "" |
| maxCostUsd | `number` | 0 |
| proxyCountryCode | `string` | "" |
| timeout | `number` | 0 |
| apiKey | `string` | "" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/browser.agency#L26))
