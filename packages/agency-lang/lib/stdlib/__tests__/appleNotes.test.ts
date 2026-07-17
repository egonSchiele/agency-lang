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
import {
  runNotesScript,
  withTimeout,
  FIELD_DELIM,
  _preflightNote,
  assertNotLocked,
} from "../appleNotes.js";

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

describe("_preflightNote", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("never chains a property read through container", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    const script = args[1];
    // `name of container of n` errors -1728 on EVERY note, locked or not.
    // Spec section 9.2. This test exists so a "tidying" refactor cannot
    // silently reintroduce the chained form.
    expect(script).not.toContain("name of container of n");
    expect(script).toContain("set c to container of n");
  });

  it("walks up to the account rather than assuming one hop", async () => {
    mockStdout(["Q3", "2017", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    const script = args[1];
    // A folder's container is its PARENT FOLDER when nested, not the account.
    // Measured: `container of folder "2017"` is "Archived", not "iCloud". One
    // hop would put a folder name in the account field, and a policy matching
    // {"account": "iCloud"} would silently stop matching.
    expect(script).toContain("class of a) is account");
    expect(script).toContain("set a to container of a");
  });

  it("fails closed if the account walk does not reach an account", async () => {
    mockStdout(["Q3", "2017", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    // The walk is bounded. If it never lands on an account, error rather than
    // returning a folder name as the account.
    expect(args[1]).toContain("Could not resolve the account");
  });

  it("reads only title, folder, account and the locked flag — never the body", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    const script = args[1];
    // This query is not interrupt-gated, so it must never touch content.
    expect(script).not.toContain("body of");
    expect(script).not.toContain("plaintext of");
  });

  it("passes the id as argv, not in the script", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[2]).toBe("x-coredata://note/1");
    expect(args[1]).not.toContain("x-coredata://note/1");
  });

  it("parses the delimited fields", async () => {
    mockStdout(["Q3 Planning", "Work", "iCloud", "false"].join(FIELD_DELIM));
    const p = await _preflightNote("x-coredata://note/1");
    expect(p).toEqual({
      id: "x-coredata://note/1",
      title: "Q3 Planning",
      folder: "Work",
      account: "iCloud",
      locked: false,
    });
  });

  it("parses a title containing a tab, which the delimiter must survive", async () => {
    mockStdout(["a\tb", "Work", "iCloud", "false"].join(FIELD_DELIM));
    const p = await _preflightNote("x-coredata://note/1");
    expect(p.title).toBe("a\tb");
    expect(p.folder).toBe("Work");
  });

  it("reads the locked flag as true", async () => {
    mockStdout(["Secret", "Work", "iCloud", "true"].join(FIELD_DELIM));
    const p = await _preflightNote("x-coredata://note/1");
    expect(p.locked).toBe(true);
  });

  it("fails on a malformed reply rather than guessing", async () => {
    mockStdout("only one field");
    await expect(_preflightNote("x-coredata://note/1")).rejects.toThrow(/unexpected reply/i);
  });
});

describe("assertNotLocked", () => {
  const base = {
    id: "x-coredata://note/1",
    title: "Q3 Planning",
    folder: "Work",
    account: "iCloud",
  };

  it("passes an unlocked note through", () => {
    expect(() => assertNotLocked({ ...base, locked: false })).not.toThrow();
  });

  // THIS IS DATA-LOSS PREVENTION, NOT A NICE ERROR MESSAGE.
  // A locked note's body reads as an EMPTY STRING rather than erroring, so an
  // append that skipped this guard would run `set body of n to "" & newText`
  // and replace the note's contents with the appended text. Spec section 2.7.
  // If this test is failing, do not delete it. The guard is why locked notes
  // survive.
  it("refuses a locked note and names it", () => {
    expect(() => assertNotLocked({ ...base, locked: true })).toThrow(/Q3 Planning/);
    expect(() => assertNotLocked({ ...base, locked: true })).toThrow(/locked/i);
    expect(() => assertNotLocked({ ...base, locked: true })).toThrow(/Unlock it in Notes\.app/);
  });
});
