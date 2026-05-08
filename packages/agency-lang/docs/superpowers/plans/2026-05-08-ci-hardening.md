# CI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Agency's CI with end-to-end integration tests, sandboxed stdlib tests, docs build verification, lint re-enablement, and GitHub Actions security hardening.

**Architecture:** Integration tests live in `tests/integration/` with four subdirectories. Smoke, bundler, and CLI tests create fresh projects in temp directories outside the monorepo (installed from an `npm pack` tarball). Stdlib sandbox tests run inside the monorepo. A new `integration.yml` workflow orchestrates everything, with credential-based tests gated to main-only pushes and a daily cron.

**Tech Stack:** GitHub Actions, Node.js 22, npm pack, esbuild, Vite, child_process

**Spec:** `docs/superpowers/specs/2026-05-07-ci-hardening-design.md`

**Follow-up:** A separate spec + plan for a `DeterministicClient` (mock LLM client) will enable running the existing agency and agency-js test suites in CI — currently commented out in test.yml because they need `OPENAI_API_KEY`. That work should be done before or in parallel with this plan for maximum CI coverage.

---

## File Structure

### New files

```
tests/integration/
  helpers.mjs                  # Shared utilities (create temp project, run command, assert, cleanup)
  smoke/test.mjs               # Smoke test: npm pack install, compile, import, run
  bundlers/test-esbuild.mjs    # esbuild bundler test
  bundlers/test-vite.mjs       # Vite bundler test
  cli/test.mjs                 # CLI end-to-end tests (compile, run, stdlib, interrupts, test runner)
  stdlib-sandbox/
    fs.agency                  # Filesystem sandbox test
    fs.test.json
    shell.agency               # Shell sandbox test
    shell.test.json
    http.agency                # HTTP sandbox test (needs JS harness for local server)
    http.test.json
    wikipedia.agency           # Wikipedia API test
    wikipedia.test.json
    oauth.agency               # OAuth mock server test
    oauth.test.json
    pure.agency                # Pure stdlib modules test (strategy, agent, policy, system, ui)
    pure.test.json
    credential/
      email.agency             # Resend sandbox test
      email.test.json
      sms.agency               # Twilio test credentials test
      sms.test.json
      weather.agency           # Weather API test
      weather.test.json
      browser.agency           # Browser Use API test
      browser.test.json

.github/workflows/integration.yml   # New integration test workflow
```

### Modified files

```
.github/workflows/test.yml          # Pin actions to SHA, add permissions, add docs build step
.github/workflows/lint.yml.disable  # Rename back to lint.yml, pin actions to SHA, add permissions
packages/agency-lang/package.json   # Add lint:fix script
```

---

## Task 1: Shared test helpers

**Files:**
- Create: `tests/integration/helpers.mjs`

This module provides reusable utilities for all integration tests: creating temp projects, running shell commands with error capture, and simple assertions.

- [ ] **Step 1: Create the helpers module**

```js
// tests/integration/helpers.mjs
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createTempProject(name) {
  const dir = mkdtempSync(join(tmpdir(), `agency-integration-${name}-`));
  console.log(`[${name}] Created temp project at ${dir}`);
  return dir;
}

export function initProject(dir) {
  run(dir, "npm init -y");
  // Set type: module for ESM
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.type = "module";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

export function installTarball(dir, tarballPath) {
  run(dir, `npm install ${tarballPath}`);
}

export function installDev(dir, ...packages) {
  run(dir, `npm install --save-dev ${packages.join(" ")}`);
}

export function writeFile(dir, relativePath, content) {
  const fullPath = join(dir, relativePath);
  const parentDir = join(fullPath, "..");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(fullPath, content);
}

export function run(dir, command, opts = {}) {
  const { expectFail = false, timeout = 120_000 } = opts;
  console.log(`[run] ${command}`);
  try {
    const output = execSync(command, {
      cwd: dir,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env || {}) },
    });
    if (expectFail) {
      throw new Error(`Expected command to fail but it succeeded: ${command}`);
    }
    return output;
  } catch (err) {
    if (expectFail) return err.stderr || err.stdout || "";
    console.error(`[FAIL] ${command}`);
    console.error("stdout:", err.stdout);
    console.error("stderr:", err.stderr);
    process.exit(1);
  }
}

export function assert(condition, message) {
  if (!condition) {
    console.error(`[ASSERT FAILED] ${message}`);
    process.exit(1);
  }
}

export function assertIncludes(haystack, needle, message) {
  assert(
    haystack.includes(needle),
    message || `Expected output to include "${needle}" but got:\n${haystack}`
  );
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
  console.log(`[cleanup] Removed ${dir}`);
}

export function getTarballPath() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node test.mjs <path-to-tarball>");
    process.exit(1);
  }
  return path;
}
```

