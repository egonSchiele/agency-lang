import { describe, expect, it } from "vitest";
import type { Interrupt } from "../../runtime/interrupts.js";
import type { HeldJob } from "../../runtime/jobs/heldJobs.js";
import { heldJobsOf, jobsStartedBetween } from "./jobs.js";

function job(id: string): HeldJob {
  return {
    handle: { id, kind: "shell", label: "sleep 30", startedAt: 1 },
    read: { stdout: 0, stderr: 0 },
    finalRead: false,
    token: `token-${id}`,
  };
}

/** An interrupt whose checkpoint, as a saved session holds it, has `jobs`. */
function holding(effect: string, id: string, jobs: HeldJob[]): Interrupt {
  const checkpoint = jobs.length === 0 ? {} : { heldJobs: jobs };
  return {
    type: "interrupt",
    effect,
    message: "",
    origin: "test",
    interruptId: id,
    data: {},
    runId: "run",
    // A loaded session's checkpoint is plain JSON, not a Checkpoint.
    checkpoint: checkpoint as Interrupt["checkpoint"],
  };
}

describe("heldJobsOf", () => {
  it("merges the jobs of every interrupt, not only the first's", () => {
    const first = holding("std::bash", "a", [job("job-aaaaaa")]);
    const second = holding("std::bash", "b", [job("job-aaaaaa"), job("job-bbbbbb")]);
    expect(heldJobsOf([first, second]).map((each) => each.handle.id)).toEqual([
      "job-aaaaaa",
      "job-bbbbbb",
    ]);
  });

  it("finds none in a checkpoint with no jobs, or one that is not a list of jobs", () => {
    const bad = { ...holding("std::bash", "a", []), checkpoint: { heldJobs: "x" } };
    expect(heldJobsOf([holding("std::bash", "a", []), bad as Interrupt])).toEqual([]);
  });
});

describe("jobsStartedBetween", () => {
  it("is the jobs the later pause holds and the earlier does not", () => {
    const earlier = [holding("agent::sessionInput", "p", [job("job-aaaaaa")])];
    const later = [holding("std::bash", "b", [job("job-aaaaaa"), job("job-bbbbbb")])];
    expect(jobsStartedBetween(earlier, later)).toEqual([job("job-bbbbbb")]);
  });
});
