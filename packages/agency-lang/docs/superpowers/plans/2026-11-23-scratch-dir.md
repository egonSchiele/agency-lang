# Scratch Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each run gets a scratch folder that the built-in policies approve, that the agent is steered to by a reject message, and whose name survives an interrupt and resume.

**Architecture:** The folder's path is computed from the run's id, so nothing new is saved in a checkpoint. A `<scratch>` placeholder in policy rules resolves to that path, inside a run from the run's own id and outside a run from the interrupt's `runId`. One stdlib function, `scratchDir()`, returns the path and creates the folder.

**Tech Stack:** TypeScript (`lib/runtime/`, `lib/stdlib/`), Agency (`stdlib/fs.agency`, the agent in `lib/agents/agency-agent/`), vitest, Agency and agency-js tests.

**Spec:** `docs/superpowers/specs/2026-11-23-scratch-dir-design.md`. Read it first. This plan does not repeat its reasoning.

## Amendments after the architecture review (2026-11-23)

The review is in `docs/superpowers/plans/2026-11-23-scratch-dir-review.md`. The owner chose to build the scratch folder and accepted the review's recommendations. Where a task below disagrees with this section, this section wins.

1. **The run id stays out of the resolved folders (finding 1).** `PolicyDirs` gains two optional fields. `scratchParent` is the real path of `<temp>/agency-scratch-<user id>`, resolved once from the host by `resolvePolicyDirs(host)`, whose signature does not change. `scratch` is the finished path for one run. The matcher fills `scratch` itself when it is absent: from `scratchParent` and the `runId` of the interrupt it is checking. An execution context sets `scratch` for its own run when it is built, with a pure helper that reads no file, so code inside a run needs no run id on the interrupt. There is no `withScratchFor`, and the sites outside a run change only as far as passing the interrupt's `runId` through.
2. **Both new fields are optional (finding 4).** A missing value means the same as null.
3. **The scratch folder and the saved-output folder share their naming and creation (finding 5).** `lib/runtime/userTempFolder.ts` holds both halves, and `spillFolder` and `writeCopy` use it.
4. **The agent calls `scratchDir()` at the start of every turn (finding 2).** A parent folder that exists and is not private gives an error that names the folder to delete.
5. **The dev doc says the folder is not a security boundary between runs (finding 3).** A run id can be chosen by whoever starts the run.

## Background for someone new to this code

- **Interrupts and policies.** Read "MUST READ: How interrupts, handlers, policies, and effects work" in `CLAUDE.md`, then "Rule matching" and "Why `recommended` has no `std::write` rule" in `docs/dev/agents/approval-policies.md`.
- **Placeholders.** A policy rule can say `<agent-home>` in a path field. `resolvePolicyDirs` (`lib/runtime/policyDirs.ts`) resolves the real folders once per run into a `PolicyDirs` value, and the matcher in `lib/runtime/policy.ts` substitutes them (`substitutePlaceholders`). The matcher reads no file.
- **A run's id.** `resolveInvocation` (`lib/runtime/invocationOptions.ts:235-257`) decides it. On a resume it is the paused interrupt's `runId`. A subprocess inherits its parent's. Every `Interrupt` carries `runId` (`lib/runtime/interrupts.ts:107`).
- **The precedent.** The saved-output folder, `agency-spill-<user id>`, is built by `spillFolder` in `lib/runtime/toolOutputStore.ts` and created by `writeCopy` in `lib/stdlib/spill.ts:201` with `host.files.privateDir`. The scratch folder's parent is made the same way.

## Global Constraints

- The scratch path is `<temp>/agency-scratch-<user id>/<id>`, where `<temp>` is `host.system.tempDir()` with trailing slashes removed, and `<id>` is the first 16 characters of `sha256Text("agency-scratch:" + runId)` (`lib/utils/hash.ts`).
- Nothing stores the path. Every reader computes it from a host and a run id.
- No function, flag, setting, or environment variable sets the scratch folder's location.
- The placeholder text is exactly `<scratch>`.
- The reject message is exactly `Write temporary files under <scratch> instead.` before substitution.
- The `/tmp` reject pattern is exactly `{/tmp,/tmp/**,/private/tmp,/private/tmp/**}`.
- Reads elsewhere in `/tmp` get no reject rule.
- No TypeScript module-level state. Do not cache the path in a module variable.
- Do not add code for symlinks beyond what `privateDir` already does.
- Run `pnpm run typecheck` after TypeScript edits, and `pnpm exec prettier --write` on each TypeScript file you changed. Never run `fmt:ts` over the whole tree.
- Do not run `agency fmt` on an existing `.agency` file.
- Run `make` once, at the point Task 3 says. Save every test run's output to a file under `$LOGS`, a scratch folder outside the repository. Do not run the whole Agency test suite.
- Write every commit message in a file and pass it with `git commit -F <file>`.
- Change files with the Edit and Write tools only.

