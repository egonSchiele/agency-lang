import { describe, it, expect, vi, afterEach } from "vitest";
import { RuntimeContext } from "./state/context.js";
import { resumeFromCheckpoint } from "./interrupts.js";
import { CheckpointCodeChangedError } from "./errors.js";
import { makeCheckpoint } from "./checkpointTestHelpers.js";
import { installRunPolicyHandler } from "./runPolicyHandler.js";

vi.mock("./runPolicyHandler.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./runPolicyHandler.js")>();
  return { ...original, installRunPolicyHandler: vi.fn(original.installRunPolicyHandler) };
});

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

describe("resumeFromCheckpoint", () => {
  afterEach(() => {
    vi.mocked(installRunPolicyHandler).mockClear();
  });

  it("refuses a checkpoint whose module fingerprints no longer match", async () => {
    const cp = makeCheckpoint();
    cp.moduleFingerprints = { "mod-that-changed": { hash: "stale", compiledAt: "then" } };
    await expect(
      resumeFromCheckpoint({
        ctx: makeCtx(),
        paused: { type: "paused", checkpoint: cp, runId: "run-1" },
      }),
    ).rejects.toBeInstanceOf(CheckpointCodeChangedError);
  });

  it("refuses a paused value with no run id", async () => {
    const cp = makeCheckpoint();
    await expect(
      resumeFromCheckpoint({
        ctx: makeCtx(),
        paused: { type: "paused", checkpoint: cp, runId: "" },
      }),
    ).rejects.toThrow(/run id/);
  });

  it("installs the policy passed in the invocation options", async () => {
    const policy = { "std::env": [{ action: "reject" as const }] };
    // The empty checkpoint has no graph to run, so the resume fails after the
    // restore. The assertion is on the install, which happens during restore.
    await resumeFromCheckpoint({
      ctx: makeCtx(),
      paused: { type: "paused", checkpoint: makeCheckpoint(), runId: "run-1" },
      invocation: { policy },
    }).catch(() => undefined);
    expect(installRunPolicyHandler).toHaveBeenCalledWith(expect.anything(), policy);
  });
});
