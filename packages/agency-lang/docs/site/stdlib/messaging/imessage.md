---
name: "imessage"
description: "Send an iMessage from Agency code via the macOS Messages app."
---

# imessage

Send an iMessage from Agency code via the macOS Messages app. Works on
  macOS only, with Messages.app signed in to iMessage. No API key required.

  ```ts
  import { sendIMessage } from "std::messaging/imessage"

  node main() {
    const result = sendIMessage("+15551234567", "Hello from my agent!")
    print(result)
  }
  ```

## Types

## Effects

### std::sendIMessage

```ts
effect std::sendIMessage {
  to: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/imessage.agency#L21))

## Functions

### sendIMessage

```ts
sendIMessage(
  to: string,
  message: string,
  allowList: string[] = [],
  blockList: string[] = [],
): Result
```

Send an iMessage via the macOS Messages app.

  @param to - Phone number or email of the recipient
  @param message - The text to send
  @param allowList - Only allow sending to these addresses/numbers
  @param blockList - Block sending to these addresses/numbers

Only works on macOS with Messages.app signed in to iMessage. No API key required.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| to | `string` |  |
| message | `string` |  |
| allowList | `string[]` | [] |
| blockList | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::sendIMessage`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/imessage.agency#L24))
