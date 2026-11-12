import { describe, it, expect } from "vitest";
import { jobEndedLine } from "./cliJobLine.js";

describe("jobEndedLine", () => {
  const job = {
    id: "job-1",
    command: "./run-comparison.sh",
    exitCode: 0,
    startedAt: 1000,
    endedAt: 1000 + 41 * 60_000 + 8000,
    unread: true,
  };

  it("names the job, how long it ran, how it ended, and the command", () => {
    expect(jobEndedLine({ ...job, state: "ended" })).toBe(
      "job-1 finished after 41m 8s (exit 0): ./run-comparison.sh",
    );
  });

  it("says when a job was stopped or timed out", () => {
    expect(jobEndedLine({ ...job, state: "stopped", exitCode: null })).toContain("(stopped)");
    expect(jobEndedLine({ ...job, state: "timedOut", exitCode: null })).toContain("(timed out)");
  });
});
