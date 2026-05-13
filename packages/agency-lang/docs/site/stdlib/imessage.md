# imessage

## Usage

  ```ts
  import { sendIMessage } from "std::imessage"

  node main() {
    const result = sendIMessage("+15551234567", "Hello from my agent!")
    print(result)
  }
  ```

  ## Requirements
  - macOS only
  - Messages.app must be signed in to iMessage
  - No API key required

## Types

### IMessageResult

```ts
type IMessageResult = {
  sent: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/imessage.agency#L21))

## Functions

### sendIMessage

```ts
sendIMessage(to: string, message: string, allowList: string[], blockList: string[]): Result
```

Send an iMessage via the macOS Messages app. Only works on macOS with Messages.app signed in. Set allowList to restrict recipients to specific addresses/numbers. Set blockList to reject specific addresses/numbers.

  @param to - Phone number or email of the recipient
  @param message - The text to send
  @param allowList - Only allow sending to these addresses/numbers
  @param blockList - Block sending to these addresses/numbers

**Parameters:**

| Name | Type | Default |
|---|---|---|
| to | `string` |  |
| message | `string` |  |
| allowList | `string[]` | [] |
| blockList | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::sendIMessage`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/imessage.agency#L25))
