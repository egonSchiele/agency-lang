import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../host/nodeSubprocess.js", () => ({
  nodeSubprocess: { run: vi.fn(async () => exited()), start: vi.fn() },
}));

// detectPlatform caches its answer, so overriding process.platform is not
// enough to pin the macOS branch. Mock the detector itself.
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  detectPlatform: vi.fn(async () => "macos" as const),
}));

import { nodeSubprocess } from "../../host/nodeSubprocess.js";
import { exited, failed, programRun } from "./fakeSubprocess.js";

const run = nodeSubprocess.run as unknown as ReturnType<typeof vi.fn>;
import { _notify } from "../notify.js";

function osascriptArgs(): string[] {
  return programRun(run).args;
}

describe("_notify on macOS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the message and title as argv, not as script source", async () => {
    await _notify("Build done", "3 tests failed");

    // _notify(title, message); the script reads message first, then title.
    expect(programRun(run)).toEqual({
      program: "osascript",
      args: ["-e", expect.any(String), "3 tests failed", "Build done"],
    });

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