## Review Focus

1. A run id with path characters, such as `../../Users/me/.agency-agent`, must still give a path directly under `agency-scratch-<user id>`. [Task 1]
2. `scratchDir()` must return the same path before an interrupt and after the resume, and a file written before must still be there. [Task 3]
3. A project that lives under `/tmp` must not have its writes rejected: under `recommended` they prompt, and under `with-writes` they are approved. [Task 4]
4. A policy checked outside a run, by `agency run --interactive`, the terminal session, or the MCP server, must approve a write under the interrupt's own scratch folder. [Task 2]
5. A rule that says `<scratch>` must match nothing when there is no run id, and its reject message must be returned with `<scratch>` left as written. [Task 2]

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/runtime/scratchDir.ts` (new) | The path of a run's scratch folder, and creating it. |
| `lib/runtime/scratchDir.test.ts` (new) | Its tests. |
| `lib/runtime/policy.ts` | `PolicyDirs.scratch`, the `<scratch>` placeholder, and filling placeholders in a reject message. |
| `lib/runtime/policyDirs.ts` | `resolvePolicyDirs` takes a run id. |
| `lib/runtime/state/context.ts`, `interruptResolution.ts`, `interruptPromptContext.ts`, `lib/stdlib/agentTerminalSession.ts`, `lib/serve/mcp/interruptLoop.ts` | Each passes the run id it has. |
| `lib/runtime/builtinPolicies.ts` | The scratch rules in `recommended` and `with-writes`. |
| `lib/stdlib/fs.ts`, `stdlib/fs.agency` | `scratchDir()`. |
| `lib/agents/agency-agent/lib/projectContext.agency`, two skills | Telling the agent the path. |
| `docs/dev/runtime/scratch-dir.md` (new), `docs/dev/agents/approval-policies.md`, `CLAUDE.md` | Dev docs. |

---

### Task 1: the scratch folder's path

**Files:**
- Create: `lib/runtime/scratchDir.ts`, `lib/runtime/scratchDir.test.ts`

**Interfaces:**
- Consumes: `Host` (`lib/host/host.js`), `sha256Text` (`lib/utils/hash.js`).
- Produces:

```ts
/** The start of the scratch parent folder's name; the user id follows. */
export const SCRATCH_FOLDER_PREFIX = "agency-scratch-";

/** The scratch folder of the run `runId`, as the host spells its temp
 *  folder. The path is computed, never stored, so it is the same before
 *  and after a resume. No run id can give a path outside the parent. */
export function scratchDirPath(host: Host, runId: string): string;

/** Create the run's scratch folder if it is missing and return its path.
 *  The parent is made with `privateDir`, so a parent another user made
 *  first is an error. */
export async function ensureScratchDir(host: Host, runId: string): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

Use the fake host other runtime tests use for `tempDir` and `userId`. `policyDirs.test.ts` shows how a host is built for a test.

```ts
it("is the same path for the same run id", ...)          // two calls, equal
it("differs for two run ids", ...)
it("has the shape <temp>/agency-scratch-<uid>/<16 hex>", ...)   // /^\/tmp\/agency-scratch-1000\/[0-9a-f]{16}$/ with tempDir "/tmp/" and userId "1000"
it("keeps a run id with path characters inside the parent", ...) // runId "../../Users/me/.agency-agent" matches the same shape
it("ensureScratchDir creates the folder and returns scratchDirPath", ...) // against a real temp folder, then remove it with safeDeleteDirectoryWithin
it("ensureScratchDir twice succeeds", ...)
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run lib/runtime/scratchDir.test.ts > $LOGS/t1.log 2>&1; echo "exit=$?"`
Expected: `exit=1`, the module does not exist.