- [ ] **Step 2: Verify the module parses**

Run: `node -c tests/integration/helpers.mjs`
Expected: No output (syntax OK)

- [ ] **Step 3: Commit**

```
git add tests/integration/helpers.mjs
git commit -m "add shared test helpers for integration tests"
```

---

## Task 2: Smoke test

**Files:**
- Create: `tests/integration/smoke/test.mjs`

Tests the full user flow: install Agency from tarball, compile an .agency file, import and run the compiled output from TypeScript.

- [ ] **Step 1: Create the smoke test**

```js
// tests/integration/smoke/test.mjs
import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball, installDev,
  writeFile, run, assert, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("smoke");

try {
  // 1. Create fresh project and install Agency
  initProject(dir);
  installTarball(dir, tarball);
  installDev(dir, "tsx");

  // 2. Write a simple .agency file (no LLM calls)
  writeFile(dir, "hello.agency", `
node main(name: string) {
  const greeting = "Hello, " + name + "!"
  print(greeting)
  return greeting
}
`);

  // 3. Compile it
  run(dir, "npx agency compile hello.agency");

  // 4. Write a TS test file that imports the compiled output and the runtime
  writeFile(dir, "test.ts", `
import { main } from "./hello.js";

async function test() {
  const result = await main("World");
  if (result !== "Hello, World!") {
    console.error("Expected 'Hello, World!' but got:", result);
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED");
}

test();
`);

  // 5. Run the test
  const output = run(dir, "npx tsx test.ts");
  assertIncludes(output, "SMOKE TEST PASSED");

  // 6. Also verify runtime import works
  writeFile(dir, "test-runtime.ts", `
import "agency-lang/runtime";
console.log("RUNTIME IMPORT PASSED");
`);
  const runtimeOutput = run(dir, "npx tsx test-runtime.ts");
  assertIncludes(runtimeOutput, "RUNTIME IMPORT PASSED");

  console.log("=== Smoke test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("Smoke test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
```

- [ ] **Step 2: Build the project and create tarball**

Run (from repo root):
```bash
make && cd packages/agency-lang && npm pack
```

- [ ] **Step 3: Run the smoke test locally to verify it works**

Run (from `packages/agency-lang`):
```bash
node tests/integration/smoke/test.mjs ./agency-lang-0.1.0.tgz 2>&1 | tee /tmp/smoke-test-output.txt
```
Expected: `=== Smoke test passed ===`

Note: If it fails, debug using the preserved temp directory. Common issues: missing files in tarball (check `files` field in package.json), broken CLI compilation (check `npx agency compile` output).

- [ ] **Step 4: Commit**

```
git add tests/integration/smoke/test.mjs
git commit -m "add smoke test: npm pack install, compile, import, run"
```

---

## Task 3: esbuild bundler test

**Files:**
- Create: `tests/integration/bundlers/test-esbuild.mjs`

- [ ] **Step 1: Create the esbuild test**

```js
// tests/integration/bundlers/test-esbuild.mjs
import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball, installDev,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("esbuild");

try {
  initProject(dir);
  installTarball(dir, tarball);
  installDev(dir, "esbuild");

  // Write and compile an agency file
  writeFile(dir, "hello.agency", `
node main(name: string) {
  return "Hello, " + name + "!"
}
`);
  run(dir, "npx agency compile hello.agency");

  // Write entry point that imports compiled agency code
  writeFile(dir, "entry.mjs", `
import { main } from "./hello.js";
const result = await main("esbuild");
if (result !== "Hello, esbuild!") {
  console.error("Expected 'Hello, esbuild!' but got:", result);
  process.exit(1);
}
console.log("ESBUILD TEST PASSED");
`);

  // Bundle with esbuild
  run(dir, "npx esbuild entry.mjs --bundle --outfile=out.mjs --platform=node --format=esm --packages=external");

  // Run the bundle
  const output = run(dir, "node out.mjs");
  assertIncludes(output, "ESBUILD TEST PASSED");

  console.log("=== esbuild test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("esbuild test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
```

- [ ] **Step 2: Run the esbuild test locally**

Run (from `packages/agency-lang`):
```bash
node tests/integration/bundlers/test-esbuild.mjs ./agency-lang-0.1.0.tgz 2>&1 | tee /tmp/esbuild-test-output.txt
```
Expected: `=== esbuild test passed ===`

Note: The `--packages=external` flag tells esbuild not to bundle node_modules dependencies — it only bundles the user's code. This is the typical setup for Node.js apps. If bundling fails, check for dynamic imports or CJS/ESM issues in the compiled output.

- [ ] **Step 3: Commit**

```
git add tests/integration/bundlers/test-esbuild.mjs
git commit -m "add esbuild bundler integration test"
```

---

## Task 4: Vite bundler test

**Files:**
- Create: `tests/integration/bundlers/test-vite.mjs`

- [ ] **Step 1: Create the Vite test**

```js
// tests/integration/bundlers/test-vite.mjs
import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball, installDev,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("vite");

try {
  initProject(dir);
  installTarball(dir, tarball);
  installDev(dir, "vite");

  // Write and compile an agency file
  writeFile(dir, "hello.agency", `
node main(name: string) {
  return "Hello, " + name + "!"
}
`);
  run(dir, "npx agency compile hello.agency");

  // Write entry point
  writeFile(dir, "entry.mjs", `
import { main } from "./hello.js";
const result = await main("vite");
if (result !== "Hello, vite!") {
  console.error("Expected 'Hello, vite!' but got:", result);
  process.exit(1);
}
console.log("VITE TEST PASSED");
`);

  // Write Vite config for SSR/Node lib build
  writeFile(dir, "vite.config.mjs", `
import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: true,
    rollupOptions: {
      input: "./entry.mjs",
      output: {
        format: "esm",
      },
    },
    outDir: "dist",
  },
});
`);

  // Build with Vite
  run(dir, "npx vite build");

  // Run the built output
  const output = run(dir, "node dist/entry.mjs");
  assertIncludes(output, "VITE TEST PASSED");

  console.log("=== Vite test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("Vite test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
```

