---
name: "email"
description: "Send email through Resend, SendGrid, or Mailgun."
---

# email

Send email from Agency code through Resend, SendGrid, or Mailgun. Each
  provider reads its own API key from the environment: `RESEND_API_KEY`,
  `SENDGRID_API_KEY`, or `MAILGUN_API_KEY` plus `MAILGUN_DOMAIN` (and optional
  `MAILGUN_REGION` = "us" | "eu").

  ```ts
  import { sendWithResend } from "std::messaging/email"

  node main() {
    const result = sendWithResend(
      from: "you@yourdomain.com",
      to: "friend@example.com",
      subject: "Hello!",
      text: "Hey, how are you?"
    )
    print(result)
  }
  ```

  Use `.partial` to lock down who an agent can email:

  ```ts
  const teamEmail = sendWithResend.partial(
    from: "noreply@myco.com",
    allowList: ["team@myco.com", "alerts@myco.com"]
  )
  ```

## Effects

### std::sendEmail

```ts
@always(to)
effect std::sendEmail {
  from: string;
  to: string;
  subject: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L44))

## Functions

### sendWithResend

```ts
sendWithResend(
  from: string,
  to: string,
  subject: string,
  html: string = "",
  text: string = "",
  cc: string = "",
  bcc: string = "",
  replyTo: string = "",
  apiKey: string = "",
  allowList: string[] = [],
  blockList: string[] = [],
): Result
```

Send an email through Resend.

  @param from - An email address authorized to send through this provider.
  @param html - An HTML message body, which may accompany a plain-text alternative.
  @param text - A plain-text message body, which may accompany an HTML version.
  @param cc - One optional copy recipient address.
  @param bcc - One optional hidden-copy recipient address.
  @param replyTo - Direct replies to this address instead of the sender.
  @param apiKey - Leave empty to use RESEND_API_KEY.
  @param allowList - Limit to, cc, and bcc to these addresses, or leave empty for no allow restriction.
  @param blockList - Reject any to, cc, or bcc address on this list, even if allowed.

Configure a verified sender and a Resend API key before sending.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | `string` |  |
| to | `string` |  |
| subject | `string` |  |
| html | `string` | "" |
| text | `string` | "" |
| cc | `string` | "" |
| bcc | `string` | "" |
| replyTo | `string` | "" |
| apiKey | `string` | "" |
| allowList | `string[]` | [] |
| blockList | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::sendEmail`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L52))

### sendWithSendGrid

```ts
sendWithSendGrid(
  from: string,
  to: string,
  subject: string,
  html: string = "",
  text: string = "",
  cc: string = "",
  bcc: string = "",
  replyTo: string = "",
  apiKey: string = "",
  allowList: string[] = [],
  blockList: string[] = [],
): Result
```

Send an email through SendGrid.

  @param from - An email address authorized to send through this provider.
  @param html - An HTML message body, which may accompany a plain-text alternative.
  @param text - A plain-text message body, which may accompany an HTML version.
  @param cc - One optional copy recipient address.
  @param bcc - One optional hidden-copy recipient address.
  @param replyTo - Direct replies to this address instead of the sender.
  @param apiKey - Leave empty to use SENDGRID_API_KEY.
  @param allowList - Limit to, cc, and bcc to these addresses, or leave empty for no allow restriction.
  @param blockList - Reject any to, cc, or bcc address on this list, even if allowed.

Configure a verified sender and a SendGrid API key before sending.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | `string` |  |
| to | `string` |  |
| subject | `string` |  |
| html | `string` | "" |
| text | `string` | "" |
| cc | `string` | "" |
| bcc | `string` | "" |
| replyTo | `string` | "" |
| apiKey | `string` | "" |
| allowList | `string[]` | [] |
| blockList | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::sendEmail`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L107))

### sendWithMailgun

```ts
sendWithMailgun(
  from: string,
  to: string,
  subject: string,
  html: string = "",
  text: string = "",
  cc: string = "",
  bcc: string = "",
  replyTo: string = "",
  apiKey: string = "",
  domain: string = "",
  region: string = "",
  allowList: string[] = [],
  blockList: string[] = [],
): Result
```

Send an email through Mailgun.

  @param from - An email address authorized to send through this provider.
  @param html - An HTML message body, which may accompany a plain-text alternative.
  @param text - A plain-text message body, which may accompany an HTML version.
  @param cc - One optional copy recipient address.
  @param bcc - One optional hidden-copy recipient address.
  @param replyTo - Direct replies to this address instead of the sender.
  @param apiKey - Leave empty to use MAILGUN_API_KEY.
  @param domain - Leave empty to use MAILGUN_DOMAIN.
  @param region - Use "eu" for the EU endpoint, or empty to use MAILGUN_REGION then "us".
  @param allowList - Limit to, cc, and bcc to these addresses, or leave empty for no allow restriction.
  @param blockList - Reject any to, cc, or bcc address on this list, even if allowed.

Configure a Mailgun sending domain and API key before sending.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | `string` |  |
| to | `string` |  |
| subject | `string` |  |
| html | `string` | "" |
| text | `string` | "" |
| cc | `string` | "" |
| bcc | `string` | "" |
| replyTo | `string` | "" |
| apiKey | `string` | "" |
| domain | `string` | "" |
| region | `string` | "" |
| allowList | `string[]` | [] |
| blockList | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::sendEmail`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L162))
