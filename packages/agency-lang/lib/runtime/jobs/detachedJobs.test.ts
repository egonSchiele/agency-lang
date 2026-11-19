import { beforeEach, describe, expect, it } from "vitest";
import { memoryHost, type MemoryHost } from "../../host/memoryHost.js";
import { FakeClock } from "../clock.js";
import { processSlot } from "../processSlot.js";
import {
  RUNNER_DIED_STOPPED,
  START_TIME_CHECKS_SLOT,
  START_TIME_RECHECK_MS,
  START_WAIT_MS,
  heldJobStatus,
  jobOutputSince,
  jobStatus,
  launchJob,
  listJobRecords,
  removeEndedJobs,
  requestStop,
  runnerScriptPath,
} from "./detachedJobs.js";
import {
  CLAIM_FILE,
  RECORD_FILE,
  RUNNER_LOG_FILE,
  STDOUT_FILE,
  STOP_FILE,
  changeRecord,
  jobDir,
  readRecord,
  writeRecord,
  type JobRecord,
} from "./jobRecord.js";
import {
  scriptedSubprocess,
  settle,
  type ScriptedSubprocess,
} from "./__tests__/scriptedSubprocess.js";

const HOME = "/home/me/.agency";
const START = { command: "sleep 30", label: "sleep", cwd: "/work", maxMs: 60_000 };
const ADVANCE_MS = 100;

type Setup = { host: MemoryHost; clock: FakeClock; scripted: ScriptedSubprocess };

// The start-time checks are kept per process, and every test's clock starts
// at 0, so a check one test made must not count in the next.
beforeEach(() => {
  processSlot<Record<string, number>>(START_TIME_CHECKS_SLOT, () => ({})).set({});
});

function setUp(randomBytes: number[][] = []): Setup {
  const scripted = scriptedSubprocess();
  const clock = new FakeClock();
  const host = memoryHost({
    variables: { AGENCY_HOME: HOME },
    files: { "/work/.keep": "" },
    subprocess: scripted.subprocess,
    clock,
  });
  const queued = [...randomBytes];
  const realBytes = host.random.bytes;
  host.random.bytes = (length) => {
    const next = queued.shift();
    return next === undefined ? realBytes(length) : new Uint8Array(next);
  };
  // The runner, as far as a starter can tell: it writes its pid.
  scripted.onDetached = async (pid) => {
    const dir = runnerDir(scripted);
    await changeRecord(host, dir, (current) => ({ ...current, runnerPid: pid }));
  };
  return { host, clock, scripted };
}

function runnerDir(scripted: ScriptedSubprocess): string {
  const command = scripted.detached.at(-1)!.command;
  if (command.kind !== "program") {
    throw new Error("the runner is started as a program");
  }
  return command.args.at(-1)!;
}

/** Waits for `work`, moving the clock while it waits. */
async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  const result = work.finally(() => {
    done = true;
  });
  result.catch(() => undefined);
  await settle();
  while (!done) {
    clock.advance(ADVANCE_MS);
    await settle();
  }
  return result;
}

function record(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    id,
    kind: "shell",
    label: "sleep",
    command: "sleep 30",
    cwd: "/work",
    maxMs: 60_000,
    state: "running",
    exitCode: null,
    note: "",
    startedAt: 1000,
    endedAt: null,
    runnerPid: 500,
    runnerStartedAt: 1_000_000,
    commandPid: 501,
    commandStartedAt: 1_000_000,
    token: "token-1",
    ...overrides,
  };
}

async function place(host: MemoryHost, rec: JobRecord): Promise<string> {
  const dir = jobDir(host, rec.id);
  await host.files.mkdir(await host.files.root("/"), dir.slice(1));
  await writeRecord(host, dir, rec);
  return dir;
}

