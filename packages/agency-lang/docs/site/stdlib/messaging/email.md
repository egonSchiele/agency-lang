---
name: "email"
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

## Types

## Effects

### std::sendEmail

```ts
effect std::sendEmail {
  from: string;
  to: string;
  subject: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L38))

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

Send an email using the Resend API.

  @param from - Sender email address
  @param to - Recipient email address
  @param subject - Email subject
  @param html - HTML content
  @param text - Plain text content
  @param cc - CC recipients
  @param bcc - BCC recipients
  @param replyTo - Reply-to address
  @param apiKey - Resend API key
  @param allowList - Only allow sending to these addresses
  @param blockList - Block sending to these addresses

Send an email using the Resend API. Requires `RESEND_API_KEY` env var or pass apiKey directly.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L41))

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

Send an email using the SendGrid API.

  @param from - Sender email address
  @param to - Recipient email address
  @param subject - Email subject
  @param html - HTML content
  @param text - Plain text content
  @param cc - CC recipients
  @param bcc - BCC recipients
  @param replyTo - Reply-to address
  @param apiKey - SendGrid API key
  @param allowList - Only allow sending to these addresses
  @param blockList - Block sending to these addresses

Send an email using the SendGrid API. Requires `SENDGRID_API_KEY` env var or pass apiKey directly.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L82))

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

Send an email using the Mailgun API.

  @param from - Sender email address
  @param to - Recipient email address
  @param subject - Email subject
  @param html - HTML content
  @param text - Plain text content
  @param cc - CC recipients
  @param bcc - BCC recipients
  @param replyTo - Reply-to address
  @param apiKey - Mailgun API key
  @param domain - Mailgun domain
  @param region - Mailgun region ("eu" for EU)
  @param allowList - Only allow sending to these addresses
  @param blockList - Block sending to these addresses

Send an email using the Mailgun API. Requires `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` env vars, or pass them directly. Set region to "eu" for the EU endpoint.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/messaging/email.agency#L123))
