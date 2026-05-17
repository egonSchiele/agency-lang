// StateLog integration tests.
//
// Each scenario compiles a small .agency program with `observability: true`
// and `log.logFile: <tmpfile>`, runs it via the in-repo CLI, then reads the
// resulting JSONL file and asserts on the emitted events.
//
// Goals:
//  - End-to-end coverage of the StateLog wiring (config → compile-time
//    generated client → runtime emissions → file sink).
//  - Verify span hierarchy (parent/child) from outside the runtime.
//  - Verify the "observability: false" zero-overhead guarantee at the
//    process level: the file is never created.
//
// These tests do NOT make LLM calls. They run against the local repo's
// compiled CLI (`dist/scripts/agency.js`), so `make` must have been run
// first. Tests can be run locally with:
//
//   node tests/integration/statelog/test.mjs
//
// or in CI via the integration-test step in .github/workflows/test.yml.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const AGENCY_CLI = resolve(REPO_ROOT, "dist", "scripts", "agency.js");

if (!existsSync(AGENCY_CLI)) {
  console.error(`[statelog-integration] CLI not built at ${AGENCY_CLI}. Run 'make' first.`);
  process.exit(1);
}

// All scenarios live under tests/integration/statelog/.tmp/<scenario>.
// Inside the repo so that compiled JS can resolve node_modules — agency-lang
// will not find runtime imports if compiled to /tmp.
const TMP_ROOT = resolve(__dirname, ".tmp");

