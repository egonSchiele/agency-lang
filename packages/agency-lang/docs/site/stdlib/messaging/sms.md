---
name: "sms"
description: "Send SMS messages through Twilio."
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

## Effects

### std::sendSms

```ts
@always(to)
effect std::sendSms {
  to: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/sms.agency#L25))

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
): Result raises <std::sendSms>
```

Send an SMS text message through Twilio.

  @param to - A phone number in E.164 format, such as "+15551234567".
  @param body - Non-empty message text.
  @param from - A Twilio sender number, or empty to use TWILIO_FROM_NUMBER.
  @param accountSid - Leave empty to use TWILIO_ACCOUNT_SID.
  @param authToken - Leave empty to use TWILIO_AUTH_TOKEN.
  @param allowList - Limit recipients to these numbers, or leave empty for no allow restriction.
  @param blockList - Reject these numbers even if they are allowed.

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

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/sms.agency#L29))
