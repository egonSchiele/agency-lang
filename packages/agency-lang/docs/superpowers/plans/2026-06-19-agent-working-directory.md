# Agent Working Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agency agent (and any Agency program) a single, settable, branch-scoped working directory that all path-taking stdlib tools resolve relative paths against, replacing the buggy `Workspace`/`openDir`.

**Architecture:** A private module global `_agentCwd` in `stdlib/system.agency`, exposed via `getAgentCwd()`/`setAgentCwd()` and a resolver helper `applyAgentCwd(dir)`. Every path-taking wrapper in `index.agency`, `shell.agency`, and `fs.agency` runs its directory argument through `applyAgentCwd` as its first statement. When unset (`""`) the helper returns the argument unchanged, so all existing behavior is preserved. The agent calls `setAgentCwd(cwd())` at startup and exposes `getAgentCwd`/`setAgentCwd` as tools.

**Tech Stack:** Agency stdlib (`.agency`), `std::path`, the Agency test runner.

## Global Constraints

- Agency globals are per-run and per-branch isolated automatically; do NOT add runtime/ALS/stack plumbing for the cwd.
- `cwd()` is unchanged — it always returns the OS `process.cwd()`. The agent override is a separate value reached only through `getAgentCwd()`/`setAgentCwd()`.
- `applyAgentCwd` returning `""`-unchanged MUST preserve today's default bases (module-dir for fs reads, `process.cwd()` for shell), so non-agent programs and co-located resource bundles are unaffected.
- After editing any `.agency` stdlib file you MUST run `make` before running agency tests (compiled `.js` is what executes).
- Never use `//` comments between object-literal entries (parser bug; put them above the literal).
- Agency syntax: `def`/`node` with braces; `if (...) { }`; declare with `let`/`const`.

---

### Task 1: Agent-cwd global + accessors in `stdlib/system.agency`

**Files:**
- Modify: `stdlib/system.agency` (add import + global + three functions after `cwd()` at line 65)
- Test: `tests/agency/agent-cwd.agency`, `tests/agency/agent-cwd.test.json`

**Interfaces:**
- Produces:
  - `getAgentCwd(): string` — the override, `""` when unset.
  - `setAgentCwd(dir: string)` — set the override.
  - `applyAgentCwd(dir: string): string` — `getAgentCwd()` set ? `resolve(getAgentCwd(), dir)` : `dir`.

- [ ] **Step 1: Write the failing test**

Create `tests/agency/agent-cwd.agency`:

```ts
import { getAgentCwd, setAgentCwd, applyAgentCwd } from "std::system"

node defaultsToEmpty(): boolean {
  return getAgentCwd() == ""
}

node setThenGet(): boolean {
  setAgentCwd("/abs/dir")
  return getAgentCwd() == "/abs/dir"
}

node applyJoinsRelative(): boolean {
  setAgentCwd("/abs/dir")
  return applyAgentCwd("foo") == "/abs/dir/foo"
}

node applyKeepsAbsolute(): boolean {
  setAgentCwd("/abs/dir")
  return applyAgentCwd("/other") == "/other"
}

node applyEmptyReturnsBase(): boolean {
  setAgentCwd("/abs/dir")
  return applyAgentCwd("") == "/abs/dir"
}

node applyUnsetPassesThrough(): boolean {
  return applyAgentCwd("foo") == "foo"
}
```

Create `tests/agency/agent-cwd.test.json`:

```json
{
  "tests": [
    { "nodeName": "defaultsToEmpty", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "setThenGet", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "applyJoinsRelative", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "applyKeepsAbsolute", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "applyEmptyReturnsBase", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "applyUnsetPassesThrough", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node ./dist/scripts/agency.js test tests/agency/agent-cwd.agency`
Expected: FAIL — compile/parse error or unresolved import (`getAgentCwd`/`setAgentCwd`/`applyAgentCwd` not exported from `std::system`).

- [ ] **Step 3: Add the `std::path` import to `system.agency`**

In `stdlib/system.agency`, after the existing import block (ends line 13 with `} from "agency-lang/stdlib-lib/system.js"`), add:

```ts
import { resolve } from "std::path"
```

- [ ] **Step 4: Add the global + three functions**