function setupScenario(name) {
  const dir = join(TMP_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgencyJson(dir, extraLog = {}) {
  const config = {
    observability: true,
    log: {
      host: "",
      projectId: "statelog-integration",
      logFile: join(dir, "events.jsonl"),
      ...extraLog,
    },
  };
  writeFileSync(join(dir, "agency.json"), JSON.stringify(config, null, 2));
}

function writeAgencyFile(dir, source) {
  writeFileSync(join(dir, "main.agency"), source);
}

function runAgency(dir, { allowFailure = false } = {}) {
  // Use the in-repo CLI directly — no tarball install needed because the
  // generated TS imports `agency-lang/runtime` which resolves via the
  // workspace's node_modules.
  try {
    execSync(`node ${JSON.stringify(AGENCY_CLI)} run ${JSON.stringify(join(dir, "main.agency"))} -c ${JSON.stringify(join(dir, "agency.json"))}`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    if (!allowFailure) throw err;
  }
}

function readEvents(dir) {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Failed to parse line ${i}: ${line}`);
    }
  });
}

function eventTypes(events) {
  return events.map((e) => e.data.type);
}

function assert(condition, message) {
  if (!condition) throw new Error(`[ASSERT FAILED] ${message}`);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `[ASSERT FAILED] ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(arr, value, message) {
  assert(arr.includes(value), `${message}\n  expected ${JSON.stringify(arr)} to include ${JSON.stringify(value)}`);
}

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ---- Scenario: single-node agent ----

scenario("single-node-agent", async () => {
  const dir = setupScenario("single-node-agent");
  writeAgencyJson(dir);
  writeAgencyFile(dir, `node main() {\n  return "hello"\n}\n`);
  runAgency(dir);
  const events = readEvents(dir);
  const types = eventTypes(events);

  assertIncludes(types, "agentStart", "agentStart event missing");
  assertIncludes(types, "agentEnd", "agentEnd event missing");
  assertIncludes(types, "enterNode", "enterNode event missing");
  assertIncludes(types, "exitNode", "exitNode event missing");
  assertIncludes(types, "threadCreated", "default thread should be logged");

  // Span hierarchy: enterNode runs inside the agentRun span.
  const agentStart = events.find((e) => e.data.type === "agentStart");
  const enterNode = events.find((e) => e.data.type === "enterNode");
  assert(agentStart.span_id, "agentStart should have a span_id");
  assert(enterNode.parent_span_id === agentStart.span_id, "enterNode.parent_span_id should be agentStart.span_id");

  // agentEnd should carry tokenStats (zero tokens since no LLM calls).
  const agentEnd = events.find((e) => e.data.type === "agentEnd");
  assert(agentEnd.data.tokenStats !== undefined, "agentEnd should include tokenStats");
});

// ---- Scenario: multi-node chain ----

scenario("multi-node-chain", async () => {
  const dir = setupScenario("multi-node-chain");
  writeAgencyJson(dir);
  writeAgencyFile(dir, `
node step2() {
  return "done from step2"
}

node main() {
  goto step2()
}
`);
  runAgency(dir);
  const events = readEvents(dir);
  const nodeIds = events
    .filter((e) => e.data.type === "enterNode")
    .map((e) => e.data.nodeId);
  assertEqual(nodeIds, ["main", "step2"], "should enter both nodes in order");
});

// ---- Scenario: fork-all ----

scenario("fork-all", async () => {
  const dir = setupScenario("fork-all");
  writeAgencyJson(dir);
  writeAgencyFile(dir, `
def double(n: number): number {
  return n * 2
}

node main() {
  let results = fork([1, 2, 3]) as item {
    return double(item)
  }
  return results
}
`);
  runAgency(dir);
  const events = readEvents(dir);
  const types = eventTypes(events);

  assertIncludes(types, "forkStart", "forkStart event missing");
  assertIncludes(types, "forkEnd", "forkEnd event missing");

  const forkStart = events.find((e) => e.data.type === "forkStart");
  assertEqual(forkStart.data.mode, "all", "fork should be mode:all");
  assertEqual(forkStart.data.branchCount, 3, "branchCount should be 3");

  const branchEnds = events.filter((e) => e.data.type === "forkBranchEnd");
  assertEqual(branchEnds.length, 3, "should emit one forkBranchEnd per branch");
  for (const be of branchEnds) {
    assertEqual(be.data.outcome, "success", "every branch should succeed");
  }
});

// ---- Scenario: race ----

scenario("race", async () => {
  const dir = setupScenario("race");
  writeAgencyJson(dir);
  writeAgencyFile(dir, `
def identity(n: number): number {
  return n
}

node main() {
  let result = race([1, 2, 3]) as item {
    return identity(item)
  }
  return result
}
`);
  runAgency(dir);
  const events = readEvents(dir);
  const types = eventTypes(events);

  assertIncludes(types, "forkStart", "forkStart event missing");
  assertIncludes(types, "forkEnd", "forkEnd event missing");

  const forkStart = events.find((e) => e.data.type === "forkStart");
  assertEqual(forkStart.data.mode, "race", "fork should be mode:race");

  const forkEnd = events.find((e) => e.data.type === "forkEnd");
  assert(typeof forkEnd.data.winnerIndex === "number", "forkEnd should record winnerIndex");

  // Exactly one branch wins; the others are aborted.
  const branchEnds = events.filter((e) => e.data.type === "forkBranchEnd");
  const outcomes = branchEnds.map((e) => e.data.outcome).sort();
  const winners = branchEnds.filter((e) => e.data.outcome === "success");
  assertEqual(winners.length, 1, "exactly one branch should succeed");
  // The remaining two branches should be "aborted".
  assertEqual(
    branchEnds.filter((e) => e.data.outcome === "aborted").length,
    2,
    "the two losing branches should be aborted",
  );
});

// ---- Scenario: interrupt with no handler propagates to user ----

scenario("interrupt-propagated", async () => {
  const dir = setupScenario("interrupt-propagated");
  writeAgencyJson(dir);
  writeAgencyFile(dir, `
node main() {
  const x = interrupt("Please confirm")
  return x
}
`);
  // The CLI exits non-zero on interrupt — that's fine for this scenario;
  // we care about the events that were written before the pause.
  runAgency(dir, { allowFailure: true });
  const events = readEvents(dir);
  const types = eventTypes(events);

  // For top-level interrupts (no surrounding tool call), the runtime emits
  // an `interruptThrown` event. The matching `checkpointCreated` for these
  // is currently emitted by generated template code rather than the runtime
  // (see lib/runtime/interrupts.ts), so we don't assert on it here.
  assertIncludes(types, "interruptThrown", "interruptThrown event missing");

  // The interrupt should have a non-empty interruptId.
  const intr = events.find((e) => e.data.type === "interruptThrown");
  assert(intr.data.interruptId, "interruptThrown must carry interruptId");
});

// ---- Scenario: thread + subthread blocks ----

scenario("thread-subthread", async () => {
  const dir = setupScenario("thread-subthread");
  writeAgencyJson(dir);
  writeAgencyFile(dir, `
node main() {
  thread {
    subthread {
      let _ = 1
    }
  }
  return "done"
}
`);
  runAgency(dir);
  const events = readEvents(dir);
  const threads = events.filter((e) => e.data.type === "threadCreated");
  // 1 default + 1 user thread + 1 subthread = 3.
  assert(threads.length >= 3, `expected at least 3 threadCreated events, got ${threads.length}`);
  const types = threads.map((e) => e.data.threadType);
  assertIncludes(types, "thread", "should have a regular thread");
  assertIncludes(types, "subthread", "should have a subthread");

  const sub = threads.find((e) => e.data.threadType === "subthread");
  assert(sub.data.parentThreadId !== undefined, "subthread should record parentThreadId");
});

// ---- Scenario: runMetadata follow-up on agentStart ----

scenario("run-metadata", async () => {
  const dir = setupScenario("run-metadata");
  writeAgencyJson(dir, {
    metadata: {
      environment: "ci",
      tags: ["foo", "bar"],
    },
  });
  writeAgencyFile(dir, `node main() {\n  return "ok"\n}\n`);
  runAgency(dir);
  const events = readEvents(dir);
  const types = eventTypes(events);
  assertIncludes(types, "runMetadata", "runMetadata event missing");
  const rm = events.find((e) => e.data.type === "runMetadata");
  assertEqual(rm.data.environment, "ci", "environment should be propagated");
  assertEqual(rm.data.tags, ["foo", "bar"], "tags should be propagated");
});

// ---- Scenario: zero-overhead when observability: false ----

scenario("zero-overhead-disabled", async () => {
  const dir = setupScenario("zero-overhead-disabled");
  // Note: observability is explicitly FALSE here; the logFile is still
  // configured so we can prove the file is never created.
  writeFileSync(
    join(dir, "agency.json"),
    JSON.stringify(
      {
        observability: false,
        log: {
          host: "",
          projectId: "statelog-integration",
          logFile: join(dir, "events.jsonl"),
        },
      },
      null,
      2,
    ),
  );
  writeAgencyFile(dir, `
def double(n: number): number {
  return n * 2
}

node main() {
  let results = fork([1, 2, 3]) as item {
    return double(item)
  }
  return results
}
`);
  runAgency(dir);
  assert(
    !existsSync(join(dir, "events.jsonl")),
    "events.jsonl must NOT be created when observability is false",
  );
});

// ---- Runner ----

async function main() {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  let passed = 0;
  let failed = [];
  for (const { name, fn } of scenarios) {
    process.stdout.write(`[statelog] ${name}... `);
    try {
      await fn();
      console.log("ok");
      passed++;
    } catch (err) {
      console.log("FAILED");
      console.error(`  ${err.message}`);
      if (err.stdout) console.error(`  stdout: ${err.stdout}`);
      if (err.stderr) console.error(`  stderr: ${err.stderr}`);
      failed.push(name);
    }
  }
  if (failed.length === 0) {
    console.log(`\n[statelog] All ${passed} scenarios passed.`);
    // Clean up only on full success — preserve on failure for debugging.
    rmSync(TMP_ROOT, { recursive: true, force: true });
    process.exit(0);
  } else {
    console.error(`\n[statelog] ${failed.length} scenario(s) failed: ${failed.join(", ")}`);
    console.error(`[statelog] Temp directory preserved at ${TMP_ROOT}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[statelog] runner crashed:", err);
  process.exit(1);
});
