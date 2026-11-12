import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeHost } from "../../host/node/nodeHost.js";
import { memoryHost } from "../../host/memoryHost.js";
import type { HostSubprocess } from "../../host/host.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import {
  MAX_RUNNING_JOBS,
  addJob,
  describeJobState,
  endAllJobs,
  endJob,
  listJobs,
  newJobTable,
  onJobEnd,
  readJob,
  waitForJob,
  type JobSummary,
  type JobTable,
} from "./jobTable.js";

const host = nodeHost();
let tables: JobTable[] = [];
let dirs: string[] = [];

function table(): JobTable {
  const made = newJobTable();
  tables.push(made);
  return made;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-jobs-"));
  dirs.push(dir);
  return dir;
}

const start = (jobs: JobTable, command: string, maxMs = 60_000, cwd = "") =>
  addJob(jobs, host, { command, label: command, cwd, maxMs });

const never = new AbortController().signal;

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function printedPid(jobs: JobTable, id: string): Promise<number> {
  let text = "";
  await until(() => {
    text += readJob(jobs, id)!.stdout;
    return text.trim() !== "";
  });
  return Number(text.trim());
}

const summary = (state: JobSummary["state"], exitCode: number | null): JobSummary => ({
  id: "job-1",
  command: "x",
  state,
  exitCode,
  startedAt: 0,
  endedAt: null,
  unread: false,
});

afterEach(() => {
  tables.forEach(endAllJobs);
  tables = [];
  dirs.forEach((dir) => safeDeleteDirectoryWithin(os.tmpdir(), dir));
  dirs = [];
});

describe.skipIf(process.platform === "win32")("the job table", () => {
  it("returns only the output not read before", async () => {
    const jobs = table();
    const dir = tempDir();
    const job = await start(
      jobs,
      "printf 'A\\n'; while [ ! -f go ]; do sleep 0.05; done; printf 'B\\n'",
      60_000,
      dir,
    );
    let first = "";
    await until(() => {
      first += readJob(jobs, job.id)!.stdout;
      return first.includes("A");
    });
    expect(first).toBe("A\n");
    fs.writeFileSync(path.join(dir, "go"), "");
    await waitForJob(jobs, job.id, 5000, never);
    const rest = readJob(jobs, job.id)!;
    expect(rest.stdout).toBe("B\n");
    expect(rest.state).toBe("ended");
    expect(rest.exitCode).toBe(0);
    const again = readJob(jobs, job.id)!;
    expect(again.stdout).toBe("");
    expect(again.unread).toBe(false);
  });

  it("a wait returns early when the job ends", async () => {
    const jobs = table();
    const job = await start(jobs, "sleep 0.3");
    const begun = Date.now();
    await waitForJob(jobs, job.id, 10_000, never);
    expect(Date.now() - begun).toBeLessThan(2000);
  });

  it("a wait returns at its limit and leaves the job running", async () => {
    const jobs = table();
    const job = await start(jobs, "sleep 30");
    const begun = Date.now();
    await waitForJob(jobs, job.id, 300, never);
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(readJob(jobs, job.id)!.state).toBe("running");
  });

  it("an aborted signal ends a wait and leaves the job running", async () => {
    const jobs = table();
    const job = await start(jobs, "sleep 30");
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 200);
    const begun = Date.now();
    await waitForJob(jobs, job.id, 30_000, cancel.signal);
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(readJob(jobs, job.id)!.state).toBe("running");
  });

  it("endJob stops everything the command started", async () => {
    const jobs = table();
    const job = await start(jobs, "sleep 30 & echo $!; wait");
    const pid = await printedPid(jobs, job.id);
    const begun = Date.now();
    expect(await endJob(jobs, job.id)).toBe(true);
    expect(Date.now() - begun).toBeLessThan(4000);
    expect(listJobs(jobs)[0].state).toBe("stopped");
    await until(() => !isAlive(pid), 4000);
    expect(isAlive(pid)).toBe(false);
  });

  it("endJob does not clear unread; the read after it does", async () => {
    const jobs = table();
    const job = await start(jobs, "sleep 30");
    await endJob(jobs, job.id);
    expect(listJobs(jobs)[0].unread).toBe(true);
    readJob(jobs, job.id);
    expect(listJobs(jobs)[0].unread).toBe(false);
  });

  it("endAllJobs stops every running job", async () => {
    const jobs = table();
    const first = await start(jobs, "sleep 30 & echo $!; wait");
    const second = await start(jobs, "sleep 30 & echo $!; wait");
    const pids = [await printedPid(jobs, first.id), await printedPid(jobs, second.id)];
    endAllJobs(jobs);
    await until(() => pids.every((pid) => !isAlive(pid)), 4000);
    expect(pids.map(isAlive)).toEqual([false, false]);
  });

  it("refuses a job past the limit and names the running ones", async () => {
    const jobs = table();
    for (let i = 0; i < MAX_RUNNING_JOBS; i++) {
      await start(jobs, "sleep 30");
    }
    await expect(start(jobs, "sleep 30")).rejects.toThrow(/job-1 \(sleep 30\)/);
    expect(listJobs(jobs)).toHaveLength(MAX_RUNNING_JOBS);
  });

  it("a job past its time limit is timedOut", async () => {
    const jobs = table();
    const job = await start(jobs, "sleep 30", 300);
    await waitForJob(jobs, job.id, 5000, never);
    expect(readJob(jobs, job.id)!.state).toBe("timedOut");
  });

  it("a job that prints past the cap is stopped, and the note names the stream", async () => {
    const jobs = table();
    const job = await addJob(
      jobs,
      host,
      { command: "yes", label: "yes", cwd: "", maxMs: 60_000 },
      1000,
    );
    await waitForJob(jobs, job.id, 5000, never);
    const report = readJob(jobs, job.id)!;
    expect(report.state).toBe("ended");
    expect(report.note).toContain("stdout");
  });

  it("an unknown id reads as null, ends as false, and waits not at all", async () => {
    const jobs = table();
    expect(readJob(jobs, "job-99")).toBeNull();
    expect(await endJob(jobs, "job-99")).toBe(false);
    await waitForJob(jobs, "job-99", 30_000, never);
  });

  it("calls an end listener once, with the job unread", async () => {
    const jobs = table();
    const ended: JobSummary[] = [];
    onJobEnd(jobs, (job) => ended.push(job));
    const job = await start(jobs, "true");
    await waitForJob(jobs, job.id, 5000, never);
    expect(ended).toHaveLength(1);
    expect(ended[0].unread).toBe(true);
  });

  it("reads a progress bar as its last state", async () => {
    const jobs = table();
    const job = await start(jobs, "printf '10%%\\r50%%\\r100%%\\n'");
    await waitForJob(jobs, job.id, 5000, never);
    expect(readJob(jobs, job.id)!.stdout).toBe("100%\n");
  });
});

