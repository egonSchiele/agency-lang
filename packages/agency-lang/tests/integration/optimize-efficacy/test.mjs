// Optimizer efficacy integration test (REAL LLM, main-only).
//
// One run per way `agency optimize` can take its inputs, grade, and search,
// each on a trivial agent: replace a style line so the agent answers with the
// bare city name. Every run must beat its baseline AND produce bare city names.
//
// Runs IN-TREE (not via a temp tarball project): the optimizer forks a workspace
// and runs the agent in a subprocess that resolves `agency-lang` by walking up to
// this package's node_modules, so both the agent file and the runs dir live under
// packages/agency-lang. Requires a real OPENAI_API_KEY and a built dist (`make`).
// Invoked only by the post-merge `test-with-llm.yml` workflow; never on PRs.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = tests/integration/optimize-efficacy → walk up three levels to packages/agency-lang.
// The optimizer's forked-workspace subprocess walks up to THIS package's node_modules to
// resolve `agency-lang`, so the runs dir AND the CLI's cwd MUST be this package, regardless
// of how the harness was launched.
const PACKAGE_DIR = dirname(dirname(dirname(HERE)));
const AGENT = join(HERE, "fixtures", "agent.agency");
const GRADER = join(HERE, "fixtures", "onlyCityName.ts");
const OPTIMIZER = join(HERE, "fixtures", "customOptimizer.ts");
// The suite is written the way evals are written now: a directory per test
// holding test.json and graders.ts. Shared with the no-LLM eval-run test.
const SUITE = join(PACKAGE_DIR, "tests", "integration", "eval-suite", "capitals");
const ONE_TEST = join(SUITE, "capital-of-japan");
// --goal alone is one synthetic input whose task IS the goal text, so the goal
// has to carry the question too.
const GOAL = "What is the capital of France? Reply with only the city name and nothing else.";

const ITERATIONS = Number(process.env.OPTIMIZE_EFFICACY_ITERATIONS ?? "3");
const RETRIES = Number(process.env.OPTIMIZE_EFFICACY_RETRIES ?? "2");

// shell-quote a string as a double-quoted arg (handles the spaces in GOAL).
const q = (s) => JSON.stringify(s);

const runsDir = mkdtempSync(join(PACKAGE_DIR, "optimize-efficacy-runs-"));

// Each row covers one thing the rows above it do not. `check` gets the run's
// summary.json and the run directory, and throws on anything wrong beyond the
// shared improvement check.
const RUNS = [
  // Inputs from --goal alone; the goal judge grades.
  { name: "goal-judge", flags: `--goal ${q(GOAL)}` },
  // Inputs from a suite directory; each test's own graders.ts grades it.
  {
    name: "suite-graders",
    flags: `--suite ${q(SUITE)}`,
    check: ({ runDir }) => expectGraderNames(runDir, ["bare-paris", "bare-tokyo"]),
  },
  // --graders replaces every test's own graders.
  {
    name: "suite-graders-override",
    flags: `--suite ${q(SUITE)} --graders ${q(GRADER)}`,
    check: ({ runDir }) => expectNoGraderNames(runDir, ["bare-paris", "bare-tokyo"]),
  },
  // A held-out validation input picks the champion.
  {
    name: "suite-validation-split",
    flags: `--suite ${q(SUITE)} --validation-split 0.5`,
    check: ({ summary }) => {
      if (summary.validationObjective !== 1) {
        throw new Error(`validation objective ${summary.validationObjective}, expected 1`);
      }
    },
  },
  // The other built-in optimizer.
  { name: "suite-gepa", flags: `--suite ${q(SUITE)} --optimizer gepa --minibatch 1` },
  // A user-written optimizer module.
  { name: "suite-custom-optimizer", flags: `--suite ${q(SUITE)} --optimizer ${q(OPTIMIZER)}` },
  // A single test directory as the suite, with the grader override coming from
  // agency.json's eval.optimize instead of a flag. The CLI reads the nearest
  // agency.json above its cwd, so this run's cwd is a directory holding one.
  {
    name: "one-test-config-graders",
    flags: `--suite ${q(ONE_TEST)}`,
    cwd: projectWithConfig({ eval: { optimize: { graders: GRADER } } }),
    check: ({ runDir }) => expectNoGraderNames(runDir, ["bare-tokyo"]),
  },
];

