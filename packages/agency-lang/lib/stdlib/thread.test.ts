import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { AgencyAbort, makeAbortCause } from "../runtime/errors.js";
import { isFailure } from "../runtime/result.js";
import { MAX_REPLY_ATTACHMENT_BYTES } from "../config.js";
import { _runGuarded, _viewFilePrecheck } from "./thread.js";

describe("_viewFilePrecheck", () => {
  let tmp: string;
  beforeEach(() => {
    // realpath: on macOS os.tmpdir() sits under /var, which is a symlink.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viewfile-")));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies png as image and pdf as pdf", () => {
    const png = path.join(tmp, "a.png");
    const pdf = path.join(tmp, "b.pdf");
    fs.writeFileSync(png, "x");
    fs.writeFileSync(pdf, "x");
    expect(_viewFilePrecheck(png)).toEqual({ kind: "image" });
    expect(_viewFilePrecheck(pdf)).toEqual({ kind: "pdf" });
  });

  it("refuses an extension the reply pipeline cannot send", () => {
    const txt = path.join(tmp, "notes.txt");
    fs.writeFileSync(txt, "x");
    expect(() => _viewFilePrecheck(txt)).toThrow(/\.txt.*\.png/);
  });

  it("refuses a missing file", () => {
    expect(() => _viewFilePrecheck(path.join(tmp, "gone.png"))).toThrow(/not found/);
  });

  it("refuses a directory named like an image", () => {
    const dir = path.join(tmp, "folder.png");
    fs.mkdirSync(dir);
    expect(() => _viewFilePrecheck(dir)).toThrow(/not a regular file/);
  });

  it("refuses a file over the size cap", () => {
    const big = path.join(tmp, "big.png");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, MAX_REPLY_ATTACHMENT_BYTES + 1);
    fs.closeSync(fd);
    expect(() => _viewFilePrecheck(big)).toThrow(/attachment limit/);
  });
});

function makeCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

describe("_runGuarded — FailureOpts parity (C2)", () => {
  it("converts an OWNED guard trip and preserves functionName 'guard'", async () => {
    // The agency `try block()` this replaced lowered to __tryCall with
    // { checkpoint, functionName: <enclosing fn> = "guard", args }. _runGuarded
    // MUST forward the same opts (only adding ownedGuardIds) — a naive
    // { ownedGuardIds } would silently drop the Failure metadata that
    // retry/checkpoint + error reporting depend on.
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const block = () => {
        throw new AgencyAbort(
          "trip",
          makeAbortCause({
            kind: "guardTrip",
            dimension: "time",
            limit: 20,
            spent: 21,
            guardId: "g1",
          }),
        );
      };
      const result = await _runGuarded(["g1"], block);
      expect(isFailure(result)).toBe(true);
      expect((result as { data: { type: string } }).data.type).toBe("timeoutFailure");
      expect((result as { functionName: string | null }).functionName).toBe("guard");
    });
  });

  it("re-throws a trip it does NOT own (outer guard's id), preserving the abort", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const block = () => {
        throw new AgencyAbort(
          "trip",
          makeAbortCause({
            kind: "guardTrip",
            dimension: "time",
            limit: 20,
            spent: 21,
            guardId: "gOUTER",
          }),
        );
      };
      await expect(_runGuarded(["gINNER"], block)).rejects.toBeInstanceOf(AgencyAbort);
    });
  });
});
