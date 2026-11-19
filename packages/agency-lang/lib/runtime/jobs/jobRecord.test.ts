import { describe, expect, it } from "vitest";
import { memoryHost } from "../../host/memoryHost.js";
import {
  RECORD_FILE,
  changeRecord,
  jobDir,
  jobsDir,
  readRecord,
  writeRecord,
  type JobRecord,
} from "./jobRecord.js";

const HOME = "/home/me/.agency";
const DIR = `${HOME}/jobs/job-3fa9c1`;

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    id: "job-3fa9c1",
    kind: "shell",
    label: "sleep 30",
    command: "sleep 30",
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
    ...overrides,
  };
}

function hostWith(files: Record<string, string> = {}) {
  return memoryHost({ variables: { AGENCY_HOME: HOME }, files });
}

describe("jobDir", () => {
  it("is a folder under jobsDir for a job id", () => {
    const host = hostWith();
    expect(jobDir(host, "job-3fa9c1")).toBe(`${jobsDir(host)}/job-3fa9c1`);
    expect(jobsDir(host)).toBe(`${HOME}/jobs`);
  });

  it("throws for text that is not a job id", () => {
    const host = hostWith();
    expect(() => jobDir(host, "../../etc")).toThrow(/not a job id/);
    expect(() => jobDir(host, "job-xyz")).toThrow(/not a job id/);
    expect(() => jobDir(host, "")).toThrow(/not a job id/);
    expect(() => jobDir(host, "job-3fa9c1/../x")).toThrow(/not a job id/);
  });
});

describe("readRecord", () => {
  it("reads back what writeRecord wrote", async () => {
    const host = hostWith({ [`${DIR}/.keep`]: "" });
    await writeRecord(host, DIR, record());
    expect(await readRecord(host, DIR)).toEqual(record());
  });

  it("is null for a missing folder or file", async () => {
    expect(await readRecord(hostWith(), DIR)).toBeNull();
    expect(await readRecord(hostWith({ [`${DIR}/.keep`]: "" }), DIR)).toBeNull();
  });

  it("is null for text with a key the record does not have", async () => {
    const text = JSON.stringify({ ...record(), extra: true });
    expect(await readRecord(hostWith({ [`${DIR}/${RECORD_FILE}`]: text }), DIR)).toBeNull();
  });

  it("is null for a pid that would name every process", async () => {
    const text = JSON.stringify(record({ commandPid: 1 }));
    expect(await readRecord(hostWith({ [`${DIR}/${RECORD_FILE}`]: text }), DIR)).toBeNull();
  });
});

describe("changeRecord", () => {
  it("writes what the change returns", async () => {
    const host = hostWith({ [`${DIR}/.keep`]: "" });
    await writeRecord(host, DIR, record());
    const after = await changeRecord(host, DIR, (current) => ({ ...current, runnerPid: 42 }));
    expect(after?.runnerPid).toBe(42);
    expect((await readRecord(host, DIR))?.runnerPid).toBe(42);
  });

  it("writes nothing when the change returns null, and returns the record as it is", async () => {
    const host = hostWith({ [`${DIR}/.keep`]: "" });
    await writeRecord(host, DIR, record());
    const before = host.state.files[`${DIR}/${RECORD_FILE}`];
    const after = await changeRecord(host, DIR, () => null);
    expect(after).toEqual(record());
    expect(host.state.files[`${DIR}/${RECORD_FILE}`]).toBe(before);
  });

  it("creates no record where there was none", async () => {
    const host = hostWith({ [`${DIR}/.keep`]: "" });
    expect(await changeRecord(host, DIR, (current) => current)).toBeNull();
    expect(host.state.files[`${DIR}/${RECORD_FILE}`]).toBeUndefined();
  });
});
