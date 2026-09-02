import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the subprocess layer so no real keyring is consulted and the options
// _getSecret hands to execFile can be inspected.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile } from "child_process";
import { _getSecret } from "./keyring.js";

const execFileMock = vi.mocked(execFile);

function lastOptions(): Record<string, unknown> {
  const call = execFileMock.mock.calls.at(-1)!;
  // promisify(execFile) passes (file, args, options, callback).
  return call[2] as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  execFileMock.mockReset();
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "_getSecret timeout",
  () => {
    it("passes the caller's timeout to the subprocess", async () => {
      execFileMock.mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (e: null, r: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: "tok\n", stderr: "" });
      }) as never);
      expect(await _getSecret("k", "svc", 1234)).toBe("tok");
      expect(lastOptions()).toEqual({ timeout: 1234 });
    });

    it("sets no timeout when the caller gives none", async () => {
      execFileMock.mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (e: null, r: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: "tok", stderr: "" });
      }) as never);
      await _getSecret("k");
      expect(lastOptions()).toEqual({});
    });

    it("reads a killed-at-deadline lookup as a miss", async () => {
      execFileMock.mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (e: Error) => void;
        callback(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }));
      }) as never);
      expect(await _getSecret("k", "svc", 10)).toBeNull();
    });
  },
);
