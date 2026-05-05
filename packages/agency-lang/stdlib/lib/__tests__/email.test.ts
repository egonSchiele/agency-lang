import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _sendWithResend, _sendWithSendGrid, _sendWithMailgun } from "../email.js";

function mockFetchResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: {
      get: (name: string) => headers?.[name] ?? null,
    },
  });
}

describe("sendWithResend", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.RESEND_API_KEY;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.RESEND_API_KEY = originalEnv;
    } else {
      delete process.env.RESEND_API_KEY;
    }
  });

  it("sends email with correct endpoint and headers", async () => {
    const mockFetch = mockFetchResponse({ id: "msg-001" });
    globalThis.fetch = mockFetch;

    await _sendWithResend({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello!",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["Authorization"]).toBe("Bearer re_test123");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends correct body parameters", async () => {
    const mockFetch = mockFetchResponse({ id: "msg-002" });
    globalThis.fetch = mockFetch;

    await _sendWithResend({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Test",
      html: "<b>Hi</b>",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.from).toBe("me@example.com");
    expect(body.to).toEqual(["you@example.com"]);
    expect(body.subject).toBe("Test");
    expect(body.html).toBe("<b>Hi</b>");
    expect(body.cc).toEqual(["cc@example.com"]);
    expect(body.bcc).toEqual(["bcc@example.com"]);
    expect(body.reply_to).toBe("reply@example.com");
  });

  it("returns email ID and provider", async () => {
    globalThis.fetch = mockFetchResponse({ id: "msg-003" });

    const result = await _sendWithResend({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello",
    });

    expect(result).toEqual({ id: "msg-003", provider: "resend" });
  });

  it("uses apiKey option over env var", async () => {
    const mockFetch = mockFetchResponse({ id: "msg-004" });
    globalThis.fetch = mockFetch;

    await _sendWithResend(
      { from: "a@b.com", to: "c@d.com", subject: "x", text: "y" },
      { apiKey: "re_override" }
    );

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["Authorization"]).toBe("Bearer re_override");
  });

  it("throws when no API key available", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(
      _sendWithResend({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("RESEND_API_KEY");
  });

  it("throws on error response", async () => {
    globalThis.fetch = mockFetchResponse({ message: "Invalid API key" }, 401);
    await expect(
      _sendWithResend({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("Resend API error (401)");
  });
});

describe("sendWithSendGrid", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    process.env.SENDGRID_API_KEY = "SG.test123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.SENDGRID_API_KEY = originalEnv;
    } else {
      delete process.env.SENDGRID_API_KEY;
    }
  });

  it("sends email with correct endpoint and headers", async () => {
    const mockFetch = mockFetchResponse("", 202, { "x-message-id": "sg-001" });
    globalThis.fetch = mockFetch;

    await _sendWithSendGrid({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello!",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.headers["Authorization"]).toBe("Bearer SG.test123");
  });

  it("builds correct personalizations body", async () => {
    const mockFetch = mockFetchResponse("", 202, { "x-message-id": "sg-002" });
    globalThis.fetch = mockFetch;

    await _sendWithSendGrid({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Test",
      html: "<b>Hi</b>",
      cc: "cc@example.com",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.personalizations[0].to).toEqual([{ email: "you@example.com" }]);
    expect(body.personalizations[0].cc).toEqual([{ email: "cc@example.com" }]);
    expect(body.personalizations[0].subject).toBe("Test");
    expect(body.from).toEqual({ email: "me@example.com" });
    expect(body.content).toEqual([{ type: "text/html", value: "<b>Hi</b>" }]);
  });

  it("returns message ID from header", async () => {
    globalThis.fetch = mockFetchResponse("", 202, { "x-message-id": "sg-003" });

    const result = await _sendWithSendGrid({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "y",
    });

    expect(result).toEqual({ id: "sg-003", provider: "sendgrid" });
  });

  it("throws when no API key available", async () => {
    delete process.env.SENDGRID_API_KEY;
    await expect(
      _sendWithSendGrid({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("SENDGRID_API_KEY");
  });

  it("throws on error response", async () => {
    globalThis.fetch = mockFetchResponse({ errors: [{ message: "Forbidden" }] }, 403);
    await expect(
      _sendWithSendGrid({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("SendGrid API error (403)");
  });
});

describe("sendWithMailgun", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.MAILGUN_API_KEY;
  const originalDomain = process.env.MAILGUN_DOMAIN;
  const originalRegion = process.env.MAILGUN_REGION;

  beforeEach(() => {
    process.env.MAILGUN_API_KEY = "key-test123";
    process.env.MAILGUN_DOMAIN = "mg.example.com";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) process.env.MAILGUN_API_KEY = originalApiKey;
    else delete process.env.MAILGUN_API_KEY;
    if (originalDomain !== undefined) process.env.MAILGUN_DOMAIN = originalDomain;
    else delete process.env.MAILGUN_DOMAIN;
    if (originalRegion !== undefined) process.env.MAILGUN_REGION = originalRegion;
    else delete process.env.MAILGUN_REGION;
  });

  it("sends email to correct Mailgun endpoint", async () => {
    const mockFetch = mockFetchResponse({ id: "<msg-001@mg.example.com>" });
    globalThis.fetch = mockFetch;

    await _sendWithMailgun({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello!",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("uses Basic Auth with api:key format", async () => {
    const mockFetch = mockFetchResponse({ id: "<msg-002>" });
    globalThis.fetch = mockFetch;

    await _sendWithMailgun({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello!",
    });

    const [, init] = mockFetch.mock.calls[0];
    const expected = Buffer.from("api:key-test123").toString("base64");
    expect(init.headers["Authorization"]).toBe(`Basic ${expected}`);
  });

  it("sends correct form data", async () => {
    const mockFetch = mockFetchResponse({ id: "<msg-003>" });
    globalThis.fetch = mockFetch;

    await _sendWithMailgun({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Test",
      html: "<b>Hi</b>",
      cc: "cc@example.com",
    });

    const [, init] = mockFetch.mock.calls[0];
    const params = new URLSearchParams(init.body);
    expect(params.get("from")).toBe("me@example.com");
    expect(params.get("to")).toBe("you@example.com");
    expect(params.get("subject")).toBe("Test");
    expect(params.get("html")).toBe("<b>Hi</b>");
    expect(params.get("cc")).toBe("cc@example.com");
  });

  it("uses EU endpoint when region is eu", async () => {
    const mockFetch = mockFetchResponse({ id: "<msg-004>" });
    globalThis.fetch = mockFetch;

    await _sendWithMailgun(
      { from: "a@b.com", to: "c@d.com", subject: "x", text: "y" },
      { region: "eu" }
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
  });

  it("returns message ID and provider", async () => {
    globalThis.fetch = mockFetchResponse({ id: "<msg-005@mg.example.com>" });

    const result = await _sendWithMailgun({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "y",
    });

    expect(result).toEqual({ id: "<msg-005@mg.example.com>", provider: "mailgun" });
  });

  it("throws when no API key available", async () => {
    delete process.env.MAILGUN_API_KEY;
    await expect(
      _sendWithMailgun({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("MAILGUN_API_KEY");
  });

  it("throws when no domain available", async () => {
    delete process.env.MAILGUN_DOMAIN;
    await expect(
      _sendWithMailgun({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("MAILGUN_DOMAIN");
  });

  it("throws on error response", async () => {
    globalThis.fetch = mockFetchResponse({ message: "Forbidden" }, 401);
    await expect(
      _sendWithMailgun({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("Mailgun API error (401)");
  });
});