- [ ] **Step 3: Write `lib/runtime/scratchDir.ts`**

`ensureScratchDir` follows `writeCopy` in `lib/stdlib/spill.ts:201`: get a root for the temp folder with `host.files.root`, call `privateDir` for the parent, then `privateDir` for `<parent>/<id>`.

- [ ] **Step 4: Run the tests, typecheck, format, commit**

Expected: `exit=0`. Message: `runtime: the path of a run's scratch folder`

---

### Task 2: the `<scratch>` placeholder

**Files:**
- Modify: `lib/runtime/policy.ts`: `PolicyDirs` (line 126), `substitutePlaceholders` (207), `ruleResult` (52), `checkPolicyExplicit` (78)
- Modify: `lib/runtime/policyDirs.ts`: `resolvePolicyDirs` (25)
- Modify: `lib/runtime/state/context.ts` (394, 592, 619), `lib/runtime/interruptResolution.ts` (99-103), `lib/runtime/interruptPromptContext.ts` (20), `lib/stdlib/agentTerminalSession.ts` (163-166), `lib/serve/mcp/interruptLoop.ts` (12-18)
- Test: `lib/runtime/policy.test.ts`, `lib/runtime/policyDirs.test.ts`, `lib/runtime/interruptResolution.test.ts`, `lib/serve/mcp/interruptLoop.test.ts`

**Interfaces:**
- Consumes: `scratchDirPath` from Task 1.
- Produces:

```ts
// policy.ts
export const SCRATCH_PLACEHOLDER = "<scratch>";
export type PolicyDirs = {
  // ...the four existing fields...
  /** What `<scratch>` means: this run's scratch folder, or null when the
   *  check has no run id. The placeholder then stays as written, so the
   *  rule never matches. */
  scratch: string | null;
};

// policyDirs.ts
/** `runId` is the run the dirs are for: the run's own id inside a run,
 *  the interrupt's `runId` outside one. Omitted, `scratch` is null. */
export function resolvePolicyDirs(host: Host, runId?: string): PolicyDirs;

/** `dirs` with `scratch` set for `runId`. For a site that resolved the
 *  dirs once and then meets interrupts from one or more runs. */
export function withScratchFor(dirs: PolicyDirs, host: Host, runId: string | undefined): PolicyDirs;
```

`scratch` is `scratchDirPath(host, runId)` with its temp-folder part passed through `host.system.realDir`, because file effects put real paths in their payloads. On macOS `/tmp` is `/private/tmp` and the temp folder is under `/private/var`. Resolve the temp folder, which always exists, and append the rest.

- [ ] **Step 1: Write the failing tests in `lib/runtime/policy.test.ts`**

Add `describe("<scratch> dir patterns", ...)`, modeled on `describe("<agent-home> dir patterns", ...)` (line 651):

```ts
// dirs.scratch = "/tmp/agency-scratch-1000/abc"
// a rule { match: { dir: "{<scratch>,<scratch>/**}" }, action: "approve" } on std::write
it("approves a write in the scratch folder", ...)            // dir "/tmp/agency-scratch-1000/abc"      → approve
it("approves a write below it", ...)                         // dir "/tmp/agency-scratch-1000/abc/sub"  → approve
it("does not approve another run's folder", ...)             // dir "/tmp/agency-scratch-1000/zzz"      → propagate
it("matches nothing when scratch is null", ...)              // same rule, scratch: null                 → propagate
it("resolves <scratch> in a remove's target", ...)           // std::remove, match { target: "<scratch>/**" } → approve
it("fills <scratch> in a reject message", ...)               // message "Write temporary files under /tmp/agency-scratch-1000/abc instead."
it("leaves <scratch> in a reject message when scratch is null", ...)  // message unchanged
it("fills <agent-home> in a reject message", ...)            // the fill is general
```

