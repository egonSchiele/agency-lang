import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _sendSms } from "../sms.js";

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("_sendSms", () => {
  const originalFetch = globalThis.fetch;
  const originalSid = process.env.TWILIO_ACCOUNT_SID;
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalFrom = process.env.TWILIO_FROM_NUMBER;

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
    process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
    process.env.TWILIO_FROM_NUMBER = "+15550001234";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSid !== undefined) process.env.TWILIO_ACCOUNT_SID = originalSid;
    else delete process.env.TWILIO_ACCOUNT_SID;
    if (originalToken !== undefined) process.env.TWILIO_AUTH_TOKEN = originalToken;
    else delete process.env.TWILIO_AUTH_TOKEN;
    if (originalFrom !== undefined) process.env.TWILIO_FROM_NUMBER = originalFrom;
    else delete process.env.TWILIO_FROM_NUMBER;
  });

  it("sends SMS to correct Twilio endpoint", async () => {
    const mockFetch = mockFetchResponse({ sid: "SM123", status: "queued" });
    globalThis.fetch = mockFetch;

    await _sendSms("+15559876543", "Hello!");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json"
    );
    expect(init.method).toBe("POST");
  });

  it("uses Basic Auth with SID:Token", async () => {
    const mockFetch = mockFetchResponse({ sid: "SM123", status: "queued" });
    globalThis.fetch = mockFetch;

    await _sendSms("+15559876543", "Hello!");

    const [, init] = mockFetch.mock.calls[0];
    const expected = Buffer.from("AC_test_sid:test_auth_token").toString("base64");
    expect(init.headers["Authorization"]).toBe(`Basic ${expected}`);
  });

  it("sends correct form data", async () => {
    const mockFetch = mockFetchResponse({ sid: "SM456", status: "queued" });
    globalThis.fetch = mockFetch;

    await _sendSms("+15559876543", "Test message");

    const [, init] = mockFetch.mock.calls[0];
    const params = new URLSearchParams(init.body);
    expect(params.get("To")).toBe("+15559876543");
    expect(params.get("From")).toBe("+15550001234");
    expect(params.get("Body")).toBe("Test message");
  });

  it("returns sid and status", async () => {
    globalThis.fetch = mockFetchResponse({ sid: "SM789", status: "queued" });

    const result = await _sendSms("+15559876543", "Hi");

    expect(result).toEqual({ sid: "SM789", status: "queued" });
  });

  it("uses option params over env vars", async () => {
    const mockFetch = mockFetchResponse({ sid: "SM000", status: "queued" });
    globalThis.fetch = mockFetch;

    await _sendSms("+15559876543", "Hi", {
      accountSid: "AC_override",
      authToken: "override_token",
      from: "+15551111111",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("AC_override");
    const expected = Buffer.from("AC_override:override_token").toString("base64");
    expect(init.headers["Authorization"]).toBe(`Basic ${expected}`);
    const params = new URLSearchParams(init.body);
    expect(params.get("From")).toBe("+15551111111");
  });

  it("throws when no account SID", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    await expect(_sendSms("+15559876543", "Hi")).rejects.toThrow(
      "TWILIO_ACCOUNT_SID"
    );
  });

  it("throws when no auth token", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    await expect(_sendSms("+15559876543", "Hi")).rejects.toThrow(
      "TWILIO_AUTH_TOKEN"
    );
  });

  it("throws when no from number", async () => {
    delete process.env.TWILIO_FROM_NUMBER;
    await expect(_sendSms("+15559876543", "Hi")).rejects.toThrow(
      "TWILIO_FROM_NUMBER"
    );
  });

  it("throws on error response", async () => {
    globalThis.fetch = mockFetchResponse({ message: "Invalid number" }, 400);
    await expect(_sendSms("+15559876543", "Hi")).rejects.toThrow(
      "Twilio API error (400)"
    );
  });

  it("URL-encodes account SID in path", async () => {
    const mockFetch = mockFetchResponse({ sid: "SM123", status: "queued" });
    globalThis.fetch = mockFetch;

    await _sendSms("+15559876543", "Hi", {
      accountSid: "AC test/weird",
      authToken: "token",
      from: "+15550001234",
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("AC%20test%2Fweird");
  });
});
