import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _sendIMessage } from "../imessage.js";

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: "", stderr: "" });
  }),
}));

import { execFile } from "child_process";

describe("_sendIMessage", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("calls osascript with AppleScript", async () => {
    const result = await _sendIMessage("+15551234567", "Hello!");

    expect(result).toEqual({ sent: true });
    expect(execFile).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining("+15551234567")],
      expect.any(Function)
    );
  });

  it("includes message in script", async () => {
    await _sendIMessage("+15551234567", "Test message");

    const [, args] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[1]).toContain("Test message");
  });

  it("escapes double quotes in recipient and message", async () => {
    await _sendIMessage('user"@test.com', 'say "hello"');

    const [, args] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const script = args[1];
    expect(script).toContain('user\\"@test.com');
    expect(script).toContain('say \\"hello\\"');
  });

  it("escapes backslashes", async () => {
    await _sendIMessage("+15551234567", "path\\to\\file");

    const [, args] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const script = args[1];
    expect(script).toContain("path\\\\to\\\\file");
  });

  it("escapes newlines to prevent AppleScript injection", async () => {
    await _sendIMessage("+15551234567", "line1\nline2\rline3\r\nline4");

    const [, args] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const script = args[1];
    // All line breaks should be escaped as \n, not literal newlines in the AppleScript string
    expect(script).toContain("line1\\nline2\\nline3\\nline4");
    // Should not contain unescaped newlines within the send command's string literal
    expect(script.match(/send "[^"]*\n[^"]*"/)).toBeNull();
  });

  it("escapes tabs", async () => {
    await _sendIMessage("+15551234567", "col1\tcol2");

    const [, args] = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const script = args[1];
    expect(script).toContain("col1\\tcol2");
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

  it("throws with stderr info when osascript fails, without leaking script contents", async () => {
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
