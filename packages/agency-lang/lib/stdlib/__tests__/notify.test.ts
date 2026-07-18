import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: "", stderr: "" });
  }),
}));

// detectPlatform caches its answer, so overriding process.platform is not
// enough to pin the macOS branch. Mock the detector itself.
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  detectPlatform: vi.fn(async () => "macos" as const),
}));

import { execFile } from "child_process";
import { _notify } from "../builtins.js";

function osascriptArgs(): string[] {
  const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls[0][1];
}

describe("_notify on macOS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the message and title as argv, not as script source", async () => {
    await _notify("Build done", "3 tests failed");

    // _notify(title, message); the script reads message first, then title.
    expect(execFile).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.any(String), "3 tests failed", "Build done"],
      expect.any(Function),
    );

    const script = osascriptArgs()[1];
    expect(script).not.toContain("Build done");
    expect(script).not.toContain("3 tests failed");
  });

  // `notify` is reachable from model-authored text, so treat its arguments as
  // untrusted the same way `sendIMessage` does.
  it("treats a hostile message as data, not code", async () => {
    const payload = '" & (do shell script "touch /tmp/pwned") & "';
    await _notify("title", payload);
    const args = osascriptArgs();

    expect(args[2]).toBe(payload);
    expect(args[1]).not.toContain("do shell script");
  });

  it("treats a hostile title as data, not code", async () => {
    const payload = 'hi\ndo shell script "touch /tmp/pwned"\ndisplay notification "x';
    await _notify(payload, "message");
    const args = osascriptArgs();

    expect(args[3]).toBe(payload);
    expect(args[1]).not.toContain("do shell script");
  });
});