Add to `lib/runtime/interruptResolution.test.ts`: `buildDecider` with a policy holding the approve rule above approves an interrupt whose `data.dir` is `scratchDirPath(host, interrupt.runId)` resolved, and gives no approval to the same `dir` under an interrupt with another `runId`. Add the same pair to `lib/serve/mcp/interruptLoop.test.ts` for `applyPolicy`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run lib/runtime/policy.test.ts lib/runtime/interruptResolution.test.ts lib/serve/mcp/interruptLoop.test.ts > $LOGS/t2.log 2>&1; echo "exit=$?"`
Expected: `exit=1`.

- [ ] **Step 3: Add the placeholder to `policy.ts`**

Add `substituteScratch(pattern, scratch)`, written like `substituteInstallDir` (line 167), which leaves the pattern alone when its directory is null. Call it from `substitutePlaceholders`.

- [ ] **Step 4: Fill placeholders in a reject message**

`ruleResult` takes the dirs. For a reject rule with a message, it replaces each of `<agent-home>`, `<home>`, `<agency>`, and `<scratch>` with the plain path, with no glob escaping, and leaves a placeholder whose directory is null as written. Both `checkPolicyExplicit` call sites pass `dirs`.

- [ ] **Step 5: Pass a run id at every site that resolves the dirs**

| Site | Run id |
|---|---|
| `context.ts:592`, the execution context | The run id set at line 619. Resolve the dirs after the run id is set. |
| `context.ts:394`, the global context | None. `scratch` is null there. |
| `interruptResolution.ts`, `buildDecider` | Resolve once as today, then `withScratchFor(dirs, host, interrupt.runId)` for each interrupt. |
| `agentTerminalSession.ts`, `settleUnder` | The same, per interrupt. |
| `serve/mcp/interruptLoop.ts`, `applyPolicy` | The same, per interrupt. The interrupts' type there lists four fields. Add `runId?: string`, and check that the caller passes whole interrupts. |
| `interruptPromptContext.ts`, `promptContext` | None. It builds the prompt's folder choices, and no rule is checked with it. Confirm that by reading its callers, and pass a run id if one of them checks a rule. |

- [ ] **Step 6: Run the tests from Step 2 and `lib/runtime/policyDirs.test.ts`, typecheck, format, commit**

Expected: `exit=0`. Message: `policy: a <scratch> placeholder, resolved from the run id`

---

### Task 3: `scratchDir()`

**Files:**
- Modify: `lib/stdlib/fs.ts`, `stdlib/fs.agency`
- Create: `tests/agency/stdlib/scratch-dir-basic.agency`, `tests/agency/stdlib/scratch-dir-basic.test.json`
- Create: `tests/agency-js/scratch-dir-resume/` (`agent.agency`, `test.js`, `fixture.json`)

**Interfaces:**
- Consumes: `ensureScratchDir` from Task 1.
- Produces, in `stdlib/fs.agency`:

```
@capabilities(fileRead, fileWrite)
export def scratchDir(): Result<string> {
  """
  Return the absolute path of this run's scratch folder, creating the folder if it does not exist yet. Use it for temporary files.
  """
}
```

It calls `_scratchDir` in `lib/stdlib/fs.ts`, which calls `ensureScratchDir(run.ctx.host, run.ctx.getRunId())` for `currentRun()`. It raises no interrupt. Put a doc comment above it, for developers, that says why: the caller chooses neither the location nor the name.

- [ ] **Step 1: Write `tests/agency/stdlib/scratch-dir-basic.agency`**

Model the files on `tests/agency/stdlib/cwd-basic.agency` and its `.test.json`. One node returns three values: whether two calls return the same path, whether the path contains `/agency-scratch-`, and whether `ls` of the path succeeds with `with approve`. Expected output: `[true,true,true]`.

- [ ] **Step 2: Write the agency-js test `scratch-dir-resume`**

Model it on `tests/agency-js/fetch-cache-resume/`, which checks that run state survives a resume. The node:

1. calls `scratchDir()` and writes `note.txt` holding `kept` into it, `with approve`;
2. raises an interrupt that no handler answers;
3. after the resume, calls `scratchDir()` again and reads `note.txt`.

`test.js` runs the node, takes the interrupt, resumes with an approval, and asserts that the path returned after the resume equals the path returned before it, and that the file's text is `kept`. This is Review Focus 2. Delete the folder at the end of the test with `safeDeleteDirectoryWithin`.

- [ ] **Step 3: Add `_scratchDir` and `scratchDir`**

- [ ] **Step 4: Build and run both tests**

Run: `make > $LOGS/make.log 2>&1; echo "exit=$?"`
Run: `pnpm run agency test tests/agency/stdlib/scratch-dir-basic.agency --check-capabilities > $LOGS/t3a.log 2>&1; echo "exit=$?"`
Run: `pnpm run agency test js tests/agency-js/scratch-dir-resume > $LOGS/t3b.log 2>&1; echo "exit=$?"`
Expected: `exit=0` for each. On a failure, read the log. Do not run a test again to see its output.

- [ ] **Step 5: Commit**

Message: `std::fs: scratchDir() returns the run's scratch folder`. The generated page `docs/site/stdlib/fs.md` changes with `make`. Commit it as generated.

