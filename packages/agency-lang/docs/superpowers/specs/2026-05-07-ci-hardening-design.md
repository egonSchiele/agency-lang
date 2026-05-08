# CI Hardening Design Spec

## Overview

Harden Agency's CI pipeline with end-to-end integration tests that simulate real user workflows, sandboxed stdlib tests for side-effectful functions, and GitHub Actions security hardening. The goal is confidence that users can install Agency, compile and run scripts via the CLI, bundle with Vite/esbuild, import compiled agents from TypeScript, and rely on stdlib functions -- all working out of the box.

## Priority Order

1. Smoke test (npm pack + install + import)
2. Build tool integration (Vite + esbuild)
3. CLI end-to-end tests
4. Sandboxed stdlib tests (fs, shell, http, plus credential-based tests)
5. Docs build verification
6. GitHub Actions security hardening

## Architecture

### Test structure

Test scripts live in `packages/agency-lang/tests/integration/` with four subdirectories:

```
tests/integration/
  smoke/          # npm pack, install in fresh project, compile + import from TS
  bundlers/       # Vite and esbuild builds
  cli/            # compile, run, stdlib imports, interrupts/handlers, test runner
  stdlib-sandbox/ # sandboxed fs/shell/http execution, credential-based API tests
```

### Isolation model

Integration tests in `smoke/`, `bundlers/`, and `cli/` create completely fresh projects from scratch in a temp directory **outside the monorepo**:

- **CI:** `$RUNNER_TEMP` (guaranteed to exist on GitHub Actions runners, cleaned up after each job)
- **Local:** `os.tmpdir()` (Node.js)

This prevents workspace-level node_modules resolution from masking real install issues. The test scripts orchestrate:

1. `mkdir` a new directory in the temp location
2. `npm init -y`
3. `npm install <path-to-agency-lang-tarball>`
4. Install any additional dependencies (Vite, esbuild, etc.)
5. Write source files
6. Run commands and assert results

**Stdlib sandbox tests** run inside the monorepo (not in a temp project). These test stdlib behavior, not packaging -- the packaging is already validated by the smoke and CLI tests. Running in the monorepo avoids needing to replicate the full build environment in a temp directory. They are separated from normal agency tests so they only run in CI.

**Bootstrapping note:** The smoke test is specifically designed to catch packaging errors (missing files, broken exports). If the tarball is incomplete, the test will fail during `npm install` or `npx agency compile` with missing module errors. Test scripts should capture stderr and report it clearly so these failures are easy to diagnose.

### CI workflow

A new workflow file `.github/workflows/integration.yml` runs after the existing build. It uses GitHub Actions artifacts to pass the tarball between jobs, avoiding redundant builds:

1. **Build job:** Build all packages (`make`), `npm pack`, upload tarball as artifact
2. **Integration job:** Download artifact, run smoke/bundler/CLI/stdlib-sandbox tests
3. **Credential job:** Download artifact, run credential-based stdlib tests (main branch only)

Single Node version (22) -- no matrix needed since these test the published package, not the build.