- [ ] **Step 2: Run the Vite test locally**

Run (from `packages/agency-lang`):
```bash
node tests/integration/bundlers/test-vite.mjs ./agency-lang-0.1.0.tgz 2>&1 | tee /tmp/vite-test-output.txt
```
Expected: `=== Vite test passed ===`

- [ ] **Step 3: Commit**

```
git add tests/integration/bundlers/test-vite.mjs
git commit -m "add Vite bundler integration test"
```

---

## Task 5: CLI end-to-end tests

**Files:**
- Create: `tests/integration/cli/test.mjs`

Tests four scenarios: basic compile+run, stdlib imports, interrupts/handlers, and the Agency test runner.

- [ ] **Step 1: Create the CLI test**

```js
// tests/integration/cli/test.mjs
import { resolve } from "node:path";
import {
  createTempProject, initProject, installTarball,
  writeFile, run, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("cli");

try {
  initProject(dir);
  installTarball(dir, tarball);

  // --- Test 1: Compile and run a basic script ---
  console.log("--- Test 1: Basic compile and run ---");
  writeFile(dir, "basic.agency", `
node main() {
  const x = 2 + 3
  const msg = "result is " + toString(x)
  print(msg)
  return msg
}
`);
  const basicOutput = run(dir, "npx agency run basic.agency");
  assertIncludes(basicOutput, "result is 5");
  console.log("Test 1 passed");

  // --- Test 2: Stdlib imports ---
  console.log("--- Test 2: Stdlib imports ---");
  // NOTE: Verify function signatures against each stdlib/*.agency file before writing.
  writeFile(dir, "stdlib-test.agency", `
import { map } from "std::array"
import { add } from "std::math"
import { join } from "std::path"
import { now } from "std::date"
import { mapValues } from "std::object"

node main() {
  const nums = [1, 2, 3]
  const doubled = map(nums) as n {
    return n * 2
  }
  print(doubled)

  const sum = add(10, 20)
  print(sum)

  const p = join("foo", "bar", "baz.txt")
  print(p)

  const t = now()
  print(t > 0)

  const obj = { a: 1, b: 2 }
  const doubled2 = mapValues(obj) as v {
    return v * 2
  }
  print(doubled2)

  return "stdlib ok"
}
`);
  const stdlibOutput = run(dir, "npx agency run stdlib-test.agency");
  assertIncludes(stdlibOutput, "stdlib ok");
  console.log("Test 2 passed");

  // --- Test 3: Interrupts and handlers ---
  console.log("--- Test 3: Interrupts and handlers ---");
  // NOTE: Before writing this test, consult tests/agency/handlers/handle-approve.agency
  // for the correct handler pattern. The pattern below follows the established convention.
  writeFile(dir, "interrupt-test.agency", `
def dangerousAction() {
  return interrupt("Are you sure?")
  return "action completed"
}

