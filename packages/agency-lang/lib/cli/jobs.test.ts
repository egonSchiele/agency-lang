import { describe, expect, it } from "vitest";
import { EXIT_CODE_USAGE_ERROR } from "@/constants.js";
import { memoryHost, type MemoryHost } from "@/host/memoryHost.js";
import { FakeClock } from "@/runtime/clock.js";
import { jobDir, writeRecord, type JobRecord } from "@/runtime/jobs/jobRecord.js";
import { scriptedSubprocess } from "@/runtime/jobs/__tests__/scriptedSubprocess.js";
import { cleanJobsCommand, jobsListing, listJobsCommand, stopJobCommand } from "./jobs.js";

const HOME = "/home/me/.agency";
const MINUTE = 60_000;

function record(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    id,
    kind: "shell",
    label: "sleep 30",
    command: "sleep 30",
    cwd: "/work",
    maxMs: MINUTE,
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

function setUp() {
  const scripted = scriptedSubprocess();
  const host = memoryHost({
    variables: { AGENCY_HOME: HOME },
    subprocess: scripted.subprocess,
    clock: new FakeClock(),
  });
  return { host, scripted };
}

async function place(host: MemoryHost, rec: JobRecord): Promise<string> {
  const dir = jobDir(host, rec.id);
  await host.files.mkdir(await host.files.root("/"), dir.slice(1));
  await writeRecord(host, dir, rec);
  return dir;
}

/** Every file under the jobs folder, with its bytes as text. */
function snapshot(host: MemoryHost): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(host.state.files)) {
    if (name.startsWith(`${HOME}/jobs/`)) {
      files[name] = new TextDecoder().decode(bytes);
    }
  }
  return files;
}

describe("jobsListing", () => {
  it("says so when there are no jobs", () => {
    expect(jobsListing([], 0)).toBe("No jobs.");
  });

  it("shows one row a job, in the order given, with its state and running time", () => {
    const listing = jobsListing(
      [
        record("job-000002", { startedAt: 2 * MINUTE, label: "npm run dev" }),
        record("job-000001", {
          state: "ended",
          exitCode: 1,
          startedAt: 0,
          endedAt: 90_000,
          label: "make all",
        }),
      ],
      5 * MINUTE,
    );
    expect(listing.split("\n")).toEqual([
      "  ID          STATE    RAN     LABEL",
      "  job-000002  running  3m 0s   npm run dev",
      "  job-000001  exit 1   1m 30s  make all",
    ]);
  });

  it("does not cut or wrap a long label", () => {
    const label = "x".repeat(300);
    const listing = jobsListing([record("job-000001", { label })], MINUTE);
    expect(listing.split("\n")[1].endsWith(label)).toBe(true);
    expect(listing.split("\n")).toHaveLength(2);
  });
});

describe("agency jobs", () => {
  it("lists without changing any file of a running or an ended job", async () => {
    const { host } = setUp();
    await place(host, record("job-000001"));
    await place(host, record("job-000002", { state: "ended", exitCode: 0, endedAt: 10 }));
    const before = snapshot(host);
    const result = await listJobsCommand(host);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("job-000001");
    expect(result.text).toContain("job-000002");
    expect(snapshot(host)).toEqual(before);
  });

  it("ends a job whose runner is gone, as any reader does", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.states[500] = "gone";
    const result = await listJobsCommand(host);
    expect(result.text).toMatch(/job-000001\s+ended/);
    expect(scripted.stopped).toEqual([501]);
  });
});

describe("agency jobs stop", () => {
  it("reports text that is not a job id, and builds no path from it", async () => {
    const { host } = setUp();
    const result = await stopJobCommand(host, "../../x");
    expect(result).toEqual({ text: "There is no job ../../x.", exitCode: EXIT_CODE_USAGE_ERROR });
  });

  it("reports an id with no folder", async () => {
    const { host } = setUp();
    const result = await stopJobCommand(host, "job-0000ff");
    expect(result).toEqual({
      text: "There is no job job-0000ff.",
      exitCode: EXIT_CODE_USAGE_ERROR,
    });
  });

  it("says how a job that had already ended ended", async () => {
    const { host } = setUp();
    await place(host, record("job-000001", { state: "ended", exitCode: 0, endedAt: 10 }));
    const result = await stopJobCommand(host, "job-000001");
    expect(result).toEqual({ text: "job-000001: exit 0", exitCode: 0 });
  });
});

describe("agency jobs clean", () => {
  it("removes ended folders, leaves running ones, and says how many", async () => {
    const { host } = setUp();
    await place(host, record("job-000001"));
    await place(host, record("job-000002", { state: "ended", exitCode: 0, endedAt: 10 }));
    await place(host, record("job-000003", { state: "stopped", endedAt: 10 }));
    const result = await cleanJobsCommand(host);
    expect(result).toEqual({ text: "Removed 2 ended jobs.", exitCode: 0 });
    expect(Object.keys(snapshot(host)).every((name) => name.includes("job-000001"))).toBe(true);
  });
});
