import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { memoryHost, type MemoryHost } from "../host/memoryHost.js";
import { inFrameOf, makeMockCtx } from "../runtime/__tests__/testHelpers.js";
import { FakeClock } from "../runtime/clock.js";
import type { HeldJob } from "../runtime/jobs/heldJobs.js";
import { STOP_FILE, jobDir, writeRecord, type JobRecord } from "../runtime/jobs/jobRecord.js";
import { scriptedSubprocess } from "../runtime/jobs/__tests__/scriptedSubprocess.js";
import { _readHeldJob, _stopHeldJob, _waitForJobEnd } from "./jobs.js";

const HOME = "/home/me/.agency";
const ID = "job-000001";

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    id: ID,
    kind: "shell",
    label: "sleep 30",
    command: "sleep 30",
    cwd: "/work",
    maxMs: 60_000,
    state: "running",
    exitCode: null,
    note: "",
    startedAt: 0,
    endedAt: null,
    runnerPid: 500,
    runnerStartedAt: 1_000_000,
    commandPid: 501,
    commandStartedAt: 1_000_000,
    token: "token-1",
    ...overrides,
  };
}

function held(token: string): HeldJob {
  return {
    handle: { id: ID, kind: "shell", label: "sleep 30", startedAt: 0 },
    read: { stdout: 0, stderr: 0 },
    finalRead: false,
    token,
  };
}

/** A run holding one job, whose record is `rec`, on a memory host. */
async function runHolding(rec: JobRecord, token: string) {
  const host: MemoryHost = memoryHost({
    variables: { AGENCY_HOME: HOME },
    subprocess: scriptedSubprocess().subprocess,
    clock: new FakeClock(),
  });
  const dir = jobDir(host, ID);
  await host.files.mkdir(await host.files.root("/"), dir.slice(1));
  await writeRecord(host, dir, rec);
  const ctx = makeMockCtx();
  ctx.host = host;
  ctx.heldJobs = [held(token)];
  const controller = new AbortController();
  ctx.getAbortSignal = () => controller.signal;
  const call = <T>(fn: () => Promise<T>): Promise<T> => inFrameOf(ctx, ctx.stateStack, fn);
  const heldJob = (): HeldJob => ctx.heldJobs[0];
  return { host, dir, controller, call, held: heldJob };
}

describe("_waitForJobEnd", () => {
  it("leaves no listener on the run's signal", async () => {
    const run = await runHolding(record({ state: "ended", exitCode: 0, endedAt: 5 }), "token-1");
    await run.call(() => _waitForJobEnd(ID, 5));
    await run.call(() => _waitForJobEnd(ID, 0));
    expect(getEventListeners(run.controller.signal, "abort")).toHaveLength(0);
  });
});

describe("a held job whose record is not on this machine", () => {
  it("says it may still be running elsewhere, and is not marked as read", async () => {
    const run = await runHolding(record(), "token-1");
    run.host.state.files = {};
    const report = await run.call(() => _readHeldJob(ID));
    expect(report.note).toBe(
      "This job's record is not on this machine. It may still be running where it was started, or its folder was removed with `agency jobs clean`.",
    );
    expect(run.held().finalRead).toBe(false);
  });
});

describe("a held id whose token does not match", () => {
  it("is not stopped, and reads as a job whose record is gone", async () => {
    const run = await runHolding(record(), "forged");
    const report = await run.call(() => _stopHeldJob(ID));
    expect(report.state).toBe("ended");
    expect(report.note).toMatch(/^This job's record is not on this machine\./);
    expect(run.host.state.files[`${run.dir}/${STOP_FILE}`]).toBeUndefined();
  });
});