node main() {
  handle {
    const result = dangerousAction()
    print(result)
    return result
  } with (data) {
    return approve()
  }
}
`);
  const interruptOutput = run(dir, "npx agency run interrupt-test.agency");
  assertIncludes(interruptOutput, "action completed");
  console.log("Test 3 passed");

  // --- Test 4: Agency test runner ---
  console.log("--- Test 4: Agency test runner ---");
  writeFile(dir, "testable.agency", `
node greet(name: string) {
  return "hi " + name
}
`);
  // NOTE: Verify the test.json format against existing fixtures in tests/agency/
  // (e.g., tests/agency/categorize.test.json) before writing this.
  // The input/expectedOutput format may vary -- check how string args are passed.
  writeFile(dir, "testable.test.json", JSON.stringify({
    tests: [
      {
        nodeName: "greet",
        input: '"Alice"',
        expectedOutput: '"hi Alice"',
        evaluationCriteria: [{ type: "exact" }],
      },
    ],
  }, null, 2));
  run(dir, "npx agency test testable.agency");
  console.log("Test 4 passed");

  console.log("=== All CLI tests passed ===");
  cleanup(dir);
} catch (err) {
  console.error("CLI test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
```

- [ ] **Step 2: Run the CLI tests locally**

Run (from `packages/agency-lang`):
```bash
node tests/integration/cli/test.mjs ./agency-lang-0.1.0.tgz 2>&1 | tee /tmp/cli-test-output.txt
```
Expected: `=== All CLI tests passed ===`

Note: If Test 3 (interrupts) fails, check that the handler syntax is correct — handlers are critical safety infrastructure. If Test 4 (test runner) fails, check the test.json format against `docs/TESTING.md`.

- [ ] **Step 3: Commit**

```
git add tests/integration/cli/test.mjs
git commit -m "add CLI end-to-end integration tests"
```

---

## Task 6: Sandboxed stdlib tests — filesystem

**Files:**
- Create: `tests/integration/stdlib-sandbox/fs.agency`
- Create: `tests/integration/stdlib-sandbox/fs.test.json`

These run inside the monorepo via `pnpm run agency test`. They test real fs operations in a temp directory sandbox.

- [ ] **Step 1: Write the filesystem test**

Consult `stdlib/fs.agency` to verify the exact function signatures and import paths before writing this test. The test should:

- Import `mkdir`, `copy`, `move`, `remove`, `edit` from `std::fs`
- Import `exists`, `stat` from `std::shell` (for assertions)
- Create a temp directory (use a unique path under `/tmp` or the system temp dir)
- Wrap all destructive operations in `handle` blocks that `approve`
- Test: `mkdir` creates a directory, `edit` creates/writes a file, `copy` copies it, `move` renames it, `remove` deletes it
- Assert each operation succeeds by checking file existence with `exists`
- Clean up the sandbox directory at the end

Write the `.agency` file and a `.test.json` with an exact-match test.

- [ ] **Step 2: Run the test**

Run (from `packages/agency-lang`):
```bash
pnpm run agency test tests/integration/stdlib-sandbox/fs.agency 2>&1 | tee /tmp/fs-sandbox-output.txt
```
Expected: Test passes

- [ ] **Step 3: Commit**

```
git add tests/integration/stdlib-sandbox/fs.agency tests/integration/stdlib-sandbox/fs.test.json
git commit -m "add sandboxed filesystem stdlib test"
```

---

## Task 7: Sandboxed stdlib tests — shell

**Files:**
- Create: `tests/integration/stdlib-sandbox/shell.agency`
- Create: `tests/integration/stdlib-sandbox/shell.test.json`

- [ ] **Step 1: Write the shell test**

Consult `stdlib/shell.agency` to verify exact function signatures. The test should:

- Import `exec`, `bash`, `ls`, `glob`, `stat`, `exists`, `which` from `std::shell`
- Create a temp directory sandbox
- Test `ls` on the sandbox dir (should return empty list initially)
- Test `exists` on the sandbox dir (should be true)
- Test `stat` on the sandbox dir
- Test `which` for `node` (should return a path)
- Test `glob` with a pattern in the sandbox
- Test `exec` and `bash` with simple commands (e.g., `echo hello`), wrapped in `handle` blocks that `approve`
- Return a success marker string

Write the `.agency` file and a `.test.json` with an exact-match test.

- [ ] **Step 2: Run the test**

Run (from `packages/agency-lang`):
```bash
pnpm run agency test tests/integration/stdlib-sandbox/shell.agency 2>&1 | tee /tmp/shell-sandbox-output.txt
```
Expected: Test passes

