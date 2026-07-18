import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _sendIMessage } from "../imessage.js";

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: "", stderr: "" });
  }),
}));

import { execFile } from "child_process";

/** The args array osascript was called with on the first (only) invocation. */
function osascriptArgs(): string[] {
  const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls[0][1];
}

describe("_sendIMessage", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("passes recipient and message as argv, not as script source", async () => {
    const result = await _sendIMessage("+15551234567", "Hello!");

    expect(result).toEqual({ sent: true });
    // Shape: ["-e", <script>, <recipient>, <message>]. No "-" separator:
    // osascript passes a bare "-" through as argv item 1 and shifts the rest.
    expect(execFile).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.any(String), "+15551234567", "Hello!"],
      expect.any(Function),
    );
  });

  it("keeps the script constant — no caller data is spliced into it", async () => {
    await _sendIMessage("+15551234567", "Test message");
    const script = osascriptArgs()[1];

    expect(script).not.toContain("+15551234567");
    expect(script).not.toContain("Test message");
  });

  // The reason this function is worth hardening: `sendIMessage` is handed to an
  // LLM as a tool, so `message` is model-authored and may echo a web page, an
  // email, or a file the agent read. These payloads must land as inert data.
  const hostile = [
    ['a quote-and-concat break-out', '" & (do shell script "touch /tmp/pwned") & "'],
    ['a statement injection', 'hi\nend tell\ndo shell script "touch /tmp/pwned"\ntell application "Messages"'],
    ['an escaped-quote break-out', 'hi\\" & (do shell script "touch /tmp/pwned") & \\"'],
    ['a tab and backslash payload', 'col1\tcol2\\path\\to\\file'],
  ] as const;

  for (const [description, payload] of hostile) {
    it(`treats ${description} as data, not code`, async () => {
      await _sendIMessage("+15551234567", payload);
      const args = osascriptArgs();

      // Verbatim in argv...
      expect(args[3]).toBe(payload);
      // ...and absent from the script osascript actually parses.
      expect(args[1]).not.toContain("do shell script");
      expect(args[1]).not.toContain(payload);
    });
  }

  it("treats a hostile recipient as data, not code", async () => {
    const payload = '" of targetService\ndo shell script "touch /tmp/pwned"\nset x to participant "';
    await _sendIMessage(payload, "Hi");
    const args = osascriptArgs();

    expect(args[2]).toBe(payload);
    expect(args[1]).not.toContain("do shell script");
  });

  it("throws on non-macOS platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    await expect(_sendIMessage("+15551234567", "Hi")).rejects.toThrow(
      "only available on macOS"
    );
  });

  it("throws when recipient is empty", async () => {
    await expect(_sendIMessage("", "Hi")).rejects.toThrow("Missing recipient");
  });

  it("throws when message is empty", async () => {
    await expect(_sendIMessage("+15551234567", "")).rejects.toThrow(
      "Missing message body"
    );
  });

  it("throws with stderr info when osascript fails, without leaking the message", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], cb: (err: unknown) => void) => {
        cb({ stderr: "execution error: Messages got an error", code: 1 });
      }
    );

    const err = await _sendIMessage("+15551234567", "Hi").catch((e) => e);
    expect(err.message).toContain("Failed to send iMessage:");
    expect(err.message).toContain("execution error");
    // Should NOT contain the phone number or message in the error
    expect(err.message).not.toContain("+15551234567");
  });
});
