# sms

## Usage

  ```ts
  import { sendSms } from "std::sms"

  node main() {
    const result = sendSms("+15551234567", "Hello from my agent!")
    print(result)
  }
  ```

  ## Environment Variables
  - `TWILIO_ACCOUNT_SID` — Your Twilio Account SID
  - `TWILIO_AUTH_TOKEN` — Your Twilio Auth Token
  - `TWILIO_FROM_NUMBER` — Your Twilio phone number (e.g. "+15550001234")

## Types

### SmsResult

```ts
type SmsResult = {
  sid: string;
  status: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/sms.agency#L21))

## Functions

### sendSms

```ts
sendSms(to: string, body: string, from: string, accountSid: string, authToken: string, allowList: string[], blockList: string[]): Result
```

Send an SMS text message via the Twilio API. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER env vars, or pass them directly. Set allowList to restrict recipients to specific numbers. Set blockList to reject specific numbers.

  @param to - Recipient phone number (E.164 format)
  @param body - Message text
  @param from - Sender phone number
  @param accountSid - Twilio account SID
  @param authToken - Twilio auth token
  @param allowList - Only allow sending to these numbers
  @param blockList - Block sending to these numbers

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/sms.agency#L26))
