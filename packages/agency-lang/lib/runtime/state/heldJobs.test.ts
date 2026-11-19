import { describe, expect, it } from "vitest";
import type { HeldJob } from "../jobs/heldJobs.js";
import { Checkpoint } from "./checkpointStore.js";
import { RuntimeContext } from "./context.js";
import { pausedCheckpointSchema } from "./schemas.js";

function makeContext() {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: "/project",
  });
}

function held(id: string, read = 0): HeldJob {
  return {
    handle: { id, kind: "shell", label: `job ${id}`, startedAt: 1000 },
    read: { stdout: read, stderr: 0 },
    finalRead: false,
    token: `token-${id}`,
  };
}

const AT_MAIN = { moduleId: "main.agency", scopeName: "main", stepPath: "0" };

/** An execution context inside a node, where a checkpoint can be taken. */
async function inNode() {
  const ctx = await makeContext().createExecutionContext({ runId: "run-1" });
  ctx.stateStack.nodesTraversed.push("main");
  return ctx;
}

async function checkpointHolding(jobs: HeldJob[]): Promise<Checkpoint> {
  const ctx = await inNode();
  ctx.heldJobs = jobs;
  return Checkpoint.fromContext(ctx, AT_MAIN);
}

describe("held jobs in a checkpoint", () => {
  it("survive a checkpoint parsed back as a paused run's value", async () => {
    const checkpoint = await checkpointHolding([held("job-000001", 4), held("job-000002")]);
    const json = JSON.parse(JSON.stringify(checkpoint.toJSON()));
    const parsed = pausedCheckpointSchema.parse({ type: "paused", checkpoint: json, runId: "r" });
    const revived = Checkpoint.fromJSON(parsed.checkpoint)!;
    expect(revived.heldJobs).toEqual([held("job-000001", 4), held("job-000002")]);
  });

  it("are left out of a checkpoint of a run that holds none", async () => {
    const checkpoint = await checkpointHolding([]);
    expect("heldJobs" in checkpoint.toJSON()).toBe(false);
  });

  it("are a copy, so a later read does not change a checkpoint already taken", async () => {
    const ctx = await inNode();
    ctx.heldJobs = [held("job-000001")];
    const checkpoint = Checkpoint.fromContext(ctx, AT_MAIN);
    ctx.heldJobs[0].read.stdout = 99;
    expect(checkpoint.heldJobs?.[0].read.stdout).toBe(0);
  });
});

describe("adoptHeldJobs", () => {
  it("adds the checkpoint's jobs and keeps the ones the context holds", async () => {
    const ctx = await makeContext().createExecutionContext({ runId: "run-1" });
    ctx.heldJobs = [held("job-000001"), held("job-000003", 5)];
    ctx.adoptHeldJobs([held("job-000001"), held("job-000002")]);
    expect(ctx.heldJobs).toEqual([held("job-000001"), held("job-000003", 5), held("job-000002")]);
  });

  it("takes the checkpoint's read positions for a job in both, as a rewind replays the reads", async () => {
    const ctx = await makeContext().createExecutionContext({ runId: "run-1" });
    ctx.heldJobs = [{ ...held("job-000001", 7), finalRead: true }];
    ctx.adoptHeldJobs([held("job-000001", 2)]);
    expect(ctx.heldJobs).toEqual([held("job-000001", 2)]);
  });

  it("drops an entry whose id is not a job id", async () => {
    const ctx = await makeContext().createExecutionContext({ runId: "run-1" });
    ctx.adoptHeldJobs([held("../../x"), held("job-000002")]);
    expect(ctx.heldJobs.map((job) => job.handle.id)).toEqual(["job-000002"]);
  });

  it("runs when a checkpoint is restored", async () => {
    const checkpoint = await checkpointHolding([held("job-000003")]);
    const ctx = await makeContext().createExecutionContext({ runId: "run-2" });
    ctx.restoreState(checkpoint);
    expect(ctx.heldJobs).toEqual([held("job-000003")]);
  });
});
