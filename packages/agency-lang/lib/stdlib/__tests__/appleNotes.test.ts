import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: "", stderr: "" });
    },
  ),
}));

import { execFile } from "child_process";
import { runNotesScript, withTimeout, FIELD_DELIM } from "../appleNotes.js";

type MockFn = ReturnType<typeof vi.fn>;

/** Make the mocked execFile fail with the given stderr, as osascript does. */
function mockFailure(stderr: string): void {
  (execFile as unknown as MockFn).mockImplementationOnce(
    (_c: string, _a: string[], cb: (e: unknown) => void) => {
      cb({ stderr, code: 1 });
    },
  );
}

/** Make the mocked execFile succeed with the given stdout. */
function mockStdout(stdout: string): void {
  (execFile as unknown as MockFn).mockImplementationOnce(
    (
      _c: string,
      _a: string[],
      cb: (e: null, r: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

describe("runNotesScript", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("rejects immediately on a non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    await expect(runNotesScript("script", [])).rejects.toThrow(
      "Apple Notes is only available on macOS",
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("passes args straight through to argv with NO '-' separator", async () => {
    mockStdout("ok");
    await runNotesScript("SCRIPT", ["alpha", "beta"]);
    const [cmd, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(cmd).toBe("osascript");
    // The `-` is NOT a separator: osascript passes it through as argv item 1
    // and shifts every real argument. Spec section 3.6.
    expect(args).toEqual(["-e", "SCRIPT", "alpha", "beta"]);
  });

  it("keeps a hostile title inert in argv rather than in the script", async () => {
    mockStdout("ok");
    const hostile = '"; do shell script "rm -rf ~"; "';
    await runNotesScript("SCRIPT", [hostile]);
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).toBe("SCRIPT");
    expect(args[2]).toBe(hostile);
    expect(args[1]).not.toContain("do shell script");
  });

  it("maps -1743 to a clear not-authorized error", async () => {
    // Two awaited calls below, and mockFailure queues with
    // mockImplementationOnce — so queue it twice. vi.clearAllMocks() does NOT
    // clear the factory's default success implementation, so a second call
    // with nothing queued would RESOLVE and the assertion would fail.
    mockFailure("execution error: Not authorized to send Apple events to Notes. (-1743)");
    mockFailure("execution error: Not authorized to send Apple events to Notes. (-1743)");
    await expect(runNotesScript("s", [])).rejects.toThrow(/Not authorized to control Notes/);
    await expect(runNotesScript("s", [])).rejects.toThrow(/Privacy & Security/);
  });

  it("maps -1712 to a hedged timeout error", async () => {
    mockFailure("execution error: Notes got an error: AppleEvent timed out. (-1712)");
    // -1712 cannot distinguish "consent dialog unanswered" from "Notes wedged",
    // so the message must hedge. Spec section 2.8.
    await expect(runNotesScript("s", [])).rejects.toThrow(/usually means/);
  });

  it("surfaces an unrecognised stderr rather than swallowing it", async () => {
    mockFailure("execution error: something else entirely (-9999)");
    await expect(runNotesScript("s", [])).rejects.toThrow(/something else entirely/);
  });

  it("trims stdout", async () => {
    mockStdout("  value  \n");
    await expect(runNotesScript("s", [])).resolves.toBe("value");
  });
});

describe("withTimeout", () => {
  it("wraps the body so the 120s AppleScript default is not inherited", () => {
    const out = withTimeout("tell application \"Notes\"\nend tell");
    expect(out).toContain("with timeout of 30 seconds");
    expect(out).toContain("end timeout");
    expect(out).toContain("on run argv");
    expect(out).toContain("end run");
  });
});

describe("FIELD_DELIM", () => {
  it("is a control character, because titles can contain tabs", () => {
    expect(FIELD_DELIM).toBe("\u0001");
    expect(FIELD_DELIM).not.toBe("\t");
  });
});
