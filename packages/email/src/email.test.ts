import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmail } from "./email.js";

// Mock nodemailer
vi.mock("nodemailer", () => {
  const sendMailMock = vi.fn().mockResolvedValue({
    messageId: "<test-msg-id@example.com>",
    accepted: ["you@example.com"],
    rejected: [],
  });

  return {
    default: {
      createTransport: vi.fn().mockReturnValue({
        sendMail: sendMailMock,
      }),
    },
  };
});

import nodemailer from "nodemailer";

describe("sendEmail", () => {
  const originalHost = process.env.SMTP_HOST;
  const originalPort = process.env.SMTP_PORT;
  const originalUser = process.env.SMTP_USER;
  const originalPass = process.env.SMTP_PASS;
  const originalSecure = process.env.SMTP_SECURE;

  beforeEach(() => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@example.com";
    process.env.SMTP_PASS = "password123";
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalHost !== undefined) process.env.SMTP_HOST = originalHost;
    else delete process.env.SMTP_HOST;
    if (originalPort !== undefined) process.env.SMTP_PORT = originalPort;
    else delete process.env.SMTP_PORT;
    if (originalUser !== undefined) process.env.SMTP_USER = originalUser;
    else delete process.env.SMTP_USER;
    if (originalPass !== undefined) process.env.SMTP_PASS = originalPass;
    else delete process.env.SMTP_PASS;
    if (originalSecure !== undefined) process.env.SMTP_SECURE = originalSecure;
    else delete process.env.SMTP_SECURE;
  });

  it("creates transport with env var config", async () => {
    await sendEmail({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello!",
    });

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "user@example.com", pass: "password123" },
    });
  });

  it("uses options over env vars", async () => {
    await sendEmail(
      { from: "me@example.com", to: "you@example.com", subject: "Hi", text: "Hello!" },
      { host: "smtp.custom.com", port: 465, secure: true, user: "custom", pass: "secret" }
    );

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "smtp.custom.com",
      port: 465,
      secure: true,
      auth: { user: "custom", pass: "secret" },
    });
  });

  it("sends mail with correct parameters", async () => {
    await sendEmail({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Test",
      html: "<b>Hi</b>",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
    });

    const transport = (nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Test",
      html: "<b>Hi</b>",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
    });
  });

  it("returns message ID and accepted/rejected", async () => {
    const result = await sendEmail({
      from: "me@example.com",
      to: "you@example.com",
      subject: "Hi",
      text: "Hello!",
    });

    expect(result).toEqual({
      messageId: "<test-msg-id@example.com>",
      accepted: ["you@example.com"],
      rejected: [],
    });
  });

  it("throws when no SMTP host available", async () => {
    delete process.env.SMTP_HOST;
    await expect(
      sendEmail({ from: "a@b.com", to: "c@d.com", subject: "x", text: "y" })
    ).rejects.toThrow("SMTP_HOST");
  });

  it("joins array recipients with commas", async () => {
    await sendEmail({
      from: "me@example.com",
      to: ["a@b.com", "c@d.com"],
      subject: "Hi",
      text: "Hello!",
    });

    const transport = (nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@b.com, c@d.com" })
    );
  });
});
