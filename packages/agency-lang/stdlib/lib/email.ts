import { checkRecipients } from "./messaging.js";

const RESEND_URL = "https://api.resend.com/emails";
const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

export type EmailParams = {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
};

export type EmailResult = {
  id: string;
  provider: string;
};

function validateRecipients(
  params: EmailParams,
  options?: { allowList?: string[]; blockList?: string[] },
): void {
  const recipients: string[] = [];
  recipients.push(...toArray(params.to));
  if (params.cc) recipients.push(...toArray(params.cc));
  if (params.bcc) recipients.push(...toArray(params.bcc));
  const error = checkRecipients(
    recipients,
    options?.allowList ?? [],
    options?.blockList ?? [],
  );
  if (error) throw new Error(error);
}

// --- Resend ---

export type ResendOptions = {
  apiKey?: string;
  allowList?: string[];
  blockList?: string[];
};

export async function _sendWithResend(
  params: EmailParams,
  options?: ResendOptions
): Promise<EmailResult> {
  validateRecipients(params, options);

  const apiKey = options?.apiKey || process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Resend API key. Set RESEND_API_KEY env var or pass apiKey option."
    );
  }

  const body: Record<string, unknown> = {
    from: params.from,
    to: toArray(params.to),
    subject: params.subject,
  };

  if (params.html) body.html = params.html;
  if (params.text) body.text = params.text;
  if (params.cc) body.cc = toArray(params.cc);
  if (params.bcc) body.bcc = toArray(params.bcc);
  if (params.replyTo) body.reply_to = params.replyTo;

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

  const data = await response.json() as { id: string };
  return { id: data.id, provider: "resend" };
}

// --- SendGrid ---

export type SendGridOptions = {
  apiKey?: string;
  allowList?: string[];
  blockList?: string[];
};

export async function _sendWithSendGrid(
  params: EmailParams,
  options?: SendGridOptions
): Promise<EmailResult> {
  validateRecipients(params, options);

  const apiKey = options?.apiKey || process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing SendGrid API key. Set SENDGRID_API_KEY env var or pass apiKey option."
    );
  }

  const personalizations: Record<string, unknown> = {
    to: toArray(params.to).map((email) => ({ email })),
  };

  if (params.cc) {
    personalizations.cc = toArray(params.cc).map((email) => ({ email }));
  }
  if (params.bcc) {
    personalizations.bcc = toArray(params.bcc).map((email) => ({ email }));
  }

  const content: { type: string; value: string }[] = [];
  if (params.text) content.push({ type: "text/plain", value: params.text });
  if (params.html) content.push({ type: "text/html", value: params.html });
  if (content.length === 0) content.push({ type: "text/plain", value: "" });

  const body: Record<string, unknown> = {
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

// --- Mailgun ---

export type MailgunOptions = {
  apiKey?: string;
  domain?: string;
  region?: string; // "us" (default) or "eu"
  allowList?: string[];
  blockList?: string[];
};

export async function _sendWithMailgun(
  params: EmailParams,
  options?: MailgunOptions
): Promise<EmailResult> {
  validateRecipients(params, options);

  const apiKey = options?.apiKey || process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Mailgun API key. Set MAILGUN_API_KEY env var or pass apiKey option."
    );
  }

  const domain = options?.domain || process.env.MAILGUN_DOMAIN;
  if (!domain) {
    throw new Error(
      "Missing Mailgun domain. Set MAILGUN_DOMAIN env var or pass domain option."
    );
  }
  if (domain.includes("/") || domain.includes("\\")) {
    throw new Error("Invalid Mailgun domain: must not contain path separators.");
  }

  const region = options?.region || process.env.MAILGUN_REGION || "us";
  const baseUrl = region === "eu"
    ? "https://api.eu.mailgun.net"
    : "https://api.mailgun.net";

  const formData = new URLSearchParams();
  formData.set("from", params.from);
  formData.set("subject", params.subject);
  formData.set("to", toArray(params.to).join(","));

  if (params.html) formData.set("html", params.html);
  if (params.text) formData.set("text", params.text);
  if (params.cc) formData.set("cc", toArray(params.cc).join(","));
  if (params.bcc) formData.set("bcc", toArray(params.bcc).join(","));
  if (params.replyTo) formData.set("h:Reply-To", params.replyTo);

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

  const data = await response.json() as { id: string };
  return { id: data.id, provider: "mailgun" };
}
