---
name: "sms"
---

# sms

Send SMS text messages from Agency code via Twilio. Set `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` (e.g. "+15550001234"), or pass
  them directly.

  ```ts
  import { sendSms } from "std::messaging/sms"

  node main() {
    const result = sendSms("+15551234567", "Hello from my agent!")
    print(result)
  }
  ```

## Types

## Effects

### std::sendSms

```ts
effect std::sendSms {
  to: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/sms.agency#L23))

## Functions

### sendSms

```ts
sendSms(
  to: string,
  body: string,
  from: string = "",
  accountSid: string = "",
  authToken: string = "",
  allowList: string[] = [],
  blockList: string[] = [],
): Result
```

Send an SMS text message via the Twilio API.

  @param to - Recipient phone number (E.164 format)
  @param body - Message text
  @param from - Sender phone number
  @param accountSid - Twilio account SID
  @param authToken - Twilio auth token
  @param allowList - Only allow sending to these numbers
  @param blockList - Block sending to these numbers

Requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` env vars, or pass them directly.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| to | `string` |  |
| body | `string` |  |
| from | `string` | "" |
| accountSid | `string` | "" |
| authToken | `string` | "" |
| allowList | `string[]` | [] |
| blockList | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::sendSms`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/sms.agency#L26))