- [ ] **Step 3: Commit**

```
git add tests/integration/stdlib-sandbox/shell.agency tests/integration/stdlib-sandbox/shell.test.json
git commit -m "add sandboxed shell stdlib test"
```

---

## Task 8: Sandboxed stdlib tests — HTTP

**Files:**
- Create: `tests/integration/stdlib-sandbox/http.agency`
- Create: `tests/integration/stdlib-sandbox/http.test.json`
- Create: `tests/integration/stdlib-sandbox/http-server.mjs` (local HTTP server harness)

This test needs a local HTTP server. The approach: a JS harness script starts the server, runs the agency test, then tears down the server.

- [ ] **Step 1: Create the HTTP server harness**

```js
// tests/integration/stdlib-sandbox/http-server.mjs
// Starts a local HTTP server, runs the agency test, then shuts down.
import http from "node:http";
import { execSync } from "node:child_process";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "hello from test server" }));
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`Test server running on port ${port}`);

  try {
    const output = execSync(
      `node ./dist/scripts/agency.js test tests/integration/stdlib-sandbox/http.agency`,
      {
        encoding: "utf-8",
        env: { ...process.env, TEST_HTTP_PORT: String(port) },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    console.log(output);
    console.log("HTTP test passed");
  } catch (err) {
    console.error("HTTP test failed");
    console.error(err.stdout);
    console.error(err.stderr);
    process.exit(1);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Write the HTTP agency test**

Consult `stdlib/http.agency` to verify the exact `webfetch` signature. The test should:

- Import `webfetch` from `std::http`
- Read the port from `env("TEST_HTTP_PORT")`
- Call `webfetch` against `http://127.0.0.1:<port>`, wrapped in a `handle` block that `approve`s
- Assert the response contains `"hello from test server"`
- Return a success marker

Write the `.agency` file and `.test.json`.

- [ ] **Step 3: Run the test**

Run (from `packages/agency-lang`):
```bash
node tests/integration/stdlib-sandbox/http-server.mjs 2>&1 | tee /tmp/http-sandbox-output.txt
```
Expected: `HTTP test passed`

- [ ] **Step 4: Commit**

```
git add tests/integration/stdlib-sandbox/http.agency tests/integration/stdlib-sandbox/http.test.json tests/integration/stdlib-sandbox/http-server.mjs
git commit -m "add sandboxed HTTP stdlib test with local server"
```

---

## Task 9: Sandboxed stdlib tests — Wikipedia, OAuth, and pure modules

**Files:**
- Create: `tests/integration/stdlib-sandbox/wikipedia.agency` + `.test.json`
- Create: `tests/integration/stdlib-sandbox/oauth.agency` + `.test.json` + `oauth-server.mjs`
- Create: `tests/integration/stdlib-sandbox/pure.agency` + `.test.json`

- [ ] **Step 1: Write the Wikipedia test**

Consult `stdlib/wikipedia.agency` for exact signatures. Test `search` and `summary` with a well-known query (e.g., "Albert Einstein"). Assert the response contains expected content. This test hits a live API — note in the test.json description that it may be flaky.

- [ ] **Step 2: Write the OAuth test**

Consult `stdlib/oauth.agency` for exact signatures. Create an `oauth-server.mjs` harness (similar pattern to http-server.mjs) that implements a minimal OAuth token endpoint. Test `authorize`, `getAccessToken`, `revokeAuth` against it.

- [ ] **Step 3: Write the pure modules test**

