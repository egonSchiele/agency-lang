import { describe, it, expect } from "vitest";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { AgencyAbort, makeAbortCause } from "../runtime/errors.js";
import { isFailure } from "../runtime/result.js";
import { _runGuarded } from "./thread.js";

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
    const execCtx = await ctx.createExecutionContext("r1");
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
      expect((result as { error: { type: string } }).error.type).toBe("timeoutFailure");
      expect((result as { functionName: string | null }).functionName).toBe("guard");
    });
  });

  it("re-throws a trip it does NOT own (outer guard's id), preserving the abort", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
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