// A directory under this package (so `agency-lang` still resolves) whose
// agency.json is this package's plus `extra`.
function projectWithConfig(extra) {
  const dir = join(runsDir, "project");
  mkdirSync(dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(PACKAGE_DIR, "agency.json"), "utf-8"));
  writeFileSync(join(dir, "agency.json"), JSON.stringify({ ...base, ...extra }, null, 2));
  return dir;
}

function graderNames(runDir) {
  const grades = JSON.parse(readFileSync(join(runDir, "champion", "grades.json"), "utf-8"));
  return grades.flatMap((input) => input.grades.map((g) => g.grader));
}

function expectGraderNames(runDir, names) {
  const seen = graderNames(runDir);
  for (const name of names) {
    if (!seen.includes(name)) throw new Error(`grader ${name} did not grade the champion: ${seen}`);
  }
}

function expectNoGraderNames(runDir, names) {
  const seen = graderNames(runDir);
  for (const name of names) {
    if (seen.includes(name))
      throw new Error(`grader ${name} graded the champion but was overridden: ${seen}`);
  }
}

function runOnce({ name, flags, cwd, check }) {
  const runId = `${name}-${Date.now()}`;
  const cmd =
    `node ${q(join(PACKAGE_DIR, "dist", "scripts", "agency.js"))} optimize ${q(AGENT)} ${flags} ` +
    `--iterations ${ITERATIONS} --runs-dir ${q(runsDir)} --run-id ${q(runId)} ` +
    `--no-writeback --silent`;
  console.log(`[${name}] ${cmd}`);
  execSync(cmd, {
    cwd: cwd ?? PACKAGE_DIR,
    stdio: "inherit",
    timeout: 600_000,
  });

  const runDir = join(runsDir, runId);
  const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf-8"));
  const { trainObjective, baselineObjective, championBreakdown } = summary;

  if (typeof trainObjective !== "number" || typeof baselineObjective !== "number") {
    throw new Error(`missing objectives in summary.json: ${JSON.stringify(summary)}`);
  }
  if (!(trainObjective > baselineObjective)) {
    throw new Error(`no improvement: champion ${trainObjective} <= baseline ${baselineObjective}`);
  }
  // The objective alone could rise for the wrong reason, so check the champion
  // answers the way the goal asks: the bare city, no chatter. Every input must
  // pass, and there has to be at least one -- an empty breakdown would
  // otherwise sail through.
  const outputs = (championBreakdown ?? []).map((b) => String(b.output));
  const isBareCity = (o) => /^(paris|tokyo)[.!]?$/i.test(o.trim());
  if (outputs.length === 0 || !outputs.every(isBareCity)) {
    throw new Error(`champion outputs are not all the bare city name: ${JSON.stringify(outputs)}`);
  }
  if (check) check({ summary, runDir });
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
const skipped = [];
// OPTIMIZE_EFFICACY_ONLY=a,b runs just those rows, for debugging one case.
const only = process.env.OPTIMIZE_EFFICACY_ONLY?.split(",");
for (const run of RUNS) {
  if (only && !only.includes(run.name)) continue;
  if (run.skip) {
    console.log(`[${run.name}] SKIPPED: ${run.skip}`);
    skipped.push(run.name);
    continue;
  }
  try {
    runWithRetries(run);
  } catch (err) {
    failed = true;
    console.error(`[${run.name}] FAILED after ${RETRIES + 1} attempts: ${err.message}`);
  }
}

// Keep the runs dir on failure (and when OPTIMIZE_EFFICACY_KEEP_RUNS is set)
// so real-LLM failures are debuggable without re-spending tokens; on a clean
// pass, clean up to avoid littering the package.
const keepRuns = failed || process.env.OPTIMIZE_EFFICACY_KEEP_RUNS === "1";
if (keepRuns) {
  console.log(`[runs] kept at ${runsDir}`);
} else {
  rmSync(runsDir, { recursive: true, force: true });
}

if (failed) {
  console.error("=== Optimizer efficacy tests FAILED ===");
  process.exit(1);
}
const skipNote = skipped.length ? ` (skipped: ${skipped.join(", ")})` : "";
console.log(`=== Optimizer efficacy tests passed${skipNote} ===`);
