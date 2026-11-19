import { describe, expect, it } from "vitest";
import { memoryHost } from "../../host/memoryHost.js";
import { FakeClock } from "../clock.js";
import {
  CLAIM_FILE,
  JOB_OUTPUT_CAP_BYTES,
  RECORD_FILE,
  STDERR_FILE,
  STDOUT_FILE,
  STOP_FILE,
  readRecord,
  writeRecord,
  type JobRecord,
} from "./jobRecord.js";
import { runJob } from "./jobRunner.js";
import { SCRIPTED_START_TIME, scriptedSubprocess, settle } from "./__tests__/scriptedSubprocess.js";

const HOME = "/home/me/.agency";
const DIR = `${HOME}/jobs/job-3fa9c1`;
const POLL_MS = 250;
const RUNNER_PID = 4242;

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    id: "job-3fa9c1",
    kind: "shell",
    label: "the label",
    command: "make all",
    cwd: "/work",
    maxMs: 60_000,
    state: "running",
    exitCode: null,
    note: "",
    startedAt: 1000,
    endedAt: null,
    runnerPid: null,
    runnerStartedAt: null,
    commandPid: null,
    commandStartedAt: null,
    token: "token-1",
    ...overrides,
  };
}

async function setUp(overrides: Partial<JobRecord> = {}, files: Record<string, string> = {}) {
  const scripted = scriptedSubprocess();
  const clock = new FakeClock();
  const host = memoryHost({
    variables: { AGENCY_HOME: HOME },
    files: { [`${DIR}/.keep`]: "", ...files },
    subprocess: scripted.subprocess,
    clock,
    processId: RUNNER_PID,
  });
  await writeRecord(host, DIR, record(overrides));
  const text = (name: string) => {
    const bytes = host.state.files[`${DIR}/${name}`];
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  };
  const poll = async () => {
    clock.advance(POLL_MS);
    await settle();
  };
  return { scripted, clock, host, text, poll, read: () => readRecord(host, DIR) };
}

describe("runJob", () => {
  it("copies output to the two files as it arrives", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    const [child] = job.scripted.children;
    child.stdout += "a";
    await job.poll();
    expect(job.text(STDOUT_FILE)).toBe("a");
    child.stdout += "b";
    await job.poll();
    expect(job.text(STDOUT_FILE)).toBe("ab");
    expect(job.text(STDERR_FILE)).toBe("");
    child.finish();
    await done;
  });

  it("starts the command with the record's folder, limit, and cap", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    const [child] = job.scripted.children;
    expect(child.command).toEqual({ kind: "shell", script: "make all" });
    expect(child.options.cwd).toBe("/work");
    expect(child.options.timeoutMs).toBe(60_000);
    expect(child.options.maxOutputBytes).toBe(JOB_OUTPUT_CAP_BYTES);
    child.finish();
    await done;
  });

  it("writes the ending when the command exits", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    const [child] = job.scripted.children;
    child.stdout = "last words\n";
    child.finish({ exitCode: 3 });
    await done;
    const after = await job.read();
    expect(after).toMatchObject({ state: "ended", exitCode: 3, note: "" });
    expect(after?.endedAt).toBe(job.clock.wallTime());
    expect(job.text(STDOUT_FILE)).toBe("last words\n");
  });

  it("writes the runner's and the command's pid and start time before the first poll", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    const [child] = job.scripted.children;
    expect(await job.read()).toMatchObject({
      state: "running",
      runnerPid: RUNNER_PID,
      runnerStartedAt: SCRIPTED_START_TIME,
      commandPid: child.pid,
      commandStartedAt: SCRIPTED_START_TIME,
    });
    child.finish();
    await done;
  });

  it("a stop file stops the job", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    await job.host.files.writeText(await job.host.files.root(DIR), STOP_FILE, "");
    await job.poll();
    await done;
    expect(await job.read()).toMatchObject({ state: "stopped" });
  });

  it("a stop file found before the start runs nothing", async () => {
    const job = await setUp({}, { [`${DIR}/${STOP_FILE}`]: "" });
    await runJob(job.host, DIR, POLL_MS);
    expect(job.scripted.children).toEqual([]);
    expect(await job.read()).toMatchObject({ state: "running", runnerPid: null });
  });

  it("a claim another process took first runs nothing", async () => {
    const job = await setUp({}, { [`${DIR}/${CLAIM_FILE}`]: "starter" });
    await runJob(job.host, DIR, POLL_MS);
    expect(job.scripted.children).toEqual([]);
    expect(await job.read()).toMatchObject({ state: "running", runnerPid: null });
  });

  it("takes the claim before it writes its pid", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    expect(job.text(CLAIM_FILE)).toBe("runner");
    job.scripted.children[0].finish();
    await done;
  });

  it("a record that already reads ended runs nothing", async () => {
    const job = await setUp({ state: "ended", note: "The runner did not start in time." });
    await runJob(job.host, DIR, POLL_MS);
    expect(job.scripted.children).toEqual([]);
    expect(await job.read()).toMatchObject({ state: "ended", runnerPid: null });
  });

  it("a folder with no record runs nothing", async () => {
    const job = await setUp();
    delete job.host.state.files[`${DIR}/${RECORD_FILE}`];
    await runJob(job.host, DIR, POLL_MS);
    expect(job.scripted.children).toEqual([]);
  });

  it("a timeout reads timedOut", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    job.scripted.children[0].finish({ exitCode: null, signal: "SIGTERM", timedOut: true });
    await done;
    expect(await job.read()).toMatchObject({ state: "timedOut" });
  });

  it("output past the cap reads ended with a note naming the stream", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    job.scripted.children[0].finish({ exitCode: null, signal: "SIGTERM", truncated: "stderr" });
    await done;
    expect(await job.read()).toMatchObject({
      state: "ended",
      note: "Stopped: stderr passed the 10 MiB cap.",
    });
  });

  it("a command that cannot start reads ended with the error as its note", async () => {
    const job = await setUp();
    job.scripted.startError = new Error("bash was not found on the PATH.");
    await runJob(job.host, DIR, POLL_MS);
    expect(await job.read()).toMatchObject({
      state: "ended",
      exitCode: null,
      note: "bash was not found on the PATH.",
    });
  });

  it("a command whose wait rejects reads ended with the error as its note", async () => {
    const job = await setUp();
    const done = runJob(job.host, DIR, POLL_MS);
    await settle();
    job.scripted.children[0].fail(new Error("spawn bash ENOENT"));
    await done;
    expect(await job.read()).toMatchObject({ state: "ended", note: "spawn bash ENOENT" });
  });
});
