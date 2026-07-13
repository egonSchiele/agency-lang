// std::agents efficacy integration test (REAL LLM, main-only, NON-BLOCKING in CI).
//
// Exercises the worker agents end-to-end against real success criteria:
//   - codingAgent nails an exact byte-level output contract (loop-forcing).
//   - agencyCodingAgent writes+runs a program whose RESULT is correct.
//   - verify is strict in BOTH directions (wrong file -> errors, right file -> none).
//   - writeAgency produces compiling source (regression for the prompt upgrade).
//   - researchAgent returns a cited, grounded fact (skipped if web search is off).
//
// Each case copies a fixture driver into a fresh temp dir and runs it there so
// the agent's file writes and compile artifacts stay isolated. Drivers approve
// their own tool interrupts with `with approve`. Requires a real OPENAI_API_KEY
// and a built dist (`make`). Set AGENTS_EFFICACY_ONLY=<name,name> to run a subset.

import { execSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/integration/agents -> tests/integration -> tests -> packages/agency-lang
const PACKAGE_DIR = dirname(dirname(dirname(HERE)));
const CLI = join(PACKAGE_DIR, "dist", "scripts", "agency.js");
const FIXTURES = join(HERE, "fixtures");
const RETRIES = Number(process.env.AGENTS_EFFICACY_RETRIES ?? "1");
const ONLY = (process.env.AGENTS_EFFICACY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

class Skip extends Error {}

function freshDir(name) {
  return mkdtempSync(join(PACKAGE_DIR, `agents-efficacy-${name}-`));
}

// Copy a fixture in as driver.agency and run it with cwd = dir. Returns stdout.
function runFixture(dir, fixture) {
  copyFileSync(join(FIXTURES, fixture), join(dir, "driver.agency"));
  return execSync(`node ${JSON.stringify(CLI)} driver.agency`, {
    cwd: dir,
    encoding: "utf-8",
    timeout: 600_000,
  });
}

const CASES = [
  {
    name: "coding-contract",
    run() {
      const dir = freshDir("coding");
      try {
        runFixture(dir, "coding_contract.agency");
        const p = join(dir, "data.json");
        if (!existsSync(p)) throw new Error("codingAgent did not create data.json");
        const bytes = readFileSync(p);
        const got = bytes.toString("utf-8");
        if (got !== '{"count":3}') {
          throw new Error(`data.json bytes wrong: ${JSON.stringify(got)} (len ${bytes.length})`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "agency-sum",
    run() {
      const dir = freshDir("agency");
      try {
        const out = runFixture(dir, "agency_sum.agency");
        if (!/RESULT=6\b/.test(out)) {
          throw new Error(`agencyCodingAgent result not 6: ${out.trim().slice(-200)}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "verify-strict",
    run() {
      // Both polarities with the SAME driver, different seeded answer.txt.
      const dir = freshDir("verify");
      try {
        writeFileSync(join(dir, "answer.txt"), "99\n");
        const wrong = runFixture(dir, "verify_check.agency");
        if (!/HAS_ERRORS/.test(wrong)) {
          throw new Error(`verify did not flag a wrong file: ${wrong.trim().slice(-200)}`);
        }
        writeFileSync(join(dir, "answer.txt"), "42\n");
        const right = runFixture(dir, "verify_check.agency");
        if (!/NO_ERRORS/.test(right)) {
          throw new Error(`verify flagged a correct file: ${right.trim().slice(-200)}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "writeagency-regression",
    run() {
      const dir = freshDir("writeagency");
      try {
        const out = runFixture(dir, "writeagency_regression.agency");
        if (!/COMPILED/.test(out)) {
          throw new Error(`writeAgency did not produce compiling source: ${out.trim().slice(-200)}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "research-cited",
    run() {
      const dir = freshDir("research");
      try {
        let out;
        try {
          out = runFixture(dir, "research_year.agency");
        } catch (err) {
          const msg = String(err.stdout ?? "") + String(err.message ?? "");
          if (/search|network|backend|no api key|ENOTFOUND/i.test(msg)) {
            throw new Skip(`web search unavailable: ${msg.slice(0, 120)}`);
          }
          throw err;
        }
        if (!/1889/.test(out)) {
          throw new Error(`researchAgent answer missing 1889: ${out.trim().slice(-200)}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

function runWithRetries(c) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      c.run();
      return;
    } catch (err) {
      if (err instanceof Skip) throw err;
      lastErr = err;
      console.error(`[${c.name}] attempt ${attempt + 1}/${RETRIES + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

let failed = false;
const skipped = [];
for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.name)) continue;
  console.log(`[${c.name}] running...`);
  try {
    runWithRetries(c);
    console.log(`[${c.name}] PASS`);
  } catch (err) {
    if (err instanceof Skip) {
      console.log(`[${c.name}] SKIPPED: ${err.message}`);
      skipped.push(c.name);
      continue;
    }
    failed = true;
    console.error(`[${c.name}] FAILED after ${RETRIES + 1} attempts: ${err.message}`);
  }
}

if (failed) {
  console.error("=== std::agents efficacy tests FAILED ===");
  process.exit(1);
}
const note = skipped.length ? ` (skipped: ${skipped.join(", ")})` : "";
console.log(`=== std::agents efficacy tests passed${note} ===`);