function fileText(host: MemoryHost, file: string): string | undefined {
  const bytes = host.state.files[file];
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

describe("launchJob", () => {
  it("writes a running record and starts the runner with the folder as its argument", async () => {
    const { host, clock, scripted } = setUp([[0x3f, 0xa9, 0xc1]]);
    const launched = await drive(clock, launchJob(host, START));
    expect(launched).toMatchObject({
      id: "job-3fa9c1",
      state: "running",
      command: "sleep 30",
      cwd: "/work",
      maxMs: 60_000,
    });
    expect(launched.runnerPid).toBe(scripted.detached[0].pid);
    const command = scripted.detached[0].command;
    expect(command.kind).toBe("program");
    expect(command.kind === "program" && command.args).toEqual([
      runnerScriptPath(),
      jobDir(host, "job-3fa9c1"),
    ]);
    expect(runnerScriptPath()).toMatch(/dist\/lib\/runtime\/jobs\/runnerMain\.js$/);
  });

  it("picks another id when the first one's folder exists", async () => {
    const { host, clock } = setUp([
      [0x3f, 0xa9, 0xc1],
      [0x3f, 0xa9, 0xc1],
      [0x00, 0x00, 0x01],
    ]);
    const first = await drive(clock, launchJob(host, START));
    const second = await drive(clock, launchJob(host, START));
    expect(first.id).toBe("job-3fa9c1");
    expect(second.id).toBe("job-000001");
  });

  it("refuses a working folder that is not absolute", async () => {
    const { host, clock } = setUp();
    await expect(drive(clock, launchJob(host, { ...START, cwd: "work" }))).rejects.toThrow(
      /absolute/,
    );
  });

  it("that times out takes the claim, writes a record that reads ended, and rejects", async () => {
    const { host, clock, scripted } = setUp([[0x3f, 0xa9, 0xc1]]);
    scripted.onDetached = async () => {};
    await expect(drive(clock, launchJob(host, START))).rejects.toThrow(/did not start/);
    const dir = jobDir(host, "job-3fa9c1");
    expect(fileText(host, `${dir}/${CLAIM_FILE}`)).toBe("starter");
    expect(fileText(host, `${dir}/${STOP_FILE}`)).toBeUndefined();
    expect(await readRecord(host, dir)).toMatchObject({ state: "ended", runnerPid: null });
    expect(clock.now()).toBeGreaterThanOrEqual(START_WAIT_MS);
  });

  it("whose runner exits without claiming the job fails at once, with what it printed", async () => {
    const { host, clock, scripted } = setUp([[0x3f, 0xa9, 0xc1]]);
    scripted.onDetached = async (pid) => {
      const options = scripted.detached.at(-1)!.options;
      host.state.files[options!.outputFile!] = new TextEncoder().encode("SyntaxError: boom\n");
      scripted.states[pid] = "gone";
    };
    await expect(drive(clock, launchJob(host, START))).rejects.toThrow(
      /runner exited before it started the job\. It printed: SyntaxError: boom/,
    );
    expect(clock.now()).toBeLessThan(START_WAIT_MS);
    expect(await readRecord(host, jobDir(host, "job-3fa9c1"))).toMatchObject({ state: "ended" });
  });

  it("that times out says what the runner printed, from the runner's log", async () => {
    const { host, clock, scripted } = setUp([[0x3f, 0xa9, 0xc1]]);
    scripted.onDetached = async () => {
      const options = scripted.detached.at(-1)!.options;
      host.state.files[options!.outputFile!] = new TextEncoder().encode(
        "Error: Cannot find module 'x'\n",
      );
    };
    await expect(drive(clock, launchJob(host, START))).rejects.toThrow(
      /did not start within 30 seconds\. It printed: Error: Cannot find module 'x'/,
    );
    expect(scripted.detached[0].options?.outputFile).toBe(
      `${jobDir(host, "job-3fa9c1")}/${RUNNER_LOG_FILE}`,
    );
  });

  it("whose runner claimed the job as the wait ran out succeeds, and ends nothing", async () => {
    const { host, clock, scripted } = setUp([[0x3f, 0xa9, 0xc1]]);
    // The runner has taken the claim and not yet written its pid.
    scripted.onDetached = async () => {
      const dir = runnerDir(scripted);
      await host.files.writeText(await host.files.root(dir), CLAIM_FILE, "runner");
    };
    const launched = await drive(clock, launchJob(host, START));
    expect(launched.state).toBe("running");
    const dir = jobDir(host, "job-3fa9c1");
    expect(fileText(host, `${dir}/${CLAIM_FILE}`)).toBe("runner");
    expect(await readRecord(host, dir)).toMatchObject({ state: "running" });
  });

  it("gives each job a token of its own", async () => {
    const { host, clock } = setUp();
    const first = await drive(clock, launchJob(host, START));
    const second = await drive(clock, launchJob(host, START));
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
    expect(second.token).not.toBe(first.token);
  });

  it("rounds a time limit that is not a whole number of milliseconds", async () => {
    const { host, clock } = setUp();
    const launched = await drive(clock, launchJob(host, { ...START, maxMs: 4.1 * 60_000 }));
    expect(launched.maxMs).toBe(246_000);
  });
});

describe("jobStatus", () => {
  it("reads a running record whose runner is gone as ended, and stops the command's group", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.states[500] = "gone";
    const status = await jobStatus(host, "job-000001");
    expect(status).toMatchObject({ state: "ended", exitCode: null, note: RUNNER_DIED_STOPPED });
    expect(scripted.stopped).toEqual([501]);
    expect(await readRecord(host, jobDir(host, "job-000001"))).toMatchObject({ state: "ended" });
  });

  it("does not signal when the command's start time does not match", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.states[500] = "gone";
    scripted.startTimes[501] = 9_000_000;
    const status = await jobStatus(host, "job-000001");
    expect(scripted.stopped).toEqual([]);
    expect(status?.state).toBe("ended");
    expect(status?.note).not.toBe(RUNNER_DIED_STOPPED);
  });

  it("names the pid when the command's start time cannot be read", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.states[500] = "gone";
    scripted.startTimes[501] = null;
    const status = await jobStatus(host, "job-000001");
    expect(scripted.stopped).toEqual([]);
    expect(status?.note).toContain("501");
  });

  it("reads a runner whose pid was given to another process as gone", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.startTimes[500] = 5_000_000;
    expect((await jobStatus(host, "job-000001"))?.state).toBe("ended");
  });

  it("checks a live runner's start time at most once in START_TIME_RECHECK_MS", async () => {
    const { host, clock, scripted } = setUp();
    await place(host, record("job-000001"));
    const startedAt = scripted.subprocess.processStartedAt;
    let runnerChecks = 0;
    scripted.subprocess.processStartedAt = (pid) => {
      if (pid === 500) {
        runnerChecks += 1;
      }
      return startedAt(pid);
    };
    await jobStatus(host, "job-000001");
    await jobStatus(host, "job-000001");
    expect(runnerChecks).toBe(1);
    clock.advance(START_TIME_RECHECK_MS);
    await jobStatus(host, "job-000001");
    expect(runnerChecks).toBe(2);
  });

  it("keeps a runner whose state is unknown running", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.states[500] = "unknown";
    expect((await jobStatus(host, "job-000001"))?.state).toBe("running");
    expect(scripted.stopped).toEqual([]);
  });

  it("keeps a real ending written while it looked", async () => {
    const { host, scripted } = setUp();
    const dir = await place(host, record("job-000001", { commandPid: null }));
    // The runner writes its ending and exits between the read of the
    // record and the check of its pid.
    scripted.beforeProcessState = (pid) => {
      if (pid === 500) {
        const ended = record("job-000001", {
          commandPid: null,
          state: "ended",
          exitCode: 0,
          endedAt: 2000,
        });
        host.state.files[`${dir}/${RECORD_FILE}`] = new TextEncoder().encode(JSON.stringify(ended));
        scripted.states[500] = "gone";
      }
    };
    const status = await jobStatus(host, "job-000001");
    expect(status).toMatchObject({ state: "ended", exitCode: 0, note: "" });
  });

  it("is null for a job with no folder", async () => {
    const { host } = setUp();
    expect(await jobStatus(host, "job-0000ff")).toBeNull();
  });
});

