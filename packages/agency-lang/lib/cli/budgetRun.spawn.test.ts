import { describe, it, expect } from "vitest";
import { writeFileSync } from "fs";
import path from "path";
import {
  ROUTE_TO_COORDINATOR,
  cliIsBuilt,
  makeTempDir,
  removeTempDir,
  runAgency,
  runAgentWithMocks,
} from "./cliSpawnTestHelpers.js";

// End-to-end: run the BUILT CLI and observe the budget-exceeded exit code
// and message.

// Sleeps far past the tiny time budget the tests set. The direction is
// jitter-safe: the EXPECTED outcome is the trip, and a slow runner only
// makes the sleep overshoot harder.
const SLEEPER = `node main() {
  sleep(2s)
  return "done"
}
`;

// The tripping work sits inside a USER guard block whose own (time) guard
// has plenty of budget. The user boundary owns only its OWN guardId, so it
// must NOT absorb the root budget's trip — the trip propagates to the
// compiled entry and exits 3. If the boundary wrongly converted it, the
// program would print GUARD_ABSORBED and exit 0.
const GUARDED_SLEEPER = `
node main() {
  const inner = guard(time: 60s) {
    sleep(2s)
    return "inner done"
  }
  if (isFailure(inner)) {
    print("GUARD_ABSORBED:\${inner.data.type}")
    return "absorbed"
  }
  return inner.value
}
`;

// A callback that calls an Agency function just before each model request,
// as the agent's trace callbacks do. The function's `return` used to pause
// the clock, and nothing restarted it while the request was out, so time
// spent waiting on a model never counted.
const CALLBACK_THEN_SLOW_MODEL = `
let loud = false

def isLoud(): boolean {
  return loud
}

callback("onLLMCallStart") as data {
  if (isLoud()) {
    print("starting")
  }
}

node main() {
  const r: string = llm("go")
  print(r)
}
`;

// The scripted reply takes 8 seconds and then returns, so a broken limit
// makes the run finish late instead of hanging the test.
const SLOW_REPLY_MOCKS = JSON.stringify([{ return: "done", delayMs: 8000 }]);

function makeDir(fixture: string = SLEEPER): string {
  const dir = makeTempDir("budget-spawn-");
  writeFileSync(path.join(dir, "sleeper.agency"), fixture);
  return dir;
}

async function runCli(dir: string, args: string[], env: Record<string, string> = {}) {
  // Agency's flags go before the filename; everything after it is the
  // program's own command line.
  return runAgency(dir, ["run", ...args, "sleeper.agency"], env);
}

// Requires the built CLI; skip in a clean checkout (CI runs make first).
describe.skipIf(!cliIsBuilt)("root budget (end-to-end)", () => {
  it("--max-time flag trips the root guard: exit 3 + overrun message", async () => {
    const dir = makeDir();
    try {
      const r = await runCli(dir, ["--max-time", "100ms"]);
      expect(r.stderr).toMatch(/Exceeded time limit/);
      expect(r.code).toBe(3);
    } finally {
      removeTempDir(dir);
    }
  }, 90_000);

  it("a user guard() boundary does not absorb the root budget's trip", async () => {
    const dir = makeDir(GUARDED_SLEEPER);
    try {
      const r = await runCli(dir, ["--max-time", "100ms"]);
      expect(r.stdout).not.toMatch(/GUARD_ABSORBED/);
      expect(r.stderr).toMatch(/Exceeded time limit/);
      expect(r.code).toBe(3);
    } finally {
      removeTempDir(dir);
    }
  }, 90_000);

  it("--max-time counts time spent waiting on a model after a callback ran", async () => {
    const dir = makeDir(CALLBACK_THEN_SLOW_MODEL);
    try {
      const r = await runCli(dir, ["--max-time", "2s"], { AGENCY_LLM_MOCKS: SLOW_REPLY_MOCKS });
      expect(r.stderr).toMatch(/Exceeded time limit/);
      expect(r.code).toBe(3);
    } finally {
      removeTempDir(dir);
    }
  }, 90_000);

  it("a bare unitless --max-time is a usage error (exit 2)", async () => {
    const dir = makeDir();
    try {
      const r = await runCli(dir, ["--max-time", "300"]);
      expect(r.stderr + r.stdout).toMatch(/max-time/);
      expect(r.code).toBe(2);
    } finally {
      removeTempDir(dir);
    }
  }, 90_000);

  it("an inherited AGENCY_MAX_TIME does not leak when the flag is absent", async () => {
    // The env var is an internal carrier from the CLI to its spawned
    // child, not a user-facing knob: `agency run` clears-then-sets it,
    // exactly like AGENCY_RUN_POLICY. A stale value from the parent
    // shell must not constrain the run — the 2s sleeper completes.
    const dir = makeDir();
    try {
      const r = await runCli(dir, [], { AGENCY_MAX_TIME: "100" });
      expect(r.stderr).not.toMatch(/Exceeded time limit/);
      expect(r.code).toBe(0);
    } finally {
      removeTempDir(dir);
    }
  }, 90_000);
});

// The router makes the agent's first model call, so it gets its own queue.
// The coordinator's reply takes 9 seconds and then returns, so a broken limit
// makes the run finish late instead of hanging.
const AGENT_SLOW_REPLY_MOCKS = {
  router: [ROUTE_TO_COORDINATOR],
  "*": [{ return: "all done", delayMs: 9000 }],
};

describe.skipIf(!cliIsBuilt)("root budget in agency agent (end-to-end)", () => {
  it("--max-time stops a -p run while the coordinator waits on the model", async () => {
    const dir = makeTempDir("budget-agent-");
    try {
      const r = await runAgentWithMocks(
        dir,
        ["--brain", "coordinator", "--max-time", "5s", "-p", "wait a while"],
        AGENT_SLOW_REPLY_MOCKS,
      );
      expect(r.stdout).not.toMatch(/all done/);
      expect(r.stderr).toMatch(/Exceeded time limit/);
      expect(r.code).toBe(3);
    } finally {
      removeTempDir(dir);
    }
  }, 90_000);
});
