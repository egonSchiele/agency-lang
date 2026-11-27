import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  ROUTE_TO_COORDINATOR,
  cliIsBuilt,
  makeTempDir,
  removeTempDir,
  runAgentWithMocks,
  type CliRun,
} from "./cliSpawnTestHelpers.js";

// End-to-end: the check at the end of an `agency agent -p` turn
// (lib/agents/agency-agent/lib/endCheck.agency), with scripted model
// replies. Each module that calls a model has its own queue: `router` routes
// the user's message, `endCheck` answers the end check, and `*` holds the
// coordinator's replies. A queue that runs out makes the next call fail, so
// an extra turn or an extra routing call shows up in the output.

function endCheck(state: "finished" | "unfinished" | "blocked") {
  return {
    decide: { answer: { type: "choice", choice: state, confidence: 0.9, probabilities: {} } },
  };
}

function reply(text: string) {
  return { return: text };
}

/** One `-p` run: its output, exit code, and statelog. */
async function oneShot(
  mocks: Record<string, unknown[]>,
  extraArgs: string[] = [],
): Promise<CliRun & { log: string }> {
  const dir = makeTempDir("agent-end-check-");
  const logPath = path.join(dir, "log.jsonl");
  try {
    const run = await runAgentWithMocks(
      dir,
      ["--brain", "coordinator", "--log", logPath, ...extraArgs, "-p", "Implement the plan."],
      mocks,
    );
    return { ...run, log: readFileSync(logPath, "utf-8") };
  } finally {
    removeTempDir(dir);
  }
}

describe.skipIf(!cliIsBuilt)("the end check in agency agent -p (end-to-end)", () => {
  it("a reply that says work remains gets another turn, which skips the router", async () => {
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      endCheck: [endCheck("unfinished"), endCheck("finished")],
      "*": [reply("Continuing with the next tasks."), reply("All tasks are done.")],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("All tasks are done.");
    expect(r.stdout).not.toContain("Continuing with the next tasks.");
    // The router's queue holds one answer. Routing the extra turn would
    // have failed and printed this notice.
    expect(r.stdout + r.stderr).not.toContain("Routing skipped");
  }, 90_000);

  it("a reply the check calls finished ends the run", async () => {
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      endCheck: [endCheck("finished")],
      "*": [reply("All tasks are done.")],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("All tasks are done.");
    expect(r.stdout).not.toContain("request failed");
  }, 90_000);

  it("a reply the check calls blocked ends the run", async () => {
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      endCheck: [endCheck("blocked")],
      "*": [reply("I need database access to go on.")],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("I need database access to go on.");
    expect(r.stdout).not.toContain("request failed");
  }, 90_000);

  it("gives at most two extra turns", async () => {
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      endCheck: [endCheck("unfinished"), endCheck("unfinished"), endCheck("unfinished")],
      "*": [reply("Step one."), reply("Step two."), reply("Step three."), reply("Step four.")],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Step three.");
    expect(r.stdout).not.toContain("Step four.");
  }, 90_000);

  it("makes no check when the router is off", async () => {
    const r = await oneShot(
      {
        endCheck: [endCheck("unfinished")],
        "*": [reply("Continuing with the next tasks."), reply("All tasks are done.")],
      },
      ["--model", "router=off"],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Continuing with the next tasks.");
    expect(r.stdout).not.toContain("All tasks are done.");
  }, 90_000);

  it("a check that fails reads as finished and is recorded in the log", async () => {
    // With no endCheck queue, the check's call falls back to `*`, whose next
    // entry is text where a decision is expected, so the check fails.
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      "*": [reply("Continuing with the next tasks."), reply("Not a decision.")],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Continuing with the next tasks.");
    expect(r.log).toContain("end check failed");
    expect(r.stdout).not.toContain("request failed");
  }, 90_000);

  it("an extra turn that fails keeps the earlier reply and says what failed", async () => {
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      endCheck: [endCheck("unfinished")],
      // A decision answer where the coordinator expects text fails the call.
      "*": [reply("Step one."), endCheck("finished")],
    });
    expect(r.stdout).toContain("Step one.");
    expect(r.stdout).toContain("The request failed");
  }, 90_000);

  it("makes no check after a turn that failed", async () => {
    // A decision answer where the coordinator expects text makes its call
    // fail, so the turn fails.
    const r = await oneShot({
      router: [ROUTE_TO_COORDINATOR],
      endCheck: [endCheck("unfinished")],
      "*": [endCheck("finished"), reply("This turn should not run.")],
    });
    expect(r.stdout).toContain("The request failed");
    expect(r.stdout).not.toContain("This turn should not run.");
  }, 90_000);
});
