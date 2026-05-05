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

  it("throws with descriptive error when osascript fails", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error("Messages app not available"));
      }
    );

    await expect(_sendIMessage("+15551234567", "Hi")).rejects.toThrow(
      "Failed to send iMessage: Messages app not available"
    );
  });
});