In `stdlib/system.agency`, immediately after the `cwd()` function (after its closing `}` at line 65), add:

```ts
// The agent's working directory: a branch-scoped override that
// path-taking stdlib tools resolve relative paths against. Empty string
// means "unset" — tools keep their default base. Distinct from `cwd()`
// (the OS process cwd) on purpose: an agent sets this to point the file
// and shell tools at the user's directory without changing the process.
let _agentCwd = ""

export safe def setAgentCwd(dir: string) {
  """
  Set the agent working directory. Path-taking tools (read, write, edit,
  ls, glob, grep, exec, bash, ...) resolve relative paths against it.
  Pass an absolute path. Branch-scoped: a fork/race/parallel branch can
  change it without affecting the parent.

  @param dir - Absolute directory to use as the agent working directory.
  """
  _agentCwd = dir
}

export safe def getAgentCwd(): string {
  """
  Return the agent working directory, or an empty string when none is
  set. See setAgentCwd.
  """
  return _agentCwd
}

export safe def applyAgentCwd(dir: string): string {
  """
  Resolve `dir` against the agent working directory when one is set;
  otherwise return `dir` unchanged. Used by the path-taking stdlib
  wrappers so a set agent cwd overrides their default base. `resolve`
  short-circuits on an absolute `dir`, and resolve(base, "") returns
  base, so this works for both the fs default (".") and shell default ("").

  @param dir - The directory argument to resolve.
  """
  const base = getAgentCwd()
  if (base == "") {
    return dir
  }
  return resolve(base, dir)
}
```

- [ ] **Step 5: Rebuild stdlib**

Run: `make`
Expected: exit 0 (stdlib recompiles, including `system.agency → system.js`).

- [ ] **Step 6: Run the test to verify it passes**

Run: `node ./dist/scripts/agency.js test tests/agency/agent-cwd.agency`
Expected: PASS — 6/6 tests pass.

- [ ] **Step 7: Commit**

```bash
git add stdlib/system.agency stdlib/system.js tests/agency/agent-cwd.agency tests/agency/agent-cwd.test.json
git commit -m "feat(stdlib): add agent working directory (getAgentCwd/setAgentCwd/applyAgentCwd)"
```

---

### Task 2: Honor agent cwd in `index.agency` + `shell.agency` wrappers

**Files:**
- Modify: `stdlib/index.agency` — `read` (line 97), `write` (line 121), `readImage` (line 149)
- Modify: `stdlib/shell.agency` — `exec` (line 18), `bash` (line 72), `ls` (line 116), `grep` (line 147), `glob` (line 177), `stat` (line 207), `exists` (line 224)
- Create fixtures: `tests/agency/cwd-probe.txt`, `tests/agency/cwd-fixture-a/cwd-probe.txt`
- Test: extend `tests/agency/agent-cwd.agency` / `.test.json`

**Interfaces:**
- Consumes: `applyAgentCwd` from `std::system` (Task 1); `isAbsolute` from `std::path`.
- Produces: no new signatures — same wrappers, now cwd-aware.

**Absolute-path rule (applies to every wrapper):** the agent cwd only
redirects **relative** paths. Absolute paths must pass through unchanged.
For the `dir`/`cwd`-argument functions this is automatic — `applyAgentCwd`
calls `resolve(base, dir)`, which returns an absolute `dir` untouched. The
one exception is `exists`/`stat`, whose absolute path is the `filename`
argument (not `dir`): they must only apply `applyAgentCwd` to `dir` when
`filename` is **relative**, so an absolute `filename` keeps working when a
cwd is set (see Step 4).

- [ ] **Step 1: Write the failing tests + fixtures**

Create `tests/agency/cwd-probe.txt` (co-located with the test module) with exactly:

```
from module
```

Create `tests/agency/cwd-fixture-a/cwd-probe.txt` with exactly:

```
from A
```

Append to `tests/agency/agent-cwd.agency`:

```ts
import { read } from "std::index"
import { bash, exists } from "std::shell"
import { cwd } from "std::system"
import { join } from "std::path"

// Gap 5 — with NO agent cwd set, a relative read resolves against the
// test's own module directory (tests/agency/), reading "from module".
node unsetReadsModuleDir(): boolean {
  const r = read("cwd-probe.txt") with approve
  return r is success(v) && v.trim() == "from module"
}

// Two same-named files in different dirs prove the read SWITCHES based on
// the agent cwd. With cwd = fixture-a, the SAME relative name now reads
// "from A" instead of the module dir's "from module".
node setRedirectsRead(): boolean {
  setAgentCwd(join(cwd(), "tests/agency/cwd-fixture-a"))
  const r = read("cwd-probe.txt") with approve
  return r is success(v) && v.trim() == "from A"
}

// Gap 1 — the shell path (`bash`, whose dir arg is `cwd`, not `dir`) also
// honors the agent cwd. `pwd` prints the directory the command ran in.
node bashRunsInAgentCwd(): boolean {
  setAgentCwd(join(cwd(), "tests/agency/cwd-fixture-a"))
  const r = bash("pwd") with approve
  return r.stdout.trim().endsWith("cwd-fixture-a")
}

// #7 — an ABSOLUTE filename bypasses the agent cwd entirely. Even with the
// cwd pointed at a nonexistent dir, an absolute path to a real file is
// honored.
node existsAbsoluteBypassesAgentCwd(): boolean {
  setAgentCwd("/this/does/not/exist")
  return exists(join(cwd(), "tests/agency/cwd-probe.txt"))
}

// Gap 3 — branch isolation, both directions: the branch INHERITS the
// parent's cwd at fork, sees its OWN write, and the parent is UNAFFECTED
// by the branch's write.
node branchInheritsAndIsolates(): boolean {
  setAgentCwd("/parent")
  const results = fork(["x"]) as item {
    const before = getAgentCwd()
    setAgentCwd("/branch")
    const after = getAgentCwd()
    return "${before}|${after}"
  }
  const parentAfter = getAgentCwd()
  return results[0] == "/parent|/branch" && parentAfter == "/parent"
}
```

Add to `tests/agency/agent-cwd.test.json` `tests` array:

```json
    { "nodeName": "unsetReadsModuleDir", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "setRedirectsRead", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "bashRunsInAgentCwd", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "existsAbsoluteBypassesAgentCwd", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "branchInheritsAndIsolates", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run to verify the new tests fail appropriately**

Run: `node ./dist/scripts/agency.js test tests/agency/agent-cwd.agency`
Expected:
- `unsetReadsModuleDir` PASSES already (unset behavior is unchanged — this is the gap-5 regression guard).
- `setRedirectsRead` FAILS (read still resolves against the module dir, so it reads "from module", not "from A").
- `bashRunsInAgentCwd` FAILS (bash still runs in `process.cwd()`).
- `existsAbsoluteBypassesAgentCwd` PASSES already (exists not yet wired, so it ignores the cwd — this case must STAY passing after Step 4, which is the point of the guard).
- `branchInheritsAndIsolates` PASSES already (globals are branch-scoped).

- [ ] **Step 3: Wire `applyAgentCwd` into `index.agency`**

`index.agency` does not currently import `std::system`, so add this import near the top of `stdlib/index.agency`:

```ts
import { applyAgentCwd } from "std::system"
```

In `read` (line 97), make the first statement after the docstring:

```ts
  dir = applyAgentCwd(dir)