describe("heldJobStatus", () => {
  it("reads a held job whose token matches", async () => {
    const { host } = setUp();
    await place(host, record("job-000001"));
    const status = await heldJobStatus(host, { id: "job-000001", token: "token-1" });
    expect(status?.state).toBe("running");
  });

  it("reaches nothing for an id whose token does not match", async () => {
    const { host, scripted } = setUp();
    await place(host, record("job-000001"));
    scripted.states[500] = "gone";
    const status = await heldJobStatus(host, { id: "job-000001", token: "forged" });
    expect(status).toBeNull();
    expect(scripted.stopped).toEqual([]);
    expect((await readRecord(host, jobDir(host, "job-000001")))?.state).toBe("running");
  });
});

describe("jobOutputSince", () => {
  it("returns only text after the positions, and the new positions", async () => {
    const { host } = setUp();
    const dir = await place(host, record("job-000001"));
    host.state.files[`${dir}/${STDOUT_FILE}`] = new TextEncoder().encode("one\ntwo\n");
    const first = await jobOutputSince(host, "job-000001", { stdout: 0, stderr: 0 });
    expect(first).toEqual({
      stdout: "one\ntwo\n",
      stderr: "",
      positions: { stdout: 8, stderr: 0 },
    });
    const later = await jobOutputSince(host, "job-000001", { stdout: 4, stderr: 0 });
    expect(later.stdout).toBe("two\n");
    const again = await jobOutputSince(host, "job-000001", { stdout: 4, stderr: 0 });
    expect(again.stdout).toBe("two\n");
  });

  it("collapses carriage returns", async () => {
    const { host } = setUp();
    const dir = await place(host, record("job-000001"));
    host.state.files[`${dir}/${STDOUT_FILE}`] = new TextEncoder().encode("10%\r50%\r100%\n");
    expect((await jobOutputSince(host, "job-000001", { stdout: 0, stderr: 0 })).stdout).toBe(
      "100%\n",
    );
  });
});

