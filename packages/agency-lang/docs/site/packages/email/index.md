---
name: "index"
---

# index

## Functions

### sendEmail

```ts
sendEmail(from: string, to: string, subject: string, html: string, text: string, cc: string, bcc: string, replyTo: string, host: string, port: number, secure: boolean, user: string, pass: string): Result
```

Send an email via SMTP using Nodemailer. Works with any email provider (Gmail, Outlook, Yahoo, self-hosted, etc). Requires SMTP_HOST env var or pass host directly. Authentication (SMTP_USER/SMTP_PASS) is optional. Set port to 0 for auto-detection (default 587). Secure is auto-detected from port and SMTP_SECURE env var when not explicitly set.

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
| host | `string` | "" |
| port | `number` | 0 |
| secure | `boolean` | false |
| user | `string` | "" |
| pass | `string` | "" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/email/index.agency#L44))
