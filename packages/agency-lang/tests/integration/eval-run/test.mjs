// `agency eval run` integration test: an interrupting agent under eval.
//
// Pins the IPC auto-approval contract end-to-end: the eval parent answers a
// subprocess interrupt with a well-formed IpcDecisionMessage, the child's
// runtime merges it and continues, and the verdict is recorded in the run's
// statelog (`interruptResolved`, resolvedBy "ipc"). The regression this
// guards: the parent once replied with a legacy `{ approved: true }` shape,
// the child read `outcome.kind` off undefined, and every interrupting agent
// under `agency eval run` crashed.
//
// No LLM calls. Runs against the in-repo compiled CLI (`dist/scripts/
// agency.js`), so `make` (or `pnpm run build`) must have been run first:
//
//   node tests/integration/eval-run/test.mjs

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const AGENCY_CLI = resolve(REPO_ROOT, "dist", "scripts", "agency.js");

if (!existsSync(AGENCY_CLI)) {
  console.error(`[eval-run-integration] CLI not built at ${AGENCY_CLI}. Run 'make' first.`);
  process.exit(1);
}

// Inside the repo so the compiled agent resolves agency-lang via node_modules;
// the runs dir is a SIBLING of the agent dir, never inside it (the seed copy
// would otherwise recurse into its own destination).
const TMP_ROOT = resolve(__dirname, ".tmp");

function assert(condition, message) {
  if (!condition) throw new Error(`[ASSERT FAILED] ${message}`);
}

