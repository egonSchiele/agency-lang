// Optimizer efficacy integration test (REAL LLM, main-only).
//
// Proves both built-in optimizers (greedy, gepa) plus the custom-grader and
// custom-optimizer loaders can optimize a trivial agent: rewrite
// "What is the capital of France?" so the agent returns the capital of India.
//
// Runs IN-TREE (not via a temp tarball project): the optimizer forks a workspace
// and runs the agent in a subprocess that resolves `agency-lang` by walking up to
// this package's node_modules, so both the agent file and the runs dir live under
// packages/agency-lang. Requires a real OPENAI_API_KEY and a built dist (`make`).
// Invoked only by the post-merge `test-with-llm.yml` workflow; never on PRs.

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = tests/integration/optimize-efficacy → walk up three levels to packages/agency-lang.
// The optimizer's forked-workspace subprocess walks up to THIS package's node_modules to
// resolve `agency-lang`, so the runs dir AND the CLI's cwd MUST be this package, regardless
// of how the harness was launched.
const PACKAGE_DIR = dirname(dirname(dirname(HERE)));
const AGENT = join(HERE, "fixtures", "agent.agency");
const GRADER = join(HERE, "fixtures", "containsDelhi.ts");
const OPTIMIZER = join(HERE, "fixtures", "customOptimizer.ts");
const GOAL = "Return the capital of India";

const ITERATIONS = Number(process.env.OPTIMIZE_EFFICACY_ITERATIONS ?? "3");
const RETRIES = Number(process.env.OPTIMIZE_EFFICACY_RETRIES ?? "2");

// shell-quote a string as a double-quoted arg (handles the spaces in GOAL).
const q = (s) => JSON.stringify(s);

const runsDir = mkdtempSync(join(PACKAGE_DIR, "optimize-efficacy-runs-"));

const RUNS = [
  { name: "greedy-judge", flags: `--goal ${q(GOAL)}` },
  { name: "gepa-judge", flags: `--optimizer gepa --goal ${q(GOAL)} --minibatch 1` },
  { name: "greedy-grader", flags: `--goal ${q(GOAL)} --graders ${q(GRADER)}` },
  { name: "custom-optimizer", flags: `--optimizer ${q(OPTIMIZER)} --goal ${q(GOAL)}` },
];

function runOnce({ name, flags }) {
  const runId = `${name}-${Date.now()}`;
  const cmd =
    `node ./dist/scripts/agency.js eval optimize ${q(AGENT)} ${flags} ` +
    `--iterations ${ITERATIONS} --runs-dir ${q(runsDir)} --run-id ${q(runId)} ` +
    `--no-writeback --silent`;
  console.log(`[${name}] ${cmd}`);
  execSync(cmd, { cwd: PACKAGE_DIR, stdio: "inherit", timeout: 600_000 });

  const summary = JSON.parse(readFileSync(join(runsDir, runId, "summary.json"), "utf-8"));
  const { trainObjective, baselineObjective, championBreakdown } = summary;

  if (typeof trainObjective !== "number" || typeof baselineObjective !== "number") {
    throw new Error(`missing objectives in summary.json: ${JSON.stringify(summary)}`);
  }
  if (!(trainObjective > baselineObjective)) {
    throw new Error(`no improvement: champion ${trainObjective} <= baseline ${baselineObjective}`);
  }
  const outputs = (championBreakdown ?? []).map((b) => String(b.output));
  if (!outputs.some((o) => /delhi/i.test(o))) {
    throw new Error(`champion output never mentions Delhi: ${JSON.stringify(outputs)}`);
  }
  console.log(`[${name}] PASS (baseline ${baselineObjective} -> champion ${trainObjective})`);
}

function runWithRetries(run) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      runOnce(run);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[${run.name}] attempt ${attempt + 1}/${RETRIES + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

let failed = false;
try {
  for (const run of RUNS) {
    try {
      runWithRetries(run);
    } catch (err) {
      failed = true;
      console.error(`[${run.name}] FAILED after ${RETRIES + 1} attempts: ${err.message}`);
    }
  }
} finally {
  rmSync(runsDir, { recursive: true, force: true });
}

if (failed) {
  console.error("=== Optimizer efficacy tests FAILED ===");
  process.exit(1);
}
console.log("=== Optimizer efficacy tests passed ===");