---

### Task 4: the rules in the built-in policies

**Files:**
- Modify: `lib/runtime/builtinPolicies.ts`
- Test: `lib/runtime/builtinPolicies.test.ts`

**Interfaces:**
- Consumes: `SCRATCH_PLACEHOLDER` from Task 2.
- Produces: no new export.

- [ ] **Step 1: Write the failing tests**

Each test calls `checkPolicyExplicit` with dirs whose `scratch` is `/tmp/agency-scratch-1000/abc`.

| Policy, launched in | Effect and path | Expected |
|---|---|---|
| `recommended`, `/home/me/proj` | `std::write`, dir `/tmp/agency-scratch-1000/abc` | approve |
| `recommended`, `/home/me/proj` | `std::write`, dir `/tmp` | reject, message `Write temporary files under /tmp/agency-scratch-1000/abc instead.` |
| `recommended`, `/home/me/proj` | `std::write`, dir `/private/tmp/x` | reject, same message |
| `recommended`, `/home/me/proj` | `std::write`, dir `/home/me/proj` | propagate |
| `recommended`, `/tmp/proj` | `std::write`, dir `/tmp/proj/src` | propagate, not reject |
| `recommended`, `/home/me/proj` | `std::read`, dir `/tmp/agency-scratch-1000/abc` | approve |
| `recommended`, `/home/me/proj` | `std::read`, dir `/tmp` | null, so it prompts |
| `recommended`, `/home/me/proj` | `std::grep`, dir `/tmp/agency-scratch-1000/abc/sub` | approve |
| `recommended`, `/home/me/proj` | `std::mkdir`, dir `/tmp/agency-scratch-1000/abc/sub` | approve |
| `recommended`, `/home/me/proj` | `std::remove`, target `/tmp/agency-scratch-1000/abc/x.log` | approve |
| `recommended`, `/home/me/proj` | `std::remove`, target `/tmp/x.log` | null |
| `recommended`, scratch null | `std::write`, dir `/tmp` | reject, message `Write temporary files under <scratch> instead.` |
| `with-writes`, `/tmp/proj` | `std::write`, dir `/tmp/proj/src` | approve |
| `with-writes`, `/home/me/proj` | `std::write`, dir `/tmp/x` | reject |
| `with-writes`, `/home/me/proj` | `std::write`, dir `<agent-home>` resolved, filename `policy.json` | propagate, as today |

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run lib/runtime/builtinPolicies.test.ts > $LOGS/t4.log 2>&1; echo "exit=$?"`
Expected: `exit=1`.

- [ ] **Step 3: Add the rules**

Write three small functions next to `readScopeRules` and use them in both policies:

```ts
/** The scratch folder and everything under it, as a `dir` or `target` pattern. */
const SCRATCH_SCOPE = `{${SCRATCH},${SCRATCH}/**}`;   // SCRATCH is SCRATCH_PLACEHOLDER