// On failure the scenario directory is KEPT for inspection (and execSync's
// captured child output is printed) — the failure path is the one that needs
// the evidence. EVAL_RUN_KEEP_TMP=1 keeps it on success too, same pattern as
// the optimize-efficacy harness.
let passed = false;
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  const agentDir = join(TMP_ROOT, "agent");
  mkdirSync(agentDir, { recursive: true });

  writeFileSync(join(agentDir, "agent.agency"), `def check() {
  return interrupt("confirm the thing")
}

node main(task: string) {
  // task is unused: eval entry nodes must take exactly one parameter
  // (the input's task); this test is about interrupts, not delivery.
  check()
  return "made it past the interrupt"
}
`);
  writeFileSync(join(TMP_ROOT, "inputs.json"), JSON.stringify({
    inputs: [{ id: "interrupting", goal: "finish despite the interrupt", input: "run" }],
  }));

  const runsDir = join(TMP_ROOT, "runs");
  let output;
  try {
    output = execSync(
      `node ${JSON.stringify(AGENCY_CLI)} eval run` +
      ` ${JSON.stringify(join(agentDir, "agent.agency"))}` +
      ` --suite ${JSON.stringify(join(TMP_ROOT, "inputs.json"))}` +
      ` --out ${JSON.stringify(join(runsDir, "interrupt-e2e"))}`,
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    // execSync's error message is just the command line; the child's actual
    // output sits on the error object and nobody prints it by default.
    console.error("[eval-run-integration] eval run failed. Child stdout:");
    console.error(err.stdout ?? "(none)");
    console.error("[eval-run-integration] Child stderr:");
    console.error(err.stderr ?? "(none)");
    throw err;
  }
  assert(output.includes("1/1 tests ok"), `expected a fully-ok run, got:\n${output}`);

  // The run directory: one statelog holding the test's trace, plus the
  // harness's `run` row saying which test it was and how it ended.
  const runDir = join(runsDir, "interrupt-e2e", "interrupting");
  const rows = readFileSync(join(runDir, "annotations.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const runRow = rows.find((row) => row.kind === "run");
  assert(runRow, "no run annotation in annotations.jsonl");
  assert(runRow.ended === "ok", `run row ended: ${runRow.ended}`);
  assert(runRow.test.id === "interrupting", `run row test id: ${runRow.test.id}`);
  for (const stale of ["summary.json", "config.json", "inputs", "verifier"]) {
    assert(!existsSync(join(runDir, stale)), `old-format artifact present: ${stale}`);
  }

  // The auto-approval must be auditable from the run's own statelog.
  const statelogPath = join(runDir, "statelog.jsonl");
  const events = readFileSync(statelogPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert(events.every((e) => e.trace_id === runRow.traceId), "statelog trace id does not match the run row");
  const resolved = events.find((e) => e.data?.type === "interruptResolved");
  assert(resolved, "no interruptResolved event in the statelog");
  assert(resolved.data.outcome === "approved", `outcome: ${resolved.data.outcome}`);
  assert(resolved.data.resolvedBy === "ipc", `resolvedBy: ${resolved.data.resolvedBy}`);

  // The trace names what ran and what it was given: the eval task arrives as
  // an explicit `input`, and the seeded agent's code identity is recorded.
  const started = events.find((e) => e.data?.type === "agentStart");
  assert(started, "no agentStart event in the statelog");
  assert(started.data.input === "run", `agentStart.input: ${JSON.stringify(started.data.input)}`);
  assert(started.data.code?.entry === "agent.agency", `agentStart.code.entry: ${JSON.stringify(started.data.code)}`);
  assert(/^[0-9a-f]{64}$/.test(started.data.code?.closureHash ?? ""), "agentStart.code.closureHash missing");

  // The workdir snapshot and the agent's code are attached, flat.
  assert(existsSync(join(runDir, "workdir")), "no workdir snapshot for the run");
  assert(existsSync(join(runDir, "workdir.json")), "no workdir sidecar");
  assert(existsSync(join(runDir, "code", "agent.agency")), "agent code not stored under code/");

  console.log("[eval-run-integration] PASS: interrupting agent auto-approved over IPC, verdict recorded");

  // ── Scenario B: a COMMAND target, end to end ──
  // The load-bearing check for --agent-cmd: the spawned CLI (a real `agency
  // run` process, not a fork) writes its statelog to the harness's expected
  // path via AGENCY_CONFIG_OVERRIDES, argv delivery works through a real
  // CLI, and the whole tree lands on ONE trace id (AGENCY_TRACE_ID). Do not
  // trim the single-trace assertion: it is the real proof for the trace-id
  // env var (its unit test only pins mint order).
  const cmdFixtures = join(TMP_ROOT, "cmd-fixtures");
  mkdirSync(cmdFixtures, { recursive: true });
  // A command target reaches the agent through the CLI, so the task arrives in
  // the program's argv rather than in a node parameter. `args()` reads it raw:
  // an eval task is arbitrary text and may begin with a dash, which `parseArgs`
  // would try to read as a flag.
  writeFileSync(join(cmdFixtures, "writer.agency"), `import { args } from "std::system"

node main(): string {
  const task = args()[0]
  handle {
    write("out.txt", task)
  } with (data) {
    if (data.effect == "std::write") {
      return approve()
    }
    return reject()
  }
  return "wrote out.txt"
}
`);
  writeFileSync(join(TMP_ROOT, "cmd-inputs.json"), JSON.stringify({
    inputs: [{ id: "cmd-e2e", goal: "writes the input to out.txt", input: "hello from a command target", files: cmdFixtures }],
  }));
  const agentCmd = `node ${AGENCY_CLI} run --policy approve-all writer.agency -- {task}`;
  let cmdOutput;
  try {
    cmdOutput = execSync(
      `node ${JSON.stringify(AGENCY_CLI)} eval run` +
      ` --agent-cmd ${JSON.stringify(agentCmd)}` +
      ` --suite ${JSON.stringify(join(TMP_ROOT, "cmd-inputs.json"))}` +
      ` --out ${JSON.stringify(join(runsDir, "cmd-e2e"))}`,
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    console.error("[eval-run-integration] command-target run failed. Child stdout:");
    console.error(err.stdout ?? "(none)");
    console.error("[eval-run-integration] Child stderr:");
    console.error(err.stderr ?? "(none)");
    throw err;
  }
  assert(cmdOutput.includes("1/1 tests ok"), `expected a fully-ok command run, got:\n${cmdOutput}`);

  const cmdRunDir = join(runsDir, "cmd-e2e", "cmd-e2e");
  const cmdRows = readFileSync(join(cmdRunDir, "annotations.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const cmdRunRow = cmdRows.find((row) => row.kind === "run");
  assert(cmdRunRow && cmdRunRow.ended === "ok", `command run row: ${JSON.stringify(cmdRunRow)}`);
  // argv delivery through a real CLI: the agent wrote the task text
  const outTxt = readFileSync(join(cmdRunDir, "workdir", "out.txt"), "utf-8");
  assert(outTxt === "hello from a command target", `out.txt: ${JSON.stringify(outTxt)}`);
  // the spawned agent's own events landed at the harness statelog path...
  const cmdEvents = readFileSync(join(cmdRunDir, "statelog.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert(cmdEvents.some((e) => e.data?.type === "agentStart"), "no agentStart from the spawned CLI in the harness statelog");
  // `agency run` fills the code identity itself, and a named-args run
  // (no eval task delivery) records no `input` — the runtime never guesses one.
  const cmdStarted = cmdEvents.find((e) => e.data?.type === "agentStart");
  assert(cmdStarted.data.code?.entry === "writer.agency", `command agentStart.code: ${JSON.stringify(cmdStarted.data.code)}`);
  assert(!("input" in cmdStarted.data), `command agentStart should not record input, got ${JSON.stringify(cmdStarted.data.input)}`);
  // ...with exactly one trace id across the whole tree
  const traceIds = [...new Set(cmdEvents.map((e) => e.trace_id))];
  assert(traceIds.length === 1, `expected one trace id, got ${traceIds.length}: ${traceIds.join(", ")}`);
  assert(traceIds[0] === cmdRunRow.traceId, "the command run's trace id is the one the harness minted");
  console.log("[eval-run-integration] PASS: command target — argv delivery, statelog handoff, single trace id");

  // ── Scenario C: a command that writes no statelog fails with the hint ──
  // (The --log clobber itself lives in `agency agent`, which is LLM-bound;
  // the hint text covers both causes and this pins the whole detection path:
  // command "succeeds", no statelog at the harness path, error names it.)
  try {
    execSync(
      `node ${JSON.stringify(AGENCY_CLI)} eval run` +
      ` --agent-cmd ${JSON.stringify(`node -e 1+1 {task}`)}` +
      ` --suite ${JSON.stringify(join(TMP_ROOT, "cmd-inputs.json"))}` +
      ` --out ${JSON.stringify(join(runsDir, "cmd-clobber"))}`,
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // exit code is not the assertion; error.txt is
  }
  const clobberRows = readFileSync(join(runsDir, "cmd-clobber", "cmd-e2e", "annotations.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const clobberRun = clobberRows.find((row) => row.kind === "run");
  assert(clobberRun && clobberRun.ended === "error", `clobber run row: ${JSON.stringify(clobberRun)}`);
  assert(clobberRun.error.includes("If your command passes --log, remove it"),
    `the run row's error should name the --log clobber cause, got:\n${clobberRun.error}`);
  console.log("[eval-run-integration] PASS: missing statelog names the --log/non-Agency causes");

  // ── Scenario D: a command without {task} fails at resolution, before any run dir exists ──
  let noPlaceholderFailed = false;
  try {
    execSync(
      `node ${JSON.stringify(AGENCY_CLI)} eval run --agent-cmd "echo hello"` +
      ` --suite ${JSON.stringify(join(TMP_ROOT, "cmd-inputs.json"))}` +
      ` --out ${JSON.stringify(join(runsDir, "cmd-noplaceholder"))}`,
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    noPlaceholderFailed = true;
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    assert(text.includes("{task}"), `error should name the {task} requirement, got:\n${text}`);
  }
  assert(noPlaceholderFailed, "a command without {task} must be rejected");
  assert(!existsSync(join(runsDir, "cmd-noplaceholder")), "no run directory should exist for a resolution-time failure");
  console.log("[eval-run-integration] PASS: missing {task} rejected before any run");

  // ── Scenario E: `agency run --capture-workdir <dir>` writes a run directory ──
  // A plain run, no harness: the trace, the code and the working directory
  // land in the named directory through the same `addToRunDirectory` the
  // `runs add` command uses.
  const captureDir = join(TMP_ROOT, "captured");
  const captureCwd = join(TMP_ROOT, "capture-cwd");
  mkdirSync(captureCwd, { recursive: true });
  writeFileSync(join(captureCwd, "note.txt"), "in the working directory");
  writeFileSync(join(cmdFixtures, "trivial.agency"), `node main(): string {
  return "captured"
}
`);
  let captureOutput;
  try {
    captureOutput = execSync(
      `node ${JSON.stringify(AGENCY_CLI)} run --capture-workdir ${JSON.stringify(captureDir)}` +
      ` ${JSON.stringify(join(cmdFixtures, "trivial.agency"))}`,
      { cwd: captureCwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    console.error("[eval-run-integration] --capture-workdir run failed. Child stdout:");
    console.error(err.stdout ?? "(none)");
    console.error("[eval-run-integration] Child stderr:");
    console.error(err.stderr ?? "(none)");
    throw err;
  }
  const capturedMatch = captureOutput.match(/Captured trace (\S+) into/);
  assert(capturedMatch, `no capture line in output:\n${captureOutput}`);
  const capturedTraceId = capturedMatch[1];
  const capturedRunDir = join(captureDir, capturedTraceId);
  const capturedEvents = readFileSync(join(capturedRunDir, "statelog.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert(capturedEvents.length > 0 && capturedEvents.every((e) => e.trace_id === capturedTraceId),
    "captured statelog does not hold exactly the run's trace");
  const capturedStart = capturedEvents.find((e) => e.data?.type === "agentStart");
  assert(capturedStart?.data.code?.entry === "trivial.agency", `captured code identity: ${JSON.stringify(capturedStart?.data.code)}`);
  assert(existsSync(join(capturedRunDir, "code", "trivial.agency")), "captured code not stored");
  assert(readFileSync(join(capturedRunDir, "workdir", "note.txt"), "utf-8") === "in the working directory",
    "working directory not captured");
  console.log("[eval-run-integration] PASS: run --capture-workdir writes a run directory");

  // ── Scenario F: the capture destination sits INSIDE the working directory ──
  // `agency run --capture-workdir ./runs/example agent.agency` from a project
  // root is the natural invocation. The run directory is left out of its own
  // workdir snapshot instead of being copied into itself.
  const inTreeOutput = execSync(
    `node ${JSON.stringify(AGENCY_CLI)} run --capture-workdir ./runs/example` +
    ` ${JSON.stringify(join(cmdFixtures, "trivial.agency"))}`,
    { cwd: captureCwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  const inTreeMatch = inTreeOutput.match(/Captured trace (\S+) into/);
  assert(inTreeMatch, `no capture line in output:\n${inTreeOutput}`);
  const inTreeDir = join(captureCwd, "runs", "example", inTreeMatch[1]);
  const inTreeWorkdir = join(inTreeDir, "workdir");
  assert(readFileSync(join(inTreeWorkdir, "note.txt"), "utf-8") === "in the working directory",
    "in-tree capture did not snapshot the working directory");
  assert(!existsSync(join(inTreeWorkdir, "runs", "example")),
    "in-tree capture copied the group directory into itself");
  assert(existsSync(join(inTreeDir, "statelog.jsonl")), "in-tree capture wrote no statelog");
  console.log("[eval-run-integration] PASS: run --capture-workdir with a destination inside cwd");

  passed = true;
} finally {
  if (passed && !process.env.EVAL_RUN_KEEP_TMP) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } else if (!passed) {
    console.error(`[eval-run-integration] evidence kept at ${TMP_ROOT}`);
  }
}
