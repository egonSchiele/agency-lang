// `agency remote` end-to-end test — a real upload to a live StateLog.
//
// Unlike the serve/adapter tests (which stand up a local server), this exercises
// the whole hosted-agent lifecycle against the real service: `remote deploy`
// uploads the fixture and writes the binding, then `remote ls` / `remote call`
// hit the live serve routes, including a full interrupt pause -> resume cycle.
//
// Gating: the test SKIPS (exit 0) unless STATELOG_API_KEY, STATELOG_HOST, and
// STATELOG_PROJECT_ID are set. Those are CI secrets in the `ci-credentials`
// environment, so this runs only on push to main — never on PRs, where secrets
// are unavailable. Skipping (not failing) keeps it safe to have in the tree and
// runnable locally by anyone without credentials.
//
// One-agent-per-project: each run OVERWRITES the target project's agent. That is
// the accepted rule for now ("latest upload wins"); point STATELOG_PROJECT_ID at
// a throwaway project.
//
// Runs against the in-repo built CLI (dist/scripts/agency.js), so `make` must
// have run first. No LLM calls — the fixture is pure logic plus one interrupt.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const AGENCY_CLI = resolve(REPO_ROOT, "dist", "scripts", "agency.js");

const { STATELOG_API_KEY, STATELOG_HOST, STATELOG_PROJECT_ID } = process.env;

if (!STATELOG_API_KEY || !STATELOG_HOST || !STATELOG_PROJECT_ID) {
  console.log(
    "[remote] SKIP — set STATELOG_API_KEY, STATELOG_HOST, and STATELOG_PROJECT_ID to run.\n" +
      "         (These live in the ci-credentials environment; this test runs on push to main.)",
  );
  process.exit(0);
}

if (!existsSync(AGENCY_CLI)) {
  console.error(`[remote] CLI not built at ${AGENCY_CLI}. Run 'make' first.`);
  process.exit(1);
}

// Temp project INSIDE the repo so the compiled agent resolves node_modules — an
// agent compiled under /tmp cannot resolve the stdlib prelude.
const dir = resolve(__dirname, ".tmp");

// A pure-logic agent: one function (one-shot) and one node that raises a single
// interrupt before returning, so the resume path is exercised end-to-end.
const FIXTURE = `export def add(a: number, b: number): number {
  return a + b
}

export node confirmThenGreet(name: string) {
  const _ = interrupt("Proceed?")
  return "Hello, \${name}!"
}
`;

function agency(args, { allowFailure = false } = {}) {
  const command = `node ${JSON.stringify(AGENCY_CLI)} ${args}`;
  try {
    return execSync(command, {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (allowFailure) return combined;
    throw new Error(`Command failed: ${command}\n${combined}`);
  }
}

function setup() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Minimal config; `remote deploy` writes the remote binding back into it.
  writeFileSync(join(dir, "agency.json"), `${JSON.stringify({}, null, 2)}\n`);
  writeFileSync(join(dir, "agent.agency"), FIXTURE);
}

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

// 1. deploy — a real upload that writes the binding into agency.json.
step("deploy uploads and links", () => {
  agency(
    `remote deploy agent.agency --host ${JSON.stringify(STATELOG_HOST)} ` +
      `--project ${JSON.stringify(STATELOG_PROJECT_ID)}`,
  );
  const config = JSON.parse(readFileSync(join(dir, "agency.json"), "utf-8"));
  assert(
    typeof config.remote?.serveUrl === "string",
    `deploy did not write remote.serveUrl (got ${JSON.stringify(config.remote)})`,
  );
  assertIncludes(config.remote.serveUrl, "/serve/", "serveUrl should be a serve base URL");
});

// 2. ls — a real /list round-trip over the deployed endpoints.
step("ls lists the deployed endpoints", () => {
  const out = agency("remote ls");
  assertIncludes(out, "add", "function 'add' should be listed");
  assertIncludes(out, "confirmThenGreet", "node 'confirmThenGreet' should be listed");
});

// 3. call a function — one-shot value over /function (numbers via --arg JSON coercion).
step("call --function returns the computed value", () => {
  const out = agency("remote call add --function --arg a=2 --arg b=3");
  assertIncludes(out, "5", `expected 5 in output, got: ${out}`);
});

// 4. call a node with approve-all — the full interrupt pause -> resume cycle.
step("call node drives the interrupt resume cycle", () => {
  const out = agency("remote call confirmThenGreet --arg name=world --policy approve-all");
  assertIncludes(out, "Hello, world!", `expected greeting after resume, got: ${out}`);
});

// 5. call a node with no interrupt flag — the surfaced interrupt is reported
//    unhandled and the command exits non-zero, exactly like `agency run`.
step("call node without a policy reports the unhandled interrupt", () => {
  const out = agency("remote call confirmThenGreet --arg name=world", { allowFailure: true });
  assertIncludes(out, "was not handled", `expected unhandled-interrupt message, got: ${out}`);
});

function main() {
  setup();
  const failed = [];
  for (const { name, fn } of steps) {
    process.stdout.write(`[remote] ${name}... `);
    try {
      fn();
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(`  ${err.message}`);
      failed.push(name);
    }
  }
  if (failed.length === 0) {
    console.log("\n[remote] All steps passed.");
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  console.error(`\n[remote] ${failed.length} step(s) failed: ${failed.join(", ")}`);
  console.error(`[remote] Temp directory preserved at ${dir}`);
  process.exit(1);
}

main();