function scratchApprove(field: string): PolicyRule[]
function tmpWriteReject(): PolicyRule[]
```

The pattern that results is `{<scratch>,<scratch>/**}`.

`recommended`:

- `readScopeRules()` gains the scratch approve rule, which covers the five read effects.
- `"std::write"`: `scratchApprove("dir")`, then `{ match: { dir: "{.,./**}" }, action: "propagate" }`, then `tmpWriteReject()`.
- `"std::writeBinary"` and `"std::edit"`: `scratchApprove("dir")`.
- `"std::mkdir"`: the existing agent-home rule, then `scratchApprove("dir")`.
- `"std::remove"`: `scratchApprove("target")`.

`with-writes` replaces these effects' rules, so add to each of its lists: after the `ownPolicy…` rules, the scratch approve. For `"std::write"` only, add `tmpWriteReject()` as the last rule, after the launch-folder approve.

Update the `recommended` and `with-writes` descriptions in `BUILTIN_POLICIES` (line 300): `recommended` now approves reads and writes in the run's scratch folder and rejects other writes under `/tmp`.

- [ ] **Step 4: Run the tests, typecheck, format, commit**

Expected: `exit=0`. An existing test that asserts `recommended` has no `std::write` key is now wrong. Change it to assert that `recommended` approves no write outside the scratch folder. Message: `policies: approve the scratch folder, and steer /tmp writes to it`

---

### Task 5: tell the agent

**Files:**
- Modify: `lib/agents/agency-agent/lib/projectContext.agency` (the block built near line 113)
- Modify: `stdlib/agents/skills/coding/gh-pr-and-issues.md` (lines 98, 115), `stdlib/agents/skills/coding/gh-repos-and-releases.md` (line 37)
- Test: `lib/agents/agency-agent/tests/projectContext.agency`

**Interfaces:**
- Consumes: `scratchDir()` from Task 3.
- Produces: nothing other code uses.

- [ ] **Step 1: Add a row to the project context test**

The block now holds a line that starts `Scratch folder for temporary files: ` and whose path contains `/agency-scratch-`. Read the existing test for the block's line "Current working directory" and add the matching check.

- [ ] **Step 2: Add the line to the block**

Directly under `Current working directory: ${dir}`:

```
Scratch folder for temporary files: ${scratch}
```

`scratch` is `scratchDir()`. When it is a failure, leave the line out.

- [ ] **Step 3: Change the two skills**

Replace each `/tmp/<name>` with `<scratch folder>/<name>`, and add one sentence where the first one appears: "The scratch folder is named in your project context." Do not put a literal path in a skill file.

- [ ] **Step 4: Run the agent's project context test**

Agent tests need a throwaway home. Set `HOME` to a scratch folder for the run.

Run: `HOME=$LOGS/home pnpm run agency test lib/agents/agency-agent/tests/projectContext.agency --check-capabilities > $LOGS/t5.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

Message: `agent: name the scratch folder in the project context and the gh skills`

---

### Task 6: dev docs

**Files:**
- Create: `docs/dev/runtime/scratch-dir.md`
- Modify: `docs/dev/agents/approval-policies.md`, `CLAUDE.md` (the package one)

- [ ] **Step 1: Write `docs/dev/runtime/scratch-dir.md`**

Mechanism and rules only, in this order: the example path; how the name is computed and why it is not stored; why the run id is hashed; who shares a folder (a resume, a subprocess, runs with one trace id); how `<scratch>` is resolved inside and outside a run; why there is no setter; why the folder is not deleted; the files and tests. Take the content from the spec and leave out how the design was reached.

- [ ] **Step 2: Update `docs/dev/agents/approval-policies.md`**

1. Rename "Why `recommended` has no `std::write` rule" to "Why `recommended` approves writes only in the scratch folder". Keep its reasons for the agent home. Add the three `std::write` rules, why their order matters, and that the user no longer sees the contents of a file the agent writes to its scratch folder.
2. In the paragraph that lists the placeholders, add `<scratch>` and say it comes from the run id.
3. In "Rule matching", say a reject message has its placeholders filled in.

- [ ] **Step 3: Add the index line to `CLAUDE.md`, under "Runtime"**

```
- `docs/dev/runtime/scratch-dir.md` — A run's scratch folder: how its path comes from the run id, the `<scratch>` policy placeholder, and `scratchDir()`.
```

- [ ] **Step 4: Check and commit**

Run: `pnpm run lint:structure > $LOGS/lint.log 2>&1; echo "exit=$?"`
Expected: `exit=0`. Message: `docs: the scratch folder`

---

## Not in this plan

- Deleting the scratch folder. A paused run must find its files after a resume.
- Setting `TMPDIR` for the shells safeBash starts.
- A host option that chooses the folder's location.
- A reject rule for reads under `/tmp`.
- Changing a user's saved `policy.json`. `/policy` offers the new rules.
