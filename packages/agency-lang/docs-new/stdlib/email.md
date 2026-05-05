# email

## Types

### EmailResult

```ts
type EmailResult = {
  id: string;
  provider: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L3))

## Functions

### sendWithResend

```ts
sendWithResend(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, apiKey: string): Result
```

Send an email using the Resend API. Requires RESEND_API_KEY env var or pass apiKey directly. Parameters: from (sender address), to (recipient), subject, html or text content, and optionally cc, bcc, replyTo.

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

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L32))

### sendWithSendGrid

```ts
sendWithSendGrid(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, apiKey: string): Result
```

Send an email using the SendGrid API. Requires SENDGRID_API_KEY env var or pass apiKey directly. Parameters: from (sender address), to (recipient), subject, html or text content, and optionally cc, bcc, replyTo.

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

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L51))

### sendWithMailgun

```ts
sendWithMailgun(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, apiKey: string, domain: string, region: string): Result
```

Send an email using the Mailgun API. Requires MAILGUN_API_KEY and MAILGUN_DOMAIN env vars, or pass them directly. Set region to "eu" for the EU endpoint. Parameters: from (sender address), to (recipient), subject, html or text content, and optionally cc, bcc, replyTo, domain, region.

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

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/email.agency#L70))
