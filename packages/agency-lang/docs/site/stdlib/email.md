# email

## Usage

  ```ts
  import { sendWithResend, sendWithSendGrid, sendWithMailgun } from "std::email"

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

  ## Partial Application for Safety

  ```ts
  // Create a constrained email sender that only sends to your team
  const teamEmail = sendWithResend.partial(
    from: "noreply@myco.com",
    allowList: ["team@myco.com", "alerts@myco.com"]
  )

  // Now the agent can only email approved addresses
  teamEmail(to: "team@myco.com", subject: "Deploy complete", text: "v2.1 is live")
  ```

  ## Environment Variables
  - Resend: `RESEND_API_KEY`
  - SendGrid: `SENDGRID_API_KEY`
  - Mailgun: `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` (optionally `MAILGUN_REGION` = "us" | "eu")

## Types

### EmailResult

```ts
type EmailResult = {
  id: string;
  provider: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L39))

## Functions

### sendWithResend

```ts
sendWithResend(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, apiKey: string, allowList: string[], blockList: string[]): Result
```

Send an email using the Resend API. Requires RESEND_API_KEY env var or pass apiKey directly. Set allowList to restrict recipients to specific addresses. Set blockList to reject specific addresses.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L45))

### sendWithSendGrid

```ts
sendWithSendGrid(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, apiKey: string, allowList: string[], blockList: string[]): Result
```

Send an email using the SendGrid API. Requires SENDGRID_API_KEY env var or pass apiKey directly. Set allowList to restrict recipients to specific addresses. Set blockList to reject specific addresses.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L84))

### sendWithMailgun

```ts
sendWithMailgun(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, apiKey: string, domain: string, region: string, allowList: string[], blockList: string[]): Result
```

Send an email using the Mailgun API. Requires MAILGUN_API_KEY and MAILGUN_DOMAIN env vars, or pass them directly. Set allowList to restrict recipients to specific addresses. Set blockList to reject specific addresses.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L123))
