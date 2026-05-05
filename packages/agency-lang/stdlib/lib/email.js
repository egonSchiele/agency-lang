const RESEND_URL = "https://api.resend.com/emails";
const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";
function toArray(value) {
    return Array.isArray(value) ? value : [value];
}
export async function _sendWithResend(params, options) {
    const apiKey = options?.apiKey || process.env.RESEND_API_KEY;
    if (!apiKey) {
        throw new Error("Missing Resend API key. Set RESEND_API_KEY env var or pass apiKey option.");
    }
    const body = {
        from: params.from,
        to: toArray(params.to),
        subject: params.subject,
    };
    if (params.html)
        body.html = params.html;
    if (params.text)
        body.text = params.text;
    if (params.cc)
        body.cc = toArray(params.cc);
    if (params.bcc)
        body.bcc = toArray(params.bcc);
    if (params.replyTo)
        body.reply_to = params.replyTo;
    const response = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Resend API error (${response.status}): ${responseBody}`);
    }
    const data = await response.json();
    return { id: data.id, provider: "resend" };
}
export async function _sendWithSendGrid(params, options) {
    const apiKey = options?.apiKey || process.env.SENDGRID_API_KEY;
    if (!apiKey) {
        throw new Error("Missing SendGrid API key. Set SENDGRID_API_KEY env var or pass apiKey option.");
    }
    const personalizations = {
        to: toArray(params.to).map((email) => ({ email })),
    };
    if (params.cc) {
        personalizations.cc = toArray(params.cc).map((email) => ({ email }));
    }
    if (params.bcc) {
        personalizations.bcc = toArray(params.bcc).map((email) => ({ email }));
    }
    const content = [];
    if (params.text)
        content.push({ type: "text/plain", value: params.text });
    if (params.html)
        content.push({ type: "text/html", value: params.html });
    if (content.length === 0)
        content.push({ type: "text/plain", value: "" });
    const body = {
        personalizations: [{ ...personalizations, subject: params.subject }],
        from: { email: params.from },
        content,
    };
    if (params.replyTo) {
        body.reply_to = { email: params.replyTo };
    }
    const response = await fetch(SENDGRID_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`SendGrid API error (${response.status}): ${responseBody}`);
    }
    const messageId = response.headers.get("x-message-id") ?? "";
    return { id: messageId, provider: "sendgrid" };
}
export async function _sendWithMailgun(params, options) {
    const apiKey = options?.apiKey || process.env.MAILGUN_API_KEY;
    if (!apiKey) {
        throw new Error("Missing Mailgun API key. Set MAILGUN_API_KEY env var or pass apiKey option.");
    }
    const domain = options?.domain || process.env.MAILGUN_DOMAIN;
    if (!domain) {
        throw new Error("Missing Mailgun domain. Set MAILGUN_DOMAIN env var or pass domain option.");
    }
    const region = options?.region || process.env.MAILGUN_REGION || "us";
    const baseUrl = region === "eu"
        ? "https://api.eu.mailgun.net"
        : "https://api.mailgun.net";
    const formData = new URLSearchParams();
    formData.set("from", params.from);
    formData.set("subject", params.subject);
    formData.set("to", toArray(params.to).join(","));
    if (params.html)
        formData.set("html", params.html);
    if (params.text)
        formData.set("text", params.text);
    if (params.cc)
        formData.set("cc", toArray(params.cc).join(","));
    if (params.bcc)
        formData.set("bcc", toArray(params.bcc).join(","));
    if (params.replyTo)
        formData.set("h:Reply-To", params.replyTo);
    const credentials = Buffer.from(`api:${apiKey}`).toString("base64");
    const response = await fetch(`${baseUrl}/v3/${domain}/messages`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
    });
    if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Mailgun API error (${response.status}): ${responseBody}`);
    }
    const data = await response.json();
    return { id: data.id, provider: "mailgun" };
}