```

so it reads:

```ts
  @param limit - Maximum number of lines to return (0 means read to end of file)
  """
  dir = applyAgentCwd(dir)
  return interrupt std::read("Are you sure you want to read this file?", {
```

In `write` (line 121), add the same first statement after its docstring:

```ts
  dir = applyAgentCwd(dir)
  return interrupt std::write("Are you sure you want to write to this file?", {
```

In `readImage` (line 149), add after its docstring:

```ts
  dir = applyAgentCwd(dir)
  return interrupt std::readImage("Are you sure you want to read this image file?", {
```

- [ ] **Step 4: Wire `applyAgentCwd` into `shell.agency`**

Add this import near the top of `stdlib/shell.agency`:
```ts
import { applyAgentCwd } from "std::system"
import { isAbsolute } from "std::path"
```

For `exec`/`bash`/`ls`/`grep`/`glob`, insert the resolve as the first statement after the docstring. For `exec` and `bash` the directory arg is named `cwd`; for the rest it is `dir`:

`exec` (line 18) — after its docstring:
```ts
  cwd = applyAgentCwd(cwd)
```
`bash` (line 72) — after its docstring:
```ts
  cwd = applyAgentCwd(cwd)
```
`ls` (line 116) — after its docstring:
```ts
  dir = applyAgentCwd(dir)
```
`grep` (line 147) — after its docstring:
```ts
  dir = applyAgentCwd(dir)
```
`glob` (line 177) — after its docstring:
```ts
  dir = applyAgentCwd(dir)
```

`stat` (line 207) and `exists` (line 224) take their path as `filename`
with `dir` defaulting to `""` (which accepts an absolute `filename`). To
preserve that, only redirect when `filename` is **relative** — after each
docstring:
```ts
  if (!isAbsolute(filename)) {
    dir = applyAgentCwd(dir)
  }
```

(`which` takes no directory and is left unchanged. `read`/`write`/
`edit`/`readImage` need no `isAbsolute` guard: they already reject an
absolute `filename` via `resolvePath`, and `applyAgentCwd` preserves an
absolute `dir`, so their absolute behavior is unchanged.)

- [ ] **Step 5: Rebuild stdlib**

Run: `make`
Expected: exit 0.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node ./dist/scripts/agency.js test tests/agency/agent-cwd.agency`
Expected: PASS — all nodes pass. In particular `setRedirectsRead` and
`bashRunsInAgentCwd` now pass (wiring works), while `unsetReadsModuleDir`
and `existsAbsoluteBypassesAgentCwd` STILL pass (unset and absolute-path
behavior preserved).

- [ ] **Step 7: Run the broader fs/shell agency tests for regressions**

Run: `node ./dist/scripts/agency.js test tests/agency/skills-dir.agency`
Expected: PASS (co-located resource resolution unchanged with agent cwd unset).

- [ ] **Step 8: Commit**

```bash
git add stdlib/index.agency stdlib/index.js stdlib/shell.agency stdlib/shell.js tests/agency/agent-cwd.agency tests/agency/agent-cwd.test.json tests/agency/cwd-probe.txt tests/agency/cwd-fixture-a/cwd-probe.txt
git commit -m "feat(stdlib): index/shell path tools honor the agent working directory"
```

---

### Task 3: Honor agent cwd in `fs.agency` + delete `openDir`/`Workspace`

**Files:**
- Modify: `stdlib/fs.agency` — `edit` (line 16), `mkdir` (line 59), `copy` (line 73), `move` (line 89), `remove` (line 105); delete `Workspace` type (lines 129-143) and `openDir` (lines 145-203)
- Test: reuse `tests/agency/agent-cwd.agency`

**Interfaces:**
- Consumes: `applyAgentCwd` from `std::system`.
- Produces: removes `openDir` / `Workspace` from the public `std::fs` surface.

- [ ] **Step 1: Add a failing test for fs resolution**

Append to `tests/agency/agent-cwd.agency`:

```ts
import { edit } from "std::fs"

node editResolvesRelativeToAgentCwd(): boolean {
  // Create a scratch file under the process cwd, point the agent cwd
  // there, edit it by relative name, then read it back and clean up.
  const base = cwd()
  setAgentCwd(base)
  const w = write("__cwd_edit__.txt", "alpha") with approve
  const e = edit("__cwd_edit__.txt", [{ oldText: "alpha", newText: "beta", replaceAll: false }]) with approve
  const r = read("__cwd_edit__.txt") with approve
  remove("__cwd_edit__.txt") with approve
  if (r is success(v)) {
    return v.trim() == "beta"
  }
  return false
}
```

Add `remove` to the `std::fs` import in the test (`import { edit, remove } from "std::fs"`) and add `write` to the existing `std::index` import (`import { read, write } from "std::index"`). Then add to `tests/agency/agent-cwd.test.json`:

```json
    { "nodeName": "editResolvesRelativeToAgentCwd", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node ./dist/scripts/agency.js test tests/agency/agent-cwd.agency`
Expected: `editResolvesRelativeToAgentCwd` FAILS (edit resolves `dir="."` against the module dir, not the agent cwd, so it can't find the file written under the agent cwd).

- [ ] **Step 3: Wire `applyAgentCwd` into `fs.agency`**

Add `import { applyAgentCwd } from "std::system"` near the top of `stdlib/fs.agency`.

`edit` (line 16) — first statement after its docstring:
```ts
  dir = applyAgentCwd(dir)
```
`mkdir` (line 59) — after its docstring:
```ts
  dir = applyAgentCwd(dir)
```
`remove` (line 105) — after its docstring (its arg is `target`):
```ts
  target = applyAgentCwd(target)
```
`copy` (line 73) — after its docstring (two args):
```ts
  src = applyAgentCwd(src)
  dest = applyAgentCwd(dest)
```
`move` (line 89) — after its docstring (two args):
```ts
  src = applyAgentCwd(src)
  dest = applyAgentCwd(dest)
```

- [ ] **Step 4: Delete `Workspace` and `openDir`**

In `stdlib/fs.agency`, delete the `Workspace` type definition (the `export type Workspace = { ... }` block, lines 129-143) and the entire `export def openDir(...)` function (lines 145-203), plus the doc comment block immediately above `Workspace` that describes the bundle (the `/** ... */` ending at line 128). Leave the rest of the file intact.

- [ ] **Step 5: Rebuild stdlib**

Run: `make`
Expected: exit 0 (no remaining references to `openDir`/`Workspace` inside stdlib).

- [ ] **Step 6: Run the test to verify it passes**

Run: `node ./dist/scripts/agency.js test tests/agency/agent-cwd.agency`
Expected: PASS — all nodes, including `editResolvesRelativeToAgentCwd`.

- [ ] **Step 7: Confirm no stray references**

Run: `grep -rn "openDir\|Workspace" stdlib/ lib/ --include=*.agency`
Expected: matches ONLY in `lib/agents/agency-agent/subagents/{code,oracle,explorer}.agency` (fixed in Task 4). No matches in `stdlib/`.

- [ ] **Step 8: Commit**

```bash
git add stdlib/fs.agency stdlib/fs.js tests/agency/agent-cwd.agency tests/agency/agent-cwd.test.json
git commit -m "feat(stdlib): fs path tools honor agent cwd; remove openDir/Workspace"
```

---

### Task 4: Switch the agency agent to the agent-cwd model

**Files:**
- Modify: `lib/agents/agency-agent/agent.agency` — call `setAgentCwd(cwd())` in `setupSession`
- Modify: `lib/agents/agency-agent/subagents/code.agency` — drop `workspace`, use raw tools, replace `setCwd` shim with `getAgentCwd`/`setAgentCwd` tools
- Modify: `lib/agents/agency-agent/subagents/oracle.agency` — drop `workspace`, use raw read tools
- Modify: `lib/agents/agency-agent/subagents/explorer.agency` — drop `workspace`, use raw read tools
- Test: `lib/agents/agency-agent/tests/toolWiring.agency` (already exists) still passes

**Interfaces:**
- Consumes: `getAgentCwd`/`setAgentCwd` from `std::system`; raw `read`/`write`/`edit` from `std::index`; `ls`/`glob`/`grep`/`bash` from `std::shell`.

- [ ] **Step 1: Point the agent at the user's cwd at startup**

In `lib/agents/agency-agent/agent.agency`, add `setAgentCwd` and `cwd` to the relevant `std::system` import (the file already imports `cwd, env, isTTY, readStdin, setTitle` from `std::system` — add `setAgentCwd`).

In `setupSession`, as the first line of the function body (before the existing `const projectContext = ...`), add:

```ts
  setAgentCwd(cwd())
```

- [ ] **Step 2: Rewrite `code.agency` tool set**

In `lib/agents/agency-agent/subagents/code.agency`:

Replace the imports for fs tools. Add:
```ts
import { read, write } from "std::index"
import { ls, glob, grep, bash } from "std::shell"
import { edit } from "std::fs"
import { getAgentCwd, setAgentCwd } from "std::system"
```
Remove `import { Workspace, openDir } from "std::fs"` and the `static const workspace: Workspace = openDir(cwd())` line.

Delete the `setCwd` shim function (the `export def setCwd(dir: string): string { ... }`). Replace its tool slot with the real `setAgentCwd`/`getAgentCwd`.

In `codeTools`, replace the `workspace.*` members and `setCwd` with the raw tools:
```ts
export static const codeTools: any[] = [
  setAgentCwd,
  getAgentCwd,
  read,
  write,
  edit,
  ls,
  glob,
  grep,
  bash,
  agencyCli,
  typecheck,
  parseAST,
  highlight.partial(language: "ts"),
  print,
  remember,
  recall,
  superpowersSkill,
  docSkill,
  cliSkill,
  appendixSkill,
  todoWrite,
  todoList,
  oracleAgent.partial(allowHandoff: false),
]
```

In the `codeSysPrompt` text, replace Workflow step 1, which currently reads:

```
1. Call `setCwd` with the user's project directory first. After
   that, every file-system tool resolves filenames against that
   directory and its subtree.
```

with:

```
1. You already start in the user's working directory, so relative
   paths just work. Only if the user asks you to work in a different
   directory, call `setAgentCwd` with that directory; every
   file-system and shell tool then resolves relative paths against it.
   Use `getAgentCwd` to check the current working directory.
```

Also update the two header comments in the file that mention `setCwd` re-anchoring "the bundle" (around lines 11 and 33) — delete those sentences, since there is no bundle anymore.

- [ ] **Step 3: Rewrite `oracle.agency` and `explorer.agency` tool sets**

In each of `lib/agents/agency-agent/subagents/oracle.agency` and `explorer.agency`:

Remove `import { Workspace, openDir } from "std::fs"` and `static const workspace: Workspace = openDir(cwd())`. Add:
```ts
import { read } from "std::index"
import { ls, glob, grep } from "std::shell"
```
Replace `workspace.read`, `workspace.ls`, `workspace.glob`, `workspace.grep` in their `oracleTools` / `explorerTools` arrays with `read`, `ls`, `glob`, `grep`. (If `cwd` is no longer used in the file after removing the `openDir(cwd())` call, drop the now-unused `cwd` import.)

- [ ] **Step 4: Rebuild**

Run: `make`
Expected: exit 0 (agents recompile; no `openDir`/`Workspace` references remain).

- [ ] **Step 5: Run the agent smoke tests**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run test:agents`
Expected: PASS — `toolWiring` (tool lists still have unique names: `read`, `write`, `edit`, `ls`, `glob`, `grep`, `bash`, `agencyCli`, `typecheck`, `parseAST`, `setAgentCwd`, `getAgentCwd`, ...), `agentTurn`, `execPolicy` all green.

- [ ] **Step 6: Confirm no stray references anywhere**

Run: `grep -rn "openDir\|Workspace\|\.partial(dir" lib/ stdlib/ --include=*.agency`
Expected: no matches.

- [ ] **Step 7: Run the full unit suite + lint**

Run: `pnpm test:run` then `pnpm run lint:structure`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add lib/agents/agency-agent/agent.agency lib/agents/agency-agent/subagents/code.agency lib/agents/agency-agent/subagents/oracle.agency lib/agents/agency-agent/subagents/explorer.agency
git commit -m "feat(agent): use agent working directory; drop Workspace"
```

---

## Notes for the implementer

- **Param reassignment:** `dir = applyAgentCwd(dir)` reassigns a function parameter. That is allowed in Agency (parameters are mutable bindings). It runs before the `interrupt` line, so on interrupt-resume it simply recomputes (the helper is pure) — safe.
- **Why no TS change:** `applyAgentCwd` returns an absolute path when the override is set, and the TS `resolveDir`/`resolvePath` already treat an absolute `dir` as authoritative (bypassing the module-dir / `process.cwd()` choice). When unset it returns the argument unchanged, preserving every existing default.
- **Absolute paths always bypass the agent cwd; only relative paths are redirected.** For `dir`/`cwd`-arg functions this is automatic (`applyAgentCwd` → `resolve(base, dir)` returns an absolute `dir` unchanged). `exists`/`stat` are the only functions whose absolute path lives in `filename`, so they guard with `if (!isAbsolute(filename))` to keep accepting absolute filenames when a cwd is set. `read`/`write`/`edit`/`readImage` already reject absolute filenames (pre-existing sandboxing) and that is unchanged.
- **applyPatch** is intentionally left unchanged (its paths live inside the patch text, not a `dir` argument).