Consult each stdlib file for exact signatures. Test:
- `std::strategy` — `sample` with a simple list
- `std::agent` — `todoWrite` and `todoList`
- `std::policy` — `checkPolicy` with a simple policy
- `std::system` — `cwd`, `env` (skip `screenshot`, `openUrl`)
- `std::ui` — `log` (just verify it doesn't crash; skip interactive functions)

- [ ] **Step 4: Run each test**

Run each test individually and save output:
```bash
pnpm run agency test tests/integration/stdlib-sandbox/wikipedia.agency 2>&1 | tee /tmp/wikipedia-output.txt
pnpm run agency test tests/integration/stdlib-sandbox/pure.agency 2>&1 | tee /tmp/pure-output.txt
node tests/integration/stdlib-sandbox/oauth-server.mjs 2>&1 | tee /tmp/oauth-output.txt
```

- [ ] **Step 5: Commit**

```
git add tests/integration/stdlib-sandbox/
git commit -m "add Wikipedia, OAuth, and pure module stdlib sandbox tests"
```

---

## Task 10: Credential-based stdlib tests

**Files:**
- Create: `tests/integration/stdlib-sandbox/credential/email.agency` + `.test.json`
- Create: `tests/integration/stdlib-sandbox/credential/sms.agency` + `.test.json`
- Create: `tests/integration/stdlib-sandbox/credential/weather.agency` + `.test.json`
- Create: `tests/integration/stdlib-sandbox/credential/browser.agency` + `.test.json`

These tests require API keys and only run in CI on the `integration-credentials` job.

- [ ] **Step 1: Write the credential-based tests**

For each module, consult the corresponding stdlib file for exact signatures:

- **Email:** Test `sendWithResend` using Resend sandbox mode. Read `RESEND_API_KEY` from env.
- **SMS:** Test `sendSms` using Twilio test credentials. Read `TWILIO_TEST_ACCOUNT_SID` and `TWILIO_TEST_AUTH_TOKEN` from env.
- **Weather:** Test `weather` with a known location. Read `WEATHER_API_KEY` from env.
- **Browser:** Test `browserUse` with a simple action. Read `BROWSER_USE_API_KEY` from env.

Each test should wrap calls in `handle` blocks that `approve`, and return a success marker.

- [ ] **Step 2: Commit**

These tests cannot be run locally without API keys. Just verify they parse:
```bash
pnpm run ast tests/integration/stdlib-sandbox/credential/email.agency > /dev/null
pnpm run ast tests/integration/stdlib-sandbox/credential/sms.agency > /dev/null
pnpm run ast tests/integration/stdlib-sandbox/credential/weather.agency > /dev/null
pnpm run ast tests/integration/stdlib-sandbox/credential/browser.agency > /dev/null
```

```
git add tests/integration/stdlib-sandbox/credential/
git commit -m "add credential-based stdlib tests (email, SMS, weather, browser)"
```

---

## Task 11: Docs build verification

**Files:**
- Modify: `.github/workflows/test.yml`

The root package.json already has `"docs": "pnpm -C packages/agency-lang/docs-new run build"`. Add it as a CI step.

- [ ] **Step 1: Add docs build step to test.yml**

Add after the `make` step and before `pnpm test:run`. Gate it to run only once (not for every matrix entry) since docs don't depend on Node version:

```yaml
    - name: Build docs
      if: matrix.node-version == '22.x'
      run: pnpm run docs
```

- [ ] **Step 2: Verify docs build works locally**

Run (from repo root):
```bash
pnpm run docs 2>&1 | tee /tmp/docs-build-output.txt
```
Expected: vitepress build completes successfully

- [ ] **Step 3: Commit**

```
git add .github/workflows/test.yml
git commit -m "add docs build verification to CI"
```

---

## Task 12: Fix lint errors and re-enable lint workflow

**Files:**
- Modify: `packages/agency-lang/package.json` (add `lint:fix` script)
- Rename: `.github/workflows/lint.yml.disable` -> `.github/workflows/lint.yml`

- [ ] **Step 1: Add lint:fix script to package.json**

Add to the `scripts` section of `packages/agency-lang/package.json`:

```json
"lint:fix": "eslint lib/ --fix"
```

- [ ] **Step 2: Run lint:fix to auto-fix what it can**

Run (from `packages/agency-lang`):
```bash
pnpm run lint:fix 2>&1 | tee /tmp/lint-fix-output.txt
```

This will auto-fix `prefer-const` violations. Other rules (max-depth, max-lines, max-lines-per-function, consistent-type-definitions) are not auto-fixable.

- [ ] **Step 3: Check remaining errors**

Run:
```bash
pnpm run lint:structure 2>&1 | tee /tmp/lint-remaining-output.txt
```

Review the remaining errors. For each:
- `max-lines-per-function`: If the function is legitimately large, add it to the per-file overrides in `eslint.config.js` (like the existing overrides for `typescriptBuilder.ts` and `parser.ts`)
- `max-lines`: Same approach — add per-file overrides for legitimately large files
- `max-depth`: Refactor if simple, or add a targeted `// eslint-disable-next-line` if the nesting is justified
- `consistent-type-definitions`: Change `interface` to `type` (these are straightforward manual fixes)

- [ ] **Step 4: Verify lint passes**

Run:
```bash
pnpm run lint:structure 2>&1 | tee /tmp/lint-final-output.txt
```
Expected: No errors

- [ ] **Step 5: Rename lint.yml.disable back to lint.yml**

```bash
mv .github/workflows/lint.yml.disable .github/workflows/lint.yml
```

- [ ] **Step 6: Commit**

```
git add packages/agency-lang/package.json packages/agency-lang/eslint.config.js .github/workflows/lint.yml
git add -u  # pick up any lint-fixed files
git commit -m "fix lint errors and re-enable structural lint workflow"
```

---

## Task 13: GitHub Actions security hardening

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/lint.yml`

- [ ] **Step 1: Look up current SHAs for each action**

Go to each action's GitHub releases page and find the full commit SHA for the latest release of the major version currently used. Specifically:

- `actions/checkout` — find SHA for latest v4 release
- `pnpm/action-setup` — find SHA for latest v4 release
- `actions/setup-node` — find SHA for latest v4 release
- `actions/upload-artifact` — find SHA for latest v4 release (needed for integration.yml)
- `actions/download-artifact` — find SHA for latest v4 release (needed for integration.yml)

Record these SHAs — they'll be used in both this task and Task 14.

- [ ] **Step 2: Audit existing workflows for injection risks**

Review `test.yml` and `lint.yml` for any `${{ }}` expressions in `run:` blocks that reference attacker-controllable values (e.g., `github.event.pull_request.title`, `github.head_ref`, `github.event.issue.body`). The `${{ matrix.node-version }}` in test.yml is safe (not attacker-controllable). Document the audit result in a comment in each workflow file.

- [ ] **Step 3: Harden test.yml**

Add `permissions: contents: read` at the top level. Replace all `uses:` tag references with pinned SHAs. Add comments explaining the security policy:

```yaml
# Security: all actions pinned to SHA. Do not use pull_request_target.
permissions:
  contents: read
```

- [ ] **Step 4: Harden lint.yml**

Same changes: add permissions block, pin actions to SHA, add security policy comment.

- [ ] **Step 5: Commit**

```
git add .github/workflows/test.yml .github/workflows/lint.yml
git commit -m "harden GitHub Actions: pin to SHA, set minimal permissions"
```

---

## Task 14: Create integration workflow

**Files:**
- Create: `.github/workflows/integration.yml`

This is the main new workflow that runs all integration tests.

- [ ] **Step 1: Create the integration workflow**

Use the pinned SHAs from Task 13. Create `.github/workflows/integration.yml`:

```yaml
# Integration tests for Agency packaging, bundling, CLI, and stdlib.
# Security: all actions pinned to SHA. Do not use pull_request_target.
name: Integration Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 8 * * *'  # daily at 8am UTC

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/action-setup@<SHA>
        with:
          version: 9
          run_install: false
      - uses: actions/setup-node@<SHA>
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: make
      - name: Pack agency-lang tarball
        run: cd packages/agency-lang && npm pack && mv agency-lang-*.tgz $RUNNER_TEMP/agency-lang.tgz
      - uses: actions/upload-artifact@<SHA>
        with:
          name: agency-tarball
          path: ${{ runner.temp }}/agency-lang.tgz
          retention-days: 1

  integration:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      TMPDIR: ${{ runner.temp }}
      AGENCY_HOME: ${{ runner.temp }}/.agency-test
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/action-setup@<SHA>
        with:
          version: 9
          run_install: false
      - uses: actions/setup-node@<SHA>
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: make
      - uses: actions/download-artifact@<SHA>
        with:
          name: agency-tarball
          path: ${{ runner.temp }}
      - name: Smoke test
        run: node packages/agency-lang/tests/integration/smoke/test.mjs $RUNNER_TEMP/agency-lang.tgz
        timeout-minutes: 5
      - name: esbuild bundler test
        run: node packages/agency-lang/tests/integration/bundlers/test-esbuild.mjs $RUNNER_TEMP/agency-lang.tgz
        timeout-minutes: 5
      - name: Vite bundler test
        run: node packages/agency-lang/tests/integration/bundlers/test-vite.mjs $RUNNER_TEMP/agency-lang.tgz
        timeout-minutes: 5
      - name: CLI end-to-end tests
        run: node packages/agency-lang/tests/integration/cli/test.mjs $RUNNER_TEMP/agency-lang.tgz
        timeout-minutes: 5
      - name: Stdlib sandbox tests (fs)
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/fs.agency
        timeout-minutes: 5
      - name: Stdlib sandbox tests (shell)
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/shell.agency
        timeout-minutes: 5
      - name: Stdlib sandbox tests (http)
        working-directory: packages/agency-lang
        run: node tests/integration/stdlib-sandbox/http-server.mjs
        timeout-minutes: 5
      - name: Stdlib sandbox tests (wikipedia)
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/wikipedia.agency
        timeout-minutes: 5
        continue-on-error: true  # live API, may be flaky
      - name: Stdlib sandbox tests (oauth)
        working-directory: packages/agency-lang
        run: node tests/integration/stdlib-sandbox/oauth-server.mjs
        timeout-minutes: 5
      - name: Stdlib sandbox tests (pure modules)
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/pure.agency
        timeout-minutes: 5

  integration-credentials:
    needs: build
    if: >
      (github.event_name == 'push' && github.ref == 'refs/heads/main')
      || github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: ci-credentials
    env:
      TMPDIR: ${{ runner.temp }}
      AGENCY_HOME: ${{ runner.temp }}/.agency-test
      RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
      TWILIO_TEST_ACCOUNT_SID: ${{ secrets.TWILIO_TEST_ACCOUNT_SID }}
      TWILIO_TEST_AUTH_TOKEN: ${{ secrets.TWILIO_TEST_AUTH_TOKEN }}
      WEATHER_API_KEY: ${{ secrets.WEATHER_API_KEY }}
      BROWSER_USE_API_KEY: ${{ secrets.BROWSER_USE_API_KEY }}
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/action-setup@<SHA>
        with:
          version: 9
          run_install: false
      - uses: actions/setup-node@<SHA>
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: make
      - uses: actions/download-artifact@<SHA>
        with:
          name: agency-tarball
          path: ${{ runner.temp }}
      - name: Email test (Resend sandbox)
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/credential/email.agency
        timeout-minutes: 5
      - name: SMS test (Twilio test creds)
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/credential/sms.agency
        timeout-minutes: 5
      - name: Weather test
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/credential/weather.agency
        timeout-minutes: 5
      - name: Browser test
        working-directory: packages/agency-lang
        run: pnpm run agency test tests/integration/stdlib-sandbox/credential/browser.agency
        timeout-minutes: 5
```

Replace all `<SHA>` placeholders with the actual SHAs from Task 13.

- [ ] **Step 2: Verify the workflow YAML is valid**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/integration.yml'))" 2>&1
```
Expected: No errors. If python3/yaml not available, use an online YAML validator.

- [ ] **Step 3: Commit**

```
git add .github/workflows/integration.yml
git commit -m "add integration test workflow with security hardening"
```

---

## Task 15: Update spec with lint.yml correction

**Files:**
- Modify: `docs/superpowers/specs/2026-05-07-ci-hardening-design.md`

- [ ] **Step 1: Fix the spec reference**

The spec says "Workflow files in scope: `test.yml`, `lint.yml`, and the new `integration.yml`." Update to note that `lint.yml` was previously disabled and is being re-enabled as part of this work.

- [ ] **Step 2: Commit**

```
git add docs/superpowers/specs/2026-05-07-ci-hardening-design.md
git commit -m "update spec to note lint.yml re-enablement"
```

---

## Task 16: End-to-end verification

- [ ] **Step 1: Run all integration tests locally**

From `packages/agency-lang`:
```bash
npm pack
node tests/integration/smoke/test.mjs ./agency-lang-*.tgz 2>&1 | tee /tmp/final-smoke.txt
node tests/integration/bundlers/test-esbuild.mjs ./agency-lang-*.tgz 2>&1 | tee /tmp/final-esbuild.txt
node tests/integration/bundlers/test-vite.mjs ./agency-lang-*.tgz 2>&1 | tee /tmp/final-vite.txt
node tests/integration/cli/test.mjs ./agency-lang-*.tgz 2>&1 | tee /tmp/final-cli.txt
```

From `packages/agency-lang` (stdlib sandbox):
```bash
pnpm run agency test tests/integration/stdlib-sandbox/fs.agency 2>&1 | tee /tmp/final-fs.txt
pnpm run agency test tests/integration/stdlib-sandbox/shell.agency 2>&1 | tee /tmp/final-shell.txt
node tests/integration/stdlib-sandbox/http-server.mjs 2>&1 | tee /tmp/final-http.txt
pnpm run agency test tests/integration/stdlib-sandbox/pure.agency 2>&1 | tee /tmp/final-pure.txt
```

- [ ] **Step 2: Run existing tests to verify nothing is broken**

```bash
pnpm test:run 2>&1 | tee /tmp/final-unit-tests.txt
pnpm run lint:structure 2>&1 | tee /tmp/final-lint.txt
pnpm run docs 2>&1 | tee /tmp/final-docs.txt
```

- [ ] **Step 3: Verify docs build passes**

```bash
pnpm run docs 2>&1 | tee /tmp/final-docs.txt
```
Expected: vitepress build succeeds

- [ ] **Step 4: Final commit if any fixups needed**

```
git add -A
git commit -m "final integration test fixups"
```
