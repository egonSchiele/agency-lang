---
name: "imessage"
description: "Send iMessages through the macOS Messages app."
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

## Effects

### std::sendIMessage

```ts
@always(to)
effect std::sendIMessage {
  to: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/imessage.agency#L23))

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

Send an iMessage through the macOS Messages app.

  @param to - The recipient's phone number or iMessage email address.
  @param message - Non-empty message text.
  @param allowList - Limit recipients to these addresses or numbers, or leave empty for no allow restriction.
  @param blockList - Reject these addresses or numbers even if they are allowed.

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

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/imessage.agency#L27))