describe("a job whose process fails after it started", () => {
  it("ends the job with the error in its note", async () => {
    const failing: HostSubprocess = {
      run: async () => {
        throw new Error("unused");
      },
      locate: async () => null,
      start: async () => ({
        kill: () => {},
        wait: () => Promise.reject(new Error("spawn bash ENOENT")),
        output: () => ({ stdout: "", stderr: "" }),
      }),
    };
    const jobs = table();
    const ended: JobSummary[] = [];
    onJobEnd(jobs, (job) => ended.push(job));
    const job = await addJob(jobs, memoryHost({ subprocess: failing }), {
      command: "x",
      label: "x",
      cwd: "",
      maxMs: 1000,
    });
    await waitForJob(jobs, job.id, 1000, never);
    const [listed] = listJobs(jobs);
    expect(listed.state).toBe("ended");
    expect(listed.unread).toBe(true);
    expect(ended).toHaveLength(1);
    expect(readJob(jobs, job.id)!.note).toBe("spawn bash ENOENT");
    // The limit counts running jobs, so this one no longer counts.
    expect(listJobs(jobs).filter((each) => each.state === "running")).toEqual([]);
  });
});

describe("describeJobState", () => {
  it("puts each state into words", () => {
    expect(describeJobState(summary("running", null))).toBe("running");
    expect(describeJobState(summary("ended", 0))).toBe("exit 0");
    expect(describeJobState(summary("ended", 3))).toBe("exit 3");
    expect(describeJobState(summary("stopped", null))).toBe("stopped");
    expect(describeJobState(summary("timedOut", null))).toBe("timed out");
  });
});
