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

try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  const agentDir = join(TMP_ROOT, "agent");
  mkdirSync(agentDir, { recursive: true });

  writeFileSync(join(agentDir, "agent.agency"), `def check() {
  return interrupt("confirm the thing")
}

node main() {
  const r = check()
  return "made it past the interrupt"
}
`);
  writeFileSync(join(TMP_ROOT, "inputs.json"), JSON.stringify({
    inputs: [{ id: "interrupting", goal: "finish despite the interrupt", args: {} }],
  }));

  const runsDir = join(TMP_ROOT, "runs");
  const output = execSync(
    `node ${JSON.stringify(AGENCY_CLI)} eval run` +
    ` --agent ${JSON.stringify(join(agentDir, "agent.agency"))}` +
    ` --inputs ${JSON.stringify(join(TMP_ROOT, "inputs.json"))}` +
    ` --runs-dir ${JSON.stringify(runsDir)} --run-id interrupt-e2e --no-grade`,
    { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  assert(output.includes("1/1 inputs ok"), `expected a fully-ok run, got:\n${output}`);

  const summary = JSON.parse(readFileSync(join(runsDir, "interrupt-e2e", "summary.json"), "utf-8"));
  assert(summary.okCount === 1, `okCount: expected 1, got ${summary.okCount}`);
  assert(summary.inputs[0].status === "success", `input status: ${summary.inputs[0].status}`);

  // The auto-approval must be auditable from the run's own statelog.
  const statelogPath = join(runsDir, "interrupt-e2e", "inputs", "interrupting", "agent", "statelog.jsonl");
  const events = readFileSync(statelogPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const resolved = events.find((e) => e.data?.type === "interruptResolved");
  assert(resolved, "no interruptResolved event in the statelog");
  assert(resolved.data.outcome === "approved", `outcome: ${resolved.data.outcome}`);
  assert(resolved.data.resolvedBy === "ipc", `resolvedBy: ${resolved.data.resolvedBy}`);

  // The record survives extraction: the interrupt shows up approved.
  const record = JSON.parse(readFileSync(join(runsDir, "interrupt-e2e", "inputs", "interrupting", "agent", "eval-record.json"), "utf-8"));
  assert(record.interrupts.length === 1, `interrupts: expected 1, got ${record.interrupts.length}`);
  assert(record.interrupts[0].outcome === "approved", `record outcome: ${record.interrupts[0].outcome}`);

  console.log("[eval-run-integration] PASS: interrupting agent auto-approved over IPC, verdict recorded");
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}
