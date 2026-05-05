import nodemailer from "nodemailer";

export type SmtpOptions = {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
};

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
  messageId: string;
  accepted: string[];
  rejected: string[];
};

function getSmtpConfig(options?: SmtpOptions) {
  const host = options?.host || process.env.SMTP_HOST;
  if (!host) {
    throw new Error(
      "Missing SMTP host. Set SMTP_HOST env var or pass host option."
    );
  }

  // port=0 means "not provided" — fall through to env or default
  const port = (options?.port && options.port > 0)
    ? options.port
    : (Number(process.env.SMTP_PORT) || 587);

  // secure is only explicitly set if port was explicitly provided as 465,
  // or SMTP_SECURE env is set. Otherwise default based on resolved port.
  const secure = options?.secure ?? (process.env.SMTP_SECURE === "true" || port === 465);

  const user = options?.user || process.env.SMTP_USER;
  const pass = options?.pass || process.env.SMTP_PASS;

  const config: Record<string, unknown> = { host, port, secure };

  if (user && pass) {
    config.auth = { user, pass };
  }

  return config;
}

export async function sendEmail(
  params: EmailParams,
  options?: SmtpOptions
): Promise<EmailResult> {
  const config = getSmtpConfig(options);
  const transporter = nodemailer.createTransport(config as nodemailer.TransportOptions);

  const mailOptions: nodemailer.SendMailOptions = {
    from: params.from,
    to: Array.isArray(params.to) ? params.to.join(", ") : params.to,
    subject: params.subject,
  };

  if (params.html) mailOptions.html = params.html;
  if (params.text) mailOptions.text = params.text;
  if (params.cc) mailOptions.cc = Array.isArray(params.cc) ? params.cc.join(", ") : params.cc;
  if (params.bcc) mailOptions.bcc = Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc;
  if (params.replyTo) mailOptions.replyTo = params.replyTo;

  try {
    const info = await transporter.sendMail(mailOptions);

    return {
      messageId: info.messageId ?? "",
      accepted: (info.accepted as string[]) ?? [],
      rejected: (info.rejected as string[]) ?? [],
    };
  } finally {
    transporter.close();
  }
}
