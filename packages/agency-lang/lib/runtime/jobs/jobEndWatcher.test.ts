import { describe, expect, it, vi } from "vitest";
import { memoryHost, type MemoryHost } from "../../host/memoryHost.js";
import { FakeClock } from "../clock.js";
import type { HeldJob } from "./heldJobs.js";
import { WATCH_POLL_MS, watchHeldJobs } from "./jobEndWatcher.js";
import { changeRecord, jobDir, writeRecord, type JobRecord } from "./jobRecord.js";
import { scriptedSubprocess, settle } from "./__tests__/scriptedSubprocess.js";

const HOME = "/home/me/.agency";

function record(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    id,
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

function held(id: string): HeldJob {
  return {
    handle: { id, kind: "shell", label: "sleep 30", startedAt: 0 },
    read: { stdout: 0, stderr: 0 },
    finalRead: false,
    token: "token-1",
  };
}

function setUp() {
  const clock = new FakeClock();
  const host = memoryHost({
    variables: { AGENCY_HOME: HOME },
    subprocess: scriptedSubprocess().subprocess,
    clock,
  });
  const jobs: HeldJob[] = [];
  const ended: JobRecord[] = [];
  const poll = async () => {
    clock.advance(WATCH_POLL_MS);
    await settle();
  };
  return { clock, host, jobs, ended, poll };
}

async function place(host: MemoryHost, rec: JobRecord): Promise<string> {
  const dir = jobDir(host, rec.id);
  await host.files.mkdir(await host.files.root("/"), dir.slice(1));
  await writeRecord(host, dir, rec);
  return dir;
}

const end = (host: MemoryHost, dir: string) =>
  changeRecord(host, dir, (current) => ({ ...current, state: "ended", exitCode: 0, endedAt: 5 }));

describe("watchHeldJobs", () => {
  it("reports a held job that ends, once, with its record", async () => {
    const { host, jobs, ended, poll } = setUp();
    const dir = await place(host, record("job-000001"));
    jobs.push(held("job-000001"));
    const stop = watchHeldJobs({ host, held: () => jobs, ended: (job) => ended.push(job) });
    await settle();
    await end(host, dir);
    await poll();
    await poll();
    expect(ended.map((job) => [job.id, job.state, job.exitCode])).toEqual([
      ["job-000001", "ended", 0],
    ]);
    stop();
  });

  it("reports a job added to the list after the watch began", async () => {
    const { host, jobs, ended, poll } = setUp();
    const stop = watchHeldJobs({ host, held: () => jobs, ended: (job) => ended.push(job) });
    await settle();
    const dir = await place(host, record("job-000002"));
    jobs.push(held("job-000002"));
    await poll();
    await end(host, dir);
    await poll();
    expect(ended.map((job) => job.id)).toEqual(["job-000002"]);
    stop();
  });

  it("reports a job that started and ended between two polls", async () => {
    const { host, clock, jobs, ended, poll } = setUp();
    const stop = watchHeldJobs({ host, held: () => jobs, ended: (job) => ended.push(job) });
    await settle();
    const endedAt = clock.wallTime() + 500;
    await place(host, record("job-000004", { state: "ended", exitCode: 2, endedAt }));
    jobs.push(held("job-000004"));
    await poll();
    expect(ended.map((job) => job.id)).toEqual(["job-000004"]);
    stop();
  });

  it("tries a read that failed again on the next poll", async () => {
    const { host, jobs, ended, poll } = setUp();
    const dir = await place(host, record("job-000005"));
    jobs.push(held("job-000005"));
    const readText = host.files.readText;
    let failing = true;
    host.files.readText = async (root, target) => {
      if (failing) {
        throw new Error("busy");
      }
      return readText(root, target);
    };
    const stop = watchHeldJobs({ host, held: () => jobs, ended: (job) => ended.push(job) });
    await settle();
    failing = false;
    await poll();
    await end(host, dir);
    await poll();
    expect(ended.map((job) => job.id)).toEqual(["job-000005"]);
    stop();
  });

  it("does not report a job that had ended before it was first seen", async () => {
    const { host, jobs, ended, poll } = setUp();
    await place(host, record("job-000003", { state: "ended", exitCode: 0, endedAt: 5 }));
    jobs.push(held("job-000003"));
    const stop = watchHeldJobs({ host, held: () => jobs, ended: (job) => ended.push(job) });
    await settle();
    await poll();
    expect(ended).toEqual([]);
    stop();
  });

  it("keeps watching when a listener throws", async () => {
    const { host, jobs, poll } = setUp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await place(host, record("job-000001"));
    const second = await place(host, record("job-000002"));
    jobs.push(held("job-000001"), held("job-000002"));
    const heard: string[] = [];
    const stop = watchHeldJobs({
      host,
      held: () => jobs,
      ended: (job) => {
        heard.push(job.id);
        throw new Error("readline was closed");
      },
    });
    await settle();
    await end(host, first);
    await poll();
    await end(host, second);
    await poll();
    expect(heard).toEqual(["job-000001", "job-000002"]);
    stop();
    warn.mockRestore();
  });

  it("reads nothing more once stopped", async () => {
    const { host, jobs, poll } = setUp();
    await place(host, record("job-000001"));
    jobs.push(held("job-000001"));
    let reads = 0;
    const stop = watchHeldJobs({
      host,
      held: () => {
        reads += 1;
        return jobs;
      },
      ended: () => {},
    });
    await settle();
    stop();
    const readsWhenStopped = reads;
    await poll();
    await poll();
    expect(reads).toBe(readsWhenStopped);
  });
});