describe("requestStop", () => {
  it("on an ended job returns its record at once and writes no stop file", async () => {
    const { host } = setUp();
    const dir = await place(host, record("job-000001", { state: "ended", exitCode: 0 }));
    expect(await requestStop(host, "job-000001")).toMatchObject({ state: "ended", exitCode: 0 });
    expect(host.state.files[`${dir}/${STOP_FILE}`]).toBeUndefined();
  });

  it("writes the stop file and waits for the runner to write the ending", async () => {
    const { host, clock } = setUp();
    const dir = await place(host, record("job-000001"));
    const stopping = requestStop(host, "job-000001");
    await settle();
    expect(fileText(host, `${dir}/${STOP_FILE}`)).toBe("");
    await changeRecord(host, dir, (current) => ({ ...current, state: "stopped" }));
    expect(await drive(clock, stopping)).toMatchObject({ state: "stopped" });
  });

  it("on a job whose runner is gone stops the command and writes no stop file", async () => {
    const { host, scripted } = setUp();
    const dir = await place(host, record("job-000001"));
    scripted.states[500] = "gone";
    expect(await requestStop(host, "job-000001")).toMatchObject({
      state: "ended",
      note: RUNNER_DIED_STOPPED,
    });
    expect(scripted.stopped).toEqual([501]);
    expect(host.state.files[`${dir}/${STOP_FILE}`]).toBeUndefined();
  });

  it("is null for a job with no folder", async () => {
    const { host } = setUp();
    expect(await requestStop(host, "job-0000ff")).toBeNull();
  });
});

describe("an id that is not a job id", () => {
  it("is refused before it becomes a path", async () => {
    const { host } = setUp();
    await expect(jobStatus(host, "../../x")).rejects.toThrow(/not a job id/);
    await expect(jobOutputSince(host, "../../x", { stdout: 0, stderr: 0 })).rejects.toThrow(
      /not a job id/,
    );
    await expect(requestStop(host, "../../x")).rejects.toThrow(/not a job id/);
  });
});

describe("listJobRecords and removeEndedJobs", () => {
  it("lists newest first and skips a folder with no readable record", async () => {
    const { host } = setUp();
    await place(host, record("job-000001", { startedAt: 1000 }));
    await place(host, record("job-000002", { startedAt: 3000 }));
    const broken = await place(host, record("job-000003"));
    host.state.files[`${broken}/${RECORD_FILE}`] = new TextEncoder().encode("{");
    const listed = await listJobRecords(host);
    expect(listed.map((each) => each.id)).toEqual(["job-000002", "job-000001"]);
  });

  it("removes the folders of ended jobs and leaves running ones", async () => {
    const { host } = setUp();
    await place(host, record("job-000001"));
    const ended = await place(host, record("job-000002", { state: "ended", exitCode: 0 }));
    expect(await removeEndedJobs(host)).toEqual(["job-000002"]);
    expect(host.state.files[`${ended}/${RECORD_FILE}`]).toBeUndefined();
    expect((await listJobRecords(host)).map((each) => each.id)).toEqual(["job-000001"]);
  });
});
