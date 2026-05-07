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
sendIMessage(to: string, message: string): Result
```

Send an iMessage via the macOS Messages app. Only works on macOS with Messages.app signed in. Parameters: to (phone number or email address of the recipient), message (the text to send). No API key or account required.

  @param to - Phone number or email of the recipient
  @param message - The text to send

**Parameters:**

| Name | Type | Default |
|---|---|---|
| to | `string` |  |
| message | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/imessage.agency#L25))
