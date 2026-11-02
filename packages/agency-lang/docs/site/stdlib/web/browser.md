---
name: "browser"
description: "Run browser tasks described in plain language through Browser Use."
---

# browser

Run browser automation tasks described in plain language via the Browser Use
  cloud API.

  ```ts
  import { browserUse } from "std::web/browser"

  node main() {
    const result = browserUse("Find the top 3 trending repos on GitHub today")
    print(result)
  }
  ```

  Set `BROWSER_USE_API_KEY` to your Browser Use API key. Get one at
  https://cloud.browser-use.com/settings.

## Effects

### std::browserUse

```ts
effect std::browserUse {
  task: string;
  model: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/browser.agency#L27))

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

Run a browser automation task described in plain language through Browser Use.

  @param task - Describe the goal, relevant pages, and when the task is complete.
  @param model - A Browser Use model name, or empty for the service default.
  @param maxCostUsd - The spend limit sent to the remote service, in USD.
  @param proxyCountryCode - A two-letter routing country code, such as "US" or "DE".
  @param timeout - How long to poll for completion in milliseconds, or zero for two minutes.
  @param apiKey - Leave empty to use BROWSER_USE_API_KEY.
  @param allowedDomains - Ask the remote browser agent to navigate only to these domains.

Requires a Browser Use API key. The result includes the remote task’s
  output, status, and session ID. Check the status before treating the
  output as a completed task.

  The domain list only changes the task instructions sent to the remote
  browser agent. The client does not check its navigation against the list.

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

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/web/browser.agency#L38))
