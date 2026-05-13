import { describe, it, expect, vi } from "vitest";
import { promisify } from "util";
import { isSuccess, isFailure } from "agency-lang/runtime";

vi.mock("child_process", () => {
  let impl: ((args: string[]) => { stdout: string; stderr: string } | { error: Error & { stderr?: string } }) | null = null;
  const execFile = (..._args: unknown[]): unknown => undefined;
  // Make promisify(execFile) resolve to { stdout, stderr } and reject with the
  // mock's error (mirroring node's real child_process.execFile behavior).
  Object.defineProperty(execFile, promisify.custom, {
    value: async (_cmd: string, args: string[]) => {
      if (!impl) throw new Error("execFile mock not initialized");
      const out = impl(args);
      if ("error" in out) throw out.error;
      return out;
    },
  });
  return {
    execFile,
    __setExecFileImpl: (fn: typeof impl) => { impl = fn; },
  };
});

import * as cp from "child_process";
import { runGit, assertValidRefName } from "../../src/internal/git.js";

type MockResult = { stdout: string; stderr: string } | { error: Error & { stderr?: string } };
const setExecFile = (fn: (args: string[]) => MockResult): void => {
  (cp as unknown as { __setExecFileImpl: (fn: (args: string[]) => MockResult) => void }).__setExecFileImpl(fn);
};

describe("runGit", () => {
  it("returns success on exit 0", async () => {
    setExecFile(() => ({ stdout: "ok\n", stderr: "" }));
    const result = await runGit(["status"]);
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value.stdout).toBe("ok\n");
  });

  it("returns failure on non-zero exit", async () => {
    setExecFile(() => {
      const err = new Error("bad") as Error & { stderr?: string };
      err.stderr = "bad";
      return { error: err };
    });
    const result = await runGit(["status"]);
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(String(result.error)).toContain("bad");
  });
});

describe("assertValidRefName", () => {
  it("accepts simple names", () => {
    expect(() => assertValidRefName("feat/foo-bar")).not.toThrow();
    expect(() => assertValidRefName("v1.2.3")).not.toThrow();
  });
  it("rejects shell-meta and option-like strings", () => {
    for (const bad of ["--upload-pack=evil", "-x", "..", "a/.b", "a..b", "a b", "a@{0}", "a/", "/a", ""]) {
      expect(() => assertValidRefName(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });
});