Tests that require API keys run in a **separate CI job** gated by a GitHub Environment. That job only runs on `push` to `main`, never on `pull_request`, so fork PRs cannot access secrets. Additionally, the credential job runs on a **daily cron schedule** to catch provider breakage even without new commits (inspired by OpenClaw's scheduled live test approach).

**Timeouts:** Each integration test step should have a timeout (5 minutes) to prevent hung CI jobs from blocking the pipeline.

### Test home isolation

All integration tests and stdlib sandbox tests should set `AGENCY_HOME` (or equivalent) to a temp directory so they never read from or write to the real `~/.agency/` directory. This prevents tests from accidentally using real user tokens or mutating real config. On CI, use a fresh temp directory under `$RUNNER_TEMP`.

**Implementation note:** `AGENCY_HOME` does not exist in the codebase yet. Currently, individual features use specific env vars (e.g., `AGENCY_OAUTH_TOKEN_DIR`) or hardcode `~/.agency/` paths. A single `AGENCY_HOME` override needs to be implemented as a prerequisite for this isolation to work.

### Credential safety

API keys for credential-based tests are only available as environment variables. Tests must not write credentials to disk. Any tokens produced during OAuth tests (against the mock server) are written to the temp `AGENCY_HOME` and cleaned up after the test.

---

## 1. Smoke Test

**Location:** `tests/integration/smoke/`

**What it does:**

1. Create a fresh project in `$RUNNER_TEMP`
2. `npm init -y` to create a new `package.json` (with `"type": "module"`)
3. `npm install <tarball>` to install Agency from the packed tarball
4. Write a simple `.agency` file with a `main` node that does pure logic (string concatenation, variable assignment -- no LLM calls)
5. Use the installed `npx agency compile` CLI to compile the `.agency` file
6. Write a TypeScript test file that:
   - Imports the compiled `.js` node
   - Imports from `agency-lang/runtime` (verifies the runtime export works)
   - Calls the node function and asserts the return value
7. Run the test file with `tsx` (installed as a devDependency in the temp project)
8. Assert exit code 0 and expected output

**What this catches:** Missing files in the published package (`files` field in package.json), broken exports map, broken runtime imports, broken post-install hook, broken CLI compilation.

---

## 2. Build Tool Integration

**Location:** `tests/integration/bundlers/`

Each bundler test creates its own fresh project (same tarball install pattern as smoke test).

### esbuild test

1. Create fresh project, install Agency tarball
2. `npm install esbuild` as a devDependency
3. Write a `.agency` file, compile it with `npx agency compile`
4. Write a `.ts` entry file that imports and calls the compiled Agency node
5. Run `npx esbuild --bundle entry.ts --outfile=out.js --platform=node --format=esm`
6. Execute `node out.js` and assert expected output

### Vite test

1. Create fresh project, install Agency tarball
2. `npm install vite` as a devDependency
3. Write a `.agency` file, compile it with `npx agency compile`
4. Write a minimal `vite.config.ts` (lib mode or SSR build -- Node target, not browser)
5. Write a `.ts` entry file that imports and calls the compiled Agency node
6. Run `npx vite build`
7. Execute the built output with `node` and assert expected output

**What this catches:** ESM/CJS issues, missing or unbundlable dependencies, broken module resolution through bundlers, dynamic imports that bundlers cannot handle.

---

## 3. CLI End-to-End Tests

**Location:** `tests/integration/cli/`

Fresh project, install from tarball. All tests avoid LLM calls.

### Test 1: Compile and run a basic script

- Write a `.agency` file with a `main` node that does pure logic (string operations, variable assignment)
- `npx agency run script.agency`
- Assert expected output on stdout

### Test 2: Stdlib imports

- Write a `.agency` file that imports from key stdlib modules:
  - `std::array` (map, filter)
  - `std::math` (add, multiply)
  - `std::path` (join, basename)
  - `std::date` (now, today)
  - `std::object` (mapValues, filterEntries)
- Compile and run, assert correct results
- Catches missing stdlib files in the published package

### Test 3: Interrupts and handlers

- Write a `.agency` file with:
  - A function that throws an interrupt
  - A `handle` block with a `with` clause that approves the interrupt
- Run it, assert execution continued past the interrupt
- Critical: handlers are safety infrastructure and must work correctly

### Test 4: Agency test runner

- Write a `.agency` file and a corresponding `.test.json` with an exact-match test case
- Run `npx agency test script.agency`
- Assert the test passes (exit code 0)

---

## 4. Sandboxed Stdlib Tests

**Location:** `tests/integration/stdlib-sandbox/`

These test side-effectful stdlib functions with real execution in controlled environments. They run inside the monorepo (since they test stdlib behavior, not packaging -- packaging is validated by sections 1-3). They are separated from normal agency tests and designed to run only in CI, not locally, to avoid risk of filesystem/network side effects on a developer machine.

All side-effectful functions throw interrupts. Tests wrap calls in `handle` blocks that approve all interrupts so they can execute non-interactively.

### Filesystem (std::fs)

- Create a temp directory as the sandbox
- Test `mkdir`, `copy`, `move`, `remove`, `edit` -- all operating within the sandbox
- Assert files are created, moved, copied, deleted as expected

### Shell (std::shell)

- Test `exec`, `bash`, `ls`, `glob`, `stat`, `exists`, `which` within a sandbox temp directory
- Most are read operations (low risk)
- `exec` and `bash` throw interrupts -- approve them in handlers

### HTTP (std::http)

- Spin up a local HTTP server (`http.createServer` in Node) in the test harness
- Test `webfetch` against `http://localhost:<port>`
- Assert correct response body
- Tear down the server after the test

### Wikipedia (std::wikipedia)

- No credentials needed -- hits the free Wikipedia API
- Test `search` and `summary` with a known query
- Assert response contains expected content
- Note: this test hits a live external API and could be flaky due to rate limits or network issues. Consider marking it as allowed-to-fail or adding a single retry.

### OAuth (std::oauth)

- Spin up a mock OAuth server (a small Node HTTP server implementing the token endpoint)
- Test `authorize`, `getAccessToken`, `revokeAuth` against the mock server
- Assert the full flow works without needing real OAuth credentials
- No credentials needed -- runs in the main integration job, not the credential-gated job

### Pure stdlib modules

The following pure modules should also be tested in this section since they are not covered by the CLI stdlib import test (which only spot-checks a few modules):

- `std::strategy` (sample, consensus, retry) -- pure LLM orchestration logic, can test with mock/no LLM
- `std::agent` (todoWrite, todoList) -- global todo state, no external dependencies
- `std::policy` (checkPolicy, validatePolicy) -- pure policy evaluation
- `std::system` (args, cwd, env) -- pure environment accessors, safe to test; skip `screenshot` and `openUrl`
- `std::ui` (log, status) -- terminal output; test that calls succeed without crashing, skip interactive prompts

### Credential-based API tests (separate CI job)

These run only on `push` to `main`, gated by a GitHub Environment with protection rules. API keys stored as GitHub Actions secrets.

#### Email (std::email)

- Test `sendWithResend` using Resend's test/sandbox mode
- Store `RESEND_API_KEY` as a secret
- Assert the API call succeeds (no actual email sent in sandbox mode)

#### SMS (std::sms)

- Test `sendSms` using Twilio's test credentials
- Store `TWILIO_TEST_ACCOUNT_SID` and `TWILIO_TEST_AUTH_TOKEN` as secrets
- Assert the API call validates correctly (no actual SMS sent)

#### Weather (std::weather)

- Test `weather` with a known location
- Store the weather API key as a secret
- Assert response contains temperature data

#### Browser (std::browser)

- Test `browserUse` with a Browser Use API key
- Store `BROWSER_USE_API_KEY` as a secret
- Assert basic browser action succeeds

---

## 5. Docs Build Verification

Add a CI step that runs `pnpm run build` in the `docs-new/` directory to verify the documentation builds correctly. This catches broken links, invalid markup, or missing dependencies in the docs site before they reach users.

This can run as a step in the existing `test.yml` build job (or in the new `integration.yml` build job) since it only needs the repo checked out and dependencies installed. No tarball or special isolation needed.

---

## 6. GitHub Actions Security Hardening

### Pin all actions to SHA

Replace tag references with full commit SHAs in all workflow files. To find the correct SHA for each action, check the action's releases page on GitHub and copy the full commit hash for the latest release tag (e.g., `v4`).

Workflow files in scope: `test.yml`, `lint.yml`, and the new `integration.yml`.

Current actions to pin:
- `actions/checkout@v4`
- `pnpm/action-setup@v4`
- `actions/setup-node@v4`
- `actions/upload-artifact` / `actions/download-artifact` (added by this spec)

### Set minimal permissions

Add to every workflow file:

```yaml
permissions:
  contents: read
```

### Secret isolation

- Tests requiring API keys run in a separate job gated by a GitHub Environment with protection rules
- That job only triggers on `push` to `main`, never on `pull_request`
- Fork PRs cannot access secrets

### Input safety

- Verify no `${{ }}` expressions appear in `run:` blocks for attacker-controllable values (PR titles, branch names, issue bodies)
- Use environment variables for any external input that must be referenced in shell commands

### No pull_request_target

- Current workflows do not use `pull_request_target` -- confirm this stays the case
- Document this as a policy in the workflow files via comments

---

## 7. Untested Stdlib Modules

The following stdlib modules cannot be tested in CI. This list should be maintained and revisited periodically to find ways to unblock testing.

| Module | Functions | Reason | What would unblock it |
|--------|-----------|--------|-----------------------|
| **imessage** | `sendIMessage` | macOS only, requires Messages.app configured with an active account | macOS CI runner with Messages.app access, or a mock AppleScript layer |
| **speech** | `speak`, `transcribe` | `speak` requires audio output hardware; `transcribe` needs audio file + API | Mock audio subsystem; for `transcribe`, a test audio file + API key |
| **calendar** | `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `authorizeCalendar` | Requires Google OAuth + a real Google account with Calendar access | Google service account with Calendar API access, or a mock Google Calendar server |
| **clipboard** | `copy`, `paste` | Requires X11 display server (`xclip`/`xsel`); GitHub Actions runners are headless with no display | Set up Xvfb virtual framebuffer on CI, or implement a mock clipboard layer |
| **keyring** | `setSecret`, `getSecret`, `deleteSecret` | Requires system keyring (`gnome-keyring`) with dbus session; complex and fragile on CI | Detailed dbus + gnome-keyring setup steps, or a mock keyring backend |

**Note on `std::index`:** The `index` module contains auto-imported builtins (`print`, `range`, `keys`, `values`, `entries`, `input`, `llm`, etc.). These functions are implicitly exercised by virtually every other test (e.g., every test uses `print`). No dedicated test is needed.

---

## Test runner details

### How integration test scripts work

Each integration test is a Node.js script (`.mjs`) that:

1. Accepts the tarball path as a CLI argument
2. Creates a temp directory using `fs.mkdtemp(path.join(os.tmpdir(), 'agency-integration-'))`
   - On CI, set `TMPDIR=$RUNNER_TEMP` so `os.tmpdir()` returns the correct path
3. Scaffolds a fresh project (package.json, source files)
4. Runs commands via `child_process.execSync`, capturing both stdout and stderr
5. Asserts results (exit codes, stdout content, file existence)
6. Cleans up the temp directory on success (leave it on failure for debugging)
7. Exits with code 0 on success, non-zero on failure

### CI workflow structure

```yaml
# .github/workflows/integration.yml

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
      - checkout (pinned SHA)
      - setup pnpm (pinned SHA)
      - setup node 22 (pinned SHA)
      - pnpm install
      - make
      - cd packages/agency-lang && npm pack
      - upload tarball as artifact

  integration:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      TMPDIR: ${{ runner.temp }}
      AGENCY_HOME: ${{ runner.temp }}/.agency-test
    steps:
      - checkout (pinned SHA)
      - setup pnpm (pinned SHA)
      - setup node 22 (pinned SHA)
      - pnpm install
      - make
      - download tarball artifact
      - run smoke test (timeout 5m)
      - run bundler tests (timeout 5m)
      - run CLI tests (timeout 5m)
      - run stdlib sandbox tests (timeout 5m)

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
      - checkout (pinned SHA)
      - setup pnpm (pinned SHA)
      - setup node 22 (pinned SHA)
      - pnpm install
      - make
      - download tarball artifact
      - run credential-based stdlib tests
```

Note: The `integration` and `integration-credentials` jobs still need `pnpm install` and `make` because the stdlib sandbox tests run inside the monorepo. Only the tarball is shared via artifacts to avoid rebuilding the package.

### Running locally

The integration tests are not part of `pnpm test:run`. To run them locally:

```bash
# Build and pack
make
cd packages/agency-lang && npm pack

# Run a specific integration test
node tests/integration/smoke/test.mjs ./agency-lang-0.1.0.tgz
```

The stdlib sandbox tests should NOT be run locally (they touch real filesystem/network). They are designed for CI only. A developer who wants to run them locally can do so explicitly, understanding the risks.

---

## Companion Spec: Deterministic LLM Client

A separate spec will cover building a `DeterministicClient` that implements the `LLMClient` interface (`lib/runtime/llmClient.ts`) and returns canned/schema-valid responses without making any API calls. This would:

- Enable running the existing agency and agency-js test suites in CI (currently commented out because they need `OPENAI_API_KEY`)
- Make local test runs faster and free (no API calls, instant responses)
- Follow the pattern established by `SimpleOpenAIClient` (`lib/runtime/simpleOpenAIClient.ts`)
- Be swapped in via `setLLMClient()` or config

This is a high-value addition that should be implemented before or in parallel with this CI hardening work, as it would significantly increase CI test coverage by un-gating the existing test suites.
