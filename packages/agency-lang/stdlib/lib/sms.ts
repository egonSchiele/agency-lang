import { checkRecipients } from "./messaging.js";

const TWILIO_BASE_URL = "https://api.twilio.com/2010-04-01/Accounts";

export type SmsResult = {
  sid: string;
  status: string;
};

export type SmsOptions = {
  accountSid?: string;
  authToken?: string;
  from?: string;
  allowList?: string[];
  blockList?: string[];
};

export async function _sendSms(
  to: string,
  body: string,
  options?: SmsOptions
): Promise<SmsResult> {
  const accountSid = options?.accountSid || process.env.TWILIO_ACCOUNT_SID;
  if (!accountSid) {
    throw new Error(
      "Missing Twilio Account SID. Set TWILIO_ACCOUNT_SID env var or pass accountSid option."
    );
  }

  const authToken = options?.authToken || process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    throw new Error(
      "Missing Twilio Auth Token. Set TWILIO_AUTH_TOKEN env var or pass authToken option."
    );
  }

  const from = options?.from || process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    throw new Error(
      "Missing Twilio phone number. Set TWILIO_FROM_NUMBER env var or pass from option."
    );
  }

  if (!to) {
    throw new Error("Missing recipient phone number.");
  }
  if (!/^\+[1-9]\d{1,14}$/.test(to)) {
    throw new Error(
      `Invalid phone number "${to}". Must be in E.164 format (e.g. "+15551234567").`
    );
  }
  if (!body) {
    throw new Error("Missing message body.");
  }

  const recipientError = checkRecipients(
    [to],
    options?.allowList ?? [],
    options?.blockList ?? [],
  );
  if (recipientError) throw new Error(recipientError);

  const formData = new URLSearchParams();
  formData.set("To", to);
  formData.set("From", from);
  formData.set("Body", body);

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(
    `${TWILIO_BASE_URL}/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Twilio API error (${response.status}): ${responseBody}`);
  }

  const data = await response.json() as { sid: string; status: string };
  return { sid: data.sid, status: data.status };
}
