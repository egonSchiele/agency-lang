# Fix #513: Block References Must Survive Cross-Process Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the main session (owner preference: no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a paused subprocess resume correctly when a `guard(...) as { }` block (or any block-taking function) sits on its serialized stack, per the approved spec `docs/superpowers/specs/2026-07-14-issue-513-block-ref-revive-fix-design.md`.

**Architecture:** One runtime change (FunctionRefReviver returns a lazy-throwing stub for unregistered `__block_<n>` refs instead of dying at restore), locked in by two subprocess regression fixtures, followed by the `run()` single-call-site cleanup this bug was blocking, and a bounded probe of the scoped-callbacks sibling case.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), Agency stdlib (`stdlib/agency.agency`), vitest unit tests, Agency execution fixtures (`tests/agency/subprocess/`).

## Global Constraints

- Work in a fresh worktree + branch (`fix/513-block-ref-revive`) created via superpowers:using-git-worktrees BEFORE the first commit. Never commit to main. Re-check `git branch --show-current` before every commit.
- Run `make` after changing any `stdlib/*.agency` file, and after any `lib/` change that fixtures exercise (fixtures run against `dist/`).
- Save all test output to files (`tee /tmp/...`). Never rerun a test just to re-read its failure.
- Do NOT run the full agency test suite locally. Run only the fixtures named in this plan. CI runs the rest on the PR.
- Write commit messages and the PR body to files and pass them with `-F` (apostrophes break inline `-m`).
- The disable value for a guard dimension is a NEGATIVE number. `guard(cost: null, time: null)` throws. Never write `guard(cost: null)` meaning "no cap".
- Agency has NO ternary (`? :`). Use `if ... then ... else` expressions or `if` statements (`docs/site/guide/basic-syntax.md:68`).
- End commit messages with a Co-Authored-By line naming the EXECUTING session's model. For this session: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (adjust if a different model executes).

---

### Task 1: Regression fixtures that fail today

Two fixtures from the verified repros. They fail on the current code and define done for Task 2. Working repro copies (with debug prints to strip) exist in `packages/agency-lang/tmp/guard-nested-repro*.agency`; the fixtures below are the clean versions.

**Files:**
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-maxcost.agency`
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-maxcost.test.json`
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-user-guard.agency`
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-user-guard.test.json`
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-user-wrapper.agency`
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-user-wrapper.test.json`
- Commit also: `docs/superpowers/specs/2026-07-14-issue-513-block-ref-revive-fix-design.md` (currently untracked; this branch's paper trail)

**Interfaces:**
- Consumes: nothing.
- Produces: the three fixture paths above. Task 2 runs them and expects PASS; Task 3 re-runs them.

- [ ] **Step 1: Write the maxCost fixture**

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-maxcost.agency`:

```
import { compile, run } from "std::agency"

// #513 regression: the middle hop's run() uses maxCost, which wraps _run in
// a guard block INSIDE run(). The grandchild's bash is unhandled anywhere, so
// the middle process pauses and serializes WHILE the guard block's frame
// (holding a FunctionRef to the block) is on its stack. Resume must revive
// that state in a fresh process: before the fix, FunctionRefReviver threw on
// the unregistered "__block_<n>" ref and the resume died.
node main() {
  const grandSource = """
import { bash } from "std::shell"
node main() {
  let r = bash("echo deep-ok")
  return r.stdout
}
"""
  const childSource = """
import { compile, run } from "std::agency"
node main(grandSource: string) {
  const c = compile(grandSource)
  if (isFailure(c)) {
    return "inner compile failed"
  }
  handle {
    const result = run(compiled: c.value, node: "main", maxCost: 1.0)
    if (isSuccess(result)) {
      return result.value.data
    }
    return "inner run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
"""
  const compileResult = compile(childSource)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(
      compiled: compileResult.value,
      node: "main",
      args: { grandSource: grandSource },
    )
    if (isSuccess(result)) {
      return "OK: ${result.value.data}"
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-maxcost.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "#513: run(maxCost:) on the middle hop; grandchild interrupt pauses the tree; one approval resumes through the internal guard block",
      "input": "",
      "expectedOutput": "\"OK: deep-ok\\n\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

- [ ] **Step 2: Write the user-guard fixture**

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-user-guard.agency`. Same shape; the middle hop wraps a plain `run()` in a user-level guard block, proving the fix covers the whole pattern, not just `run()`'s internal guard:

```
import { compile, run } from "std::agency"

// #513 regression, user-level variant: a hand-written guard(...) as { } wraps
// the middle hop's run(). The serialized middle stack holds the user block's
// FunctionRef. This is the case that proves ANY block-taking function is
// pause-safe across process boundaries, not just run(maxCost:).
node main() {
  const grandSource = """
import { bash } from "std::shell"
node main() {
  let r = bash("echo deep-ok")
  return r.stdout
}
"""
  const childSource = """
import { compile, run } from "std::agency"
import { guard } from "std::thread"
node main(grandSource: string) {
  const c = compile(grandSource)
  if (isFailure(c)) {
    return "inner compile failed"
  }
  handle {
    const guarded = guard(cost: 1.0) as {
      const result = run(compiled: c.value, node: "main")
      if (isSuccess(result)) {
        return result.value.data
      }
      return "inner run failed"
    }
    if (isSuccess(guarded)) {
      return guarded.value
    }
    return "guard tripped"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
"""
  const compileResult = compile(childSource)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(
      compiled: compileResult.value,
      node: "main",
      args: { grandSource: grandSource },
    )
    if (isSuccess(result)) {
      return "OK: ${result.value.data}"
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-user-guard.test.json` — identical to Step 1's json except `nodeName`/`description`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "#513: user-level guard(cost:) as { } around the middle hop's run(); one approval resumes through the user block",
      "input": "",
      "expectedOutput": "\"OK: deep-ok\\n\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

- [ ] **Step 3: Write the user-wrapper fixture**

The spec's stated goal is that USERLAND block-taking functions are pause-safe, not just stdlib `guard`. This fixture is the direct evidence: a user-defined `def` with a block parameter wraps the pausing `run()`.

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-user-wrapper.agency`:

```
import { compile, run } from "std::agency"

// #513 regression, userland variant: a USER-DEFINED function with a block
// parameter wraps the middle hop's run(). Its frame serializes a FunctionRef
// to the anonymous block, exactly like guard()'s does. This pins the spec's
// goal that guard-like constructs are buildable in userland with no runtime
// changes and stay pause-safe across process boundaries.
node main() {
  const grandSource = """
import { bash } from "std::shell"
node main() {
  let r = bash("echo deep-ok")
  return r.stdout
}
"""
  const childSource = """
import { compile, run } from "std::agency"

def withWrapper(block: () -> any = null): any {
  const result = block()
  return result
}

node main(grandSource: string) {
  const c = compile(grandSource)
  if (isFailure(c)) {
    return "inner compile failed"
  }
  handle {
    const wrapped = withWrapper() as {
      const result = run(compiled: c.value, node: "main")
      if (isSuccess(result)) {
        return result.value.data
      }
      return "inner run failed"
    }
    return wrapped
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
"""
  const compileResult = compile(childSource)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(
      compiled: compileResult.value,
      node: "main",
      args: { grandSource: grandSource },
    )
    if (isSuccess(result)) {
      return "OK: ${result.value.data}"
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-user-wrapper.test.json` — same shape as Step 1's json with:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "#513: a user-defined block-taking function wraps the middle hop's run(); one approval resumes through the user block",
      "input": "",
      "expectedOutput": "\"OK: deep-ok\\n\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

- [ ] **Step 4: Run all three fixtures to verify they FAIL today**

From `packages/agency-lang/`:

```bash
pnpm run agency test tests/agency/subprocess/nested-pause-maxcost.agency 2>&1 | tee /tmp/513-t1-maxcost.log
pnpm run agency test tests/agency/subprocess/nested-pause-user-guard.agency 2>&1 | tee /tmp/513-t1-userguard.log
pnpm run agency test tests/agency/subprocess/nested-pause-user-wrapper.agency 2>&1 | tee /tmp/513-t1-userwrapper.log
```

Expected: ALL THREE FAIL with the harness error `Expected 1 interrupts but only 0 occurred` (verified 2026-07-14 for the first two: the reviver throw kills the middle process before the bash interrupt ever surfaces to the harness). If a failure looks different, read the log; do not proceed until the failure is understood.

- [ ] **Step 5: Commit (spec + failing fixtures)**

Write `/tmp/513-commit-1.txt`:

```
Add failing #513 regression fixtures + design spec

All three fixtures pause a nested subprocess while a block-holding frame
is on its serialized stack (run(maxCost:), user guard, user-defined
wrapper). They fail today because FunctionRefReviver throws on the
unregistered block ref at restore. The spec documents the verified root
cause and the fix design.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

```bash
git branch --show-current   # must be fix/513-block-ref-revive
git add docs/superpowers/specs/2026-07-14-issue-513-block-ref-revive-fix-design.md packages/agency-lang/tests/agency/subprocess/nested-pause-maxcost.* packages/agency-lang/tests/agency/subprocess/nested-pause-user-guard.* packages/agency-lang/tests/agency/subprocess/nested-pause-user-wrapper.*
git commit -F /tmp/513-commit-1.txt
```

---

### Task 2: Reviver lazy stub

**Files:**
- Create: `packages/agency-lang/lib/runtime/blockNames.ts`
- Modify: `packages/agency-lang/lib/runtime/revivers/functionRefReviver.ts:94-114` (`findInRegistry`)
- Modify: `packages/agency-lang/lib/backends/typescriptBuilder/stepPathTracker.ts:89-91` (`nextBlockName`)
- Test: `packages/agency-lang/lib/runtime/revivers/functionRefReviver.test.ts`

**Interfaces:**
- Consumes: `AgencyFunction` constructor `new AgencyFunction({ name, module, fn, params, toolDefinition })` (`lib/runtime/agencyFunction.ts`).
- Produces: `makeBlockName(counter: number): string` and `isBlockName(name: string): boolean` in `lib/runtime/blockNames.ts` — the single source of truth for the `__block_<n>` naming scheme, used by BOTH the backend (minting) and the reviver (recognizing). `findInRegistry` returns a stub `AgencyFunction` for unregistered block names and throws the existing error for all other misses. Task 1's fixtures and Task 3 depend on this behavior.

**Context — the naming scheme is a de-facto reserved prefix, not a compiler-enforced one.** Verified 2026-07-14: `def __block_0(): string { ... }` typechecks CLEAN. The reserved-name diagnostics cover only specific identifiers (`success`, `failure`, `Result` — `lib/symbolTable.ts:431`), not the `__` prefix. This is accepted: a collision needs a user to name a function `__block_<n>` AND have it hit a registry miss (renamed/removed between pause and resume), and the failure mode is a soft stub rather than a hard throw. Do NOT add a serialize-time `isBlock` field — it would reuse the same regex in a different place and add zero robustness. If real hardening is ever wanted, that is a separate issue: a creation-time block flag on `AgencyFunction` plus a reserved-prefix diagnostic.

- [ ] **Step 1: Create the shared block-name module**

The `__block_<n>` convention is minted in exactly one place today (`stepPathTracker.nextBlockName`). The reviver must not re-encode that convention privately — one source of truth for both sides. Direction matters: runtime must not import from `lib/backends/`, but backends already imports from runtime (`typescriptBuilder.ts:82` imports `moduleIdToOrigin` from `runtime/origin.js`). So the module lives in runtime.

Create `packages/agency-lang/lib/runtime/blockNames.ts`:

```ts
/** Single source of truth for the compiler's anonymous-block naming scheme.
 *  The backend MINTS names via makeBlockName (stepPathTracker.nextBlockName);
 *  the runtime RECOGNIZES them via isBlockName (FunctionRefReviver's stub
 *  decision for unregistered refs). Keeping both here means the two
 *  subsystems cannot silently desync.
 *
 *  "__block_" is a de-facto reserved prefix: no diagnostic rejects a user
 *  function with such a name today, but misclassification requires a
 *  registry miss too, and the failure mode is a soft lazy-throwing stub. */
export function makeBlockName(counter: number): string {
  return `__block_${counter}`;
}

export function isBlockName(name: string): boolean {
  return /^__block_\d+$/.test(name);
}
```

In `lib/backends/typescriptBuilder/stepPathTracker.ts`, change `nextBlockName` (lines 89-91) to mint through the shared function:

```ts
  nextBlockName(): string {
    return makeBlockName(this.blockCounter++);
  }
```

and add the import at the top of the file:

```ts
import { makeBlockName } from "@/runtime/blockNames.js";
```

- [ ] **Step 2: Write the failing unit tests**

In `lib/runtime/revivers/functionRefReviver.test.ts`, inside `describe("revive")`, after the `"throws when function is not found"` test (which stays — non-block names keep the eager throw), add:

```ts
    it("revives an unregistered block ref to a stub instead of throwing", () => {
      reviver.registry = {};
      const stub = reviver.revive({
        name: "__block_0",
        module: "stdlib/agency.agency",
      });
      expect(AgencyFunction.isAgencyFunction(stub)).toBe(true);
      expect(stub.name).toBe("__block_0");
      expect(stub.module).toBe("stdlib/agency.agency");
    });

    it("the block stub is a tripwire: invoking it surfaces a rebind error", async () => {
      reviver.registry = {};
      const stub = reviver.revive({
        name: "__block_7",
        module: "test.agency",
      });
      // invoke() may reject or convert the throw to a failure Result
      // depending on failure-propagation settings; accept either, but the
      // tripwire message must surface.
      const outcome = await stub
        .invoke({ type: "positional", args: [] })
        .then((v: unknown) => v, (e: unknown) => e);
      const msg =
        outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
      expect(msg).toContain("before replay rebound it");
    });

    it("non-block names still throw eagerly on a registry miss", () => {
      reviver.registry = {};
      expect(() =>
        reviver.revive({ name: "__blockish", module: "test.agency" }),
      ).toThrow("not found in registry");
      expect(() =>
        reviver.revive({ name: "__block_", module: "test.agency" }),
      ).toThrow("not found in registry");
    });

    it("a REGISTERED block name resolves to the real function, not a stub", async () => {
      // Pins the lookup-before-regex ordering: moving the block check ahead
      // of the registry lookup would silently stub every registered block.
      const real = makeAgencyFunction("__block_0", "test.agency");
      reviver.registry = { "test.agency:__block_0": real };
      const result = reviver.revive({
        name: "__block_0",
        module: "test.agency",
      });
      expect(result).toBe(real);
    });
```

- [ ] **Step 3: Run the unit tests to verify they fail**

```bash
pnpm test:run lib/runtime/revivers/functionRefReviver.test.ts 2>&1 | tee /tmp/513-t2-unit.log
```

Expected: the two new block-stub tests FAIL (`revive` throws "not found in registry"); everything else PASSES.

- [ ] **Step 4: Implement the stub**

In `lib/runtime/revivers/functionRefReviver.ts`, add the import at the top:

```ts
import { isBlockName } from "../blockNames.js";
```

Replace the throw at the bottom of `findInRegistry` (lines 110-113) with:

```ts
    // Compiler-generated blocks register themselves only when their creating
    // line executes. A fresh process restoring a checkpoint has executed
    // nothing yet, so a miss here is EXPECTED for blocks — replay rebinds
    // block args at function entry before anything can call them (#513).
    if (isBlockName(name)) {
      return makeBlockStub(name, module);
    }
    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
```

and add the stub factory as a module-level function at the bottom of the file (below the class):

```ts
/** A lazy tripwire for an unregistered block reference: a real
 *  AgencyFunction (so restore succeeds and the frame slot is filled) whose
 *  body throws a precise error IF anything invokes it. In every correct
 *  replay the generated def body overwrites the slot with a fresh block
 *  before any call, so this never fires. Plain `new` on purpose — the stub
 *  must NOT self-register the way AgencyFunction.create does. */
function makeBlockStub(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: () => {
      throw new Error(
        `Block "${name}" from module "${module}" crossed a serialization ` +
          `boundary and was invoked before replay rebound it. This is a ` +
          `runtime bug — please report it.`,
      );
    },
    params: [],
    toolDefinition: null,
  });
}
```

(`AgencyFunction` is already imported at the top of the file.)

- [ ] **Step 5: Run the unit tests to verify they pass**

```bash
pnpm test:run lib/runtime/revivers/functionRefReviver.test.ts 2>&1 | tee /tmp/513-t2-unit.log
```

Expected: ALL PASS, including the pre-existing `"throws when function is not found"`.

- [ ] **Step 6: Rebuild and run the Task 1 fixtures**

```bash
make 2>&1 | tail -3
pnpm run agency test tests/agency/subprocess/nested-pause-maxcost.agency 2>&1 | tee /tmp/513-t2-maxcost.log
pnpm run agency test tests/agency/subprocess/nested-pause-user-guard.agency 2>&1 | tee /tmp/513-t2-userguard.log
pnpm run agency test tests/agency/subprocess/nested-pause-user-wrapper.agency 2>&1 | tee /tmp/513-t2-userwrapper.log
```

Expected: ALL THREE PASS with `✓ Exact match passed` (verified achievable 2026-07-14 for the first two with exactly this change; the wrapper variant exercises the identical mechanism).

- [ ] **Step 7: Run the neighborhood regression sample**

```bash
for f in nested-pause-resume pause-multi-cycle callback-forwarding-nested-relay run-max-cost; do
  echo "== $f"
  pnpm run agency test "tests/agency/subprocess/$f.agency"
done 2>&1 | tee /tmp/513-t2-regression.log
```

Expected: all PASS (`run-max-cost` contains several tests — every one must pass; the rest have 1 each).

- [ ] **Step 8: Commit**

Write `/tmp/513-commit-2.txt`:

```
Revive unregistered block refs to a lazy stub instead of dying (#513)

Blocks self-register at creation time, so a fresh process restoring a
checkpoint always misses them in the registry — the eager throw killed
every cross-process resume that had a block-taking function (guard) on
the serialized stack. Replay rebinds block args before use; the stub is
a tripwire that errors precisely at the call if a rebind ever fails.
Named functions keep the eager throw (a real rename/removal signal).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

```bash
git branch --show-current   # must be fix/513-block-ref-revive
git add lib/runtime/blockNames.ts lib/runtime/revivers/functionRefReviver.ts lib/runtime/revivers/functionRefReviver.test.ts lib/backends/typescriptBuilder/stepPathTracker.ts
git commit -F /tmp/513-commit-2.txt
```

---

### Task 3: Collapse `run()` to a single guarded call site

**Files:**
- Modify: `packages/agency-lang/stdlib/agency.agency:161-196` (the two-call-sites region inside `run()`)

**Interfaces:**
- Consumes: Task 2 (the guarded path must survive nested pause). `pushGuardImpl` disable rule: a NEGATIVE limit disables the dimension; `guard(cost: null, time: null)` throws (`lib/stdlib/thread.ts:258`).
- Produces: `run()` behavior unchanged for callers; every `run()` call now exercises the guard-block path.

- [ ] **Step 1: Replace the two call sites**

In `stdlib/agency.agency`, delete this region (currently lines 161-196 — the comment, the `if (maxCost == null)` early return, and the `const guarded = guard(...)` opener):

```
  // Two call sites on purpose. Wrapping the no-cap path in an inert
  // guard block breaks nested subprocess pause/resume: when THIS process
  // is itself a subprocess that pauses on a bubbled interrupt, resuming
  // its serialized stack through the guard block loses the block's
  // return value and run() yields undefined (see the nested-pause-resume
  // fixture, which caught this in CI). Keep the argument lists below
  // IDENTICAL.
  if (maxCost == null) {
    return try _run(
      compiled,
      node,
      args,
      wallClock,
      memory,
      ipcPayload,
      stdout,
      configOverrides,
      cwd,
      maxDepth,
    )
  }
  const guarded = guard(cost: maxCost) as {
```

and replace it with:

```
  // guard() disables a dimension on a NEGATIVE value (null for BOTH
  // dimensions throws), so a null maxCost maps to the disable value and
  // one guarded call site serves both cases. Safe since #513: block
  // frames revive correctly across a nested subprocess pause.
  const NO_COST_CAP = -1.0
  const cap = if maxCost != null then maxCost else NO_COST_CAP
  const guarded = guard(cost: cap) as {
```

(Agency has no ternary; `if ... then ... else` is the expression form, `docs/site/guide/basic-syntax.md:68`.)

Leave the block body (`return try _run(...)` with the ten arguments), the `guardFailure → limit_exceeded` translation, and `return guarded` untouched.

- [ ] **Step 2: Rebuild and verify the collapse compiles**

```bash
make 2>&1 | tee /tmp/513-t3-make.log | tail -5
```

Expected: clean build (stdlib recompiles; no diagnostics).

- [ ] **Step 3: Run the affected fixtures**

The collapse routes EVERY `run()` through the guard block — a structural change to the default path — so the sample must cover the structurally different flows now newly guarded: plain pause, multi-cycle pause, concurrent interrupts, and a reject path:

```bash
for f in nested-pause-resume pause-multi-cycle concurrent-handled handler-reject nested-pause-maxcost nested-pause-user-guard nested-pause-user-wrapper run-max-cost cost-no-double-charge-across-pause; do
  echo "== $f"
  pnpm run agency test "tests/agency/subprocess/$f.agency"
done 2>&1 | tee /tmp/513-t3-fixtures.log
```

Expected: all PASS. Pay attention to `run-max-cost`'s `nested` test (outer guard must not trip on the inner cap) and `cost-no-double-charge-across-pause` (cost accounting across the now-always-guarded pause).

- [ ] **Step 4: Commit**

Write `/tmp/513-commit-3.txt`:

```
Collapse run() to a single always-guarded call site

The duplicated ten-argument _run call existed only to keep the default
path out of the guard block while #513 was unfixed. With block refs
reviving correctly, one call site serves both cases: maxCost null maps
to -1, which guard() treats as cost-dimension disabled. Every run()
call now exercises the guarded path, so the whole subprocess suite is
a regression alarm for #513.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

```bash
git branch --show-current   # must be fix/513-block-ref-revive
git add stdlib/agency.agency
git commit -F /tmp/513-commit-3.txt
```

---

### Task 4: Probe the scoped-callbacks sibling case

`State.toJSON` serializes `scopedCallbacks` function values as FunctionRefs too, and callback registrations are NOT rebound by replay the way block arguments are (their registration step is skipped by the step counter). This task determines empirically whether that case is broken, and applies the spec's decision tree. It is a probe with a decision gate — do not silently grow it into a rework of callback registration.

**Files:**
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-scoped-callback.agency`
- Create: `packages/agency-lang/tests/agency/subprocess/nested-pause-scoped-callback.test.json`

**Interfaces:**
- Consumes: Task 2's stub behavior; the `callback("onNodeStart") as data { ... }` idiom (see `tests/agency/subprocess/callback-forwarding-child-events.agency`).
- Produces: either a passing coverage fixture, or a filed follow-up issue with the fixture attached.

- [ ] **Step 1: Write the probe fixture**

Create `packages/agency-lang/tests/agency/subprocess/nested-pause-scoped-callback.agency`. The middle process registers a block-bodied callback, pauses across serialization, and after resuming runs a second child — proving the callback still fires post-resume. Both child sources travel as node args from the top process (triple-quoted strings cannot nest — same pattern as `nested-pause-resume`). The counter is declared at MODULE scope, mirroring the proven `callback-forwarding-child-events.agency`, so a capture-semantics quirk cannot muddy the probe:

```
import { compile, run } from "std::agency"

// #513 sibling probe: the middle process registers a block-bodied scoped
// callback, then pauses across serialize/resume (grandchild bash is
// unhandled). After the resume it runs a SECOND child; if the callback
// survived the round trip, that child's onNodeStart increments the counter
// again. Healthy expectation: cb=2 (grandchild start + second child start).
node main() {
  const grandSource = """
import { bash } from "std::shell"
node main() {
  let r = bash("echo deep-ok")
  return r.stdout
}
"""
  const secondSource = """
node main() {
  return "second done"
}
"""
  const childSource = """
import { compile, run } from "std::agency"

let starts: number = 0

node main(grandSource: string, secondSource: string) {
  callback("onNodeStart") as data {
    starts = starts + 1
  }
  const c = compile(grandSource)
  if (isFailure(c)) {
    return "inner compile failed"
  }
  const c2 = compile(secondSource)
  if (isFailure(c2)) {
    return "second compile failed"
  }
  handle {
    const result = run(compiled: c.value, node: "main")
    if (isFailure(result)) {
      return "inner run failed"
    }
    const second = run(compiled: c2.value, node: "main")
    if (isFailure(second)) {
      return "second run failed"
    }
    return "${result.value.data}:cb=${starts}"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
"""
  const compileResult = compile(childSource)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(
      compiled: compileResult.value,
      node: "main",
      args: { grandSource: grandSource, secondSource: secondSource },
    )
    if (isSuccess(result)) {
      return "OK: ${result.value.data}"
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

The middle node's own `main` start does not count: the callback registers after that node has already started. Verify the fixture parses before running it: `pnpm run ast tests/agency/subprocess/nested-pause-scoped-callback.agency > /dev/null && echo PARSES`.

- [ ] **Step 2: Run the probe and record the outcome**

Create `nested-pause-scoped-callback.test.json` with a provisional expectation (`"OK: deep-ok\n:cb=2"` is NOT yet trustworthy — the exact count depends on which starts are forwarded):

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "#513 sibling: a block-bodied scoped callback survives the middle hop's pause/serialize/resume and still fires afterward",
      "input": "",
      "expectedOutput": "PIN AFTER FIRST RUN",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

```bash
pnpm run agency test tests/agency/subprocess/nested-pause-scoped-callback.agency 2>&1 | tee /tmp/513-t4-probe.log
```

Read the actual output from the log. Interpret per the spec's decision tree. **Pin only proof, never just "whatever appeared":** the healthy value is `"OK: deep-ok\n:cb=2"` — the count MUST include the post-resume second child's start. A cb=1 output means the callback died at the pause; do not pin it.

- **Callback fired after resume** (output shows the second child's start counted, i.e. cb=2): pin `expectedOutput` to the observed full string, re-run to green, keep the fixture as coverage. Proceed to Step 3.
- **Anything else** (cb=1, run failure, or the Task 2 tripwire message in the log): the case is broken independently of this fix. Do NOT fix callback re-registration in this PR. File a follow-up issue with `gh issue create` (title: `Scoped callbacks with block bodies do not survive cross-process resume`; body written to a file, referencing this fixture, the observed output, and #513), paste the fixture into the issue body as the repro, and DELETE the fixture files from the branch so CI stays green. Proceed to Step 3.

Either way, summarize the observed outcome for the owner in the task report.

- [ ] **Step 3: Commit (fixture, or issue link in the commit body)**

Write `/tmp/513-commit-4.txt` — adjust the first line to match the outcome:

```
Probe scoped-callback survival across subprocess pause (#513 sibling)

[EITHER] The block-bodied scoped callback survives cross-process resume;
fixture pins the behavior.
[OR] The case is broken independently of the #513 fix; filed #<N> with
the repro attached instead of shipping a red fixture.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

```bash
git branch --show-current   # must be fix/513-block-ref-revive
git add -A packages/agency-lang/tests/agency/subprocess/
git commit -F /tmp/513-commit-4.txt
```

---

### Task 5: Correct the record and open the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-issue-513-guard-block-subprocess-resume-investigation.md` (banner at top)

**Interfaces:**
- Consumes: everything above, merged into the branch.
- Produces: the PR.

- [ ] **Step 1: Add the correction banner**

At the very top of `docs/superpowers/specs/2026-07-13-issue-513-guard-block-subprocess-resume-investigation.md`, immediately under the title line, insert:

```markdown
> **CORRECTION (2026-07-14):** The root-cause theory below is WRONG. The
> subprocess payload does NOT get lost on a popped block frame — checkpoints
> are stamped while block frames are live, and positional replay realigns
> them. The verified cause is `FunctionRefReviver` throwing eagerly on
> unregistered `__block_<n>` references when a FRESH process restores a
> checkpoint (blocks self-register only when their creating line executes).
> See `2026-07-14-issue-513-block-ref-revive-fix-design.md` for the verified
> mechanism and the fix. The code references below remain useful.
```

- [ ] **Step 2: Commit**

Write `/tmp/513-commit-5.txt`:

```
Correct the #513 investigation spec's root-cause theory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

```bash
git branch --show-current   # must be fix/513-block-ref-revive
git add docs/superpowers/specs/2026-07-13-issue-513-guard-block-subprocess-resume-investigation.md
git commit -F /tmp/513-commit-5.txt
```

- [ ] **Step 3: Push and open the PR**

Write the PR body to `/tmp/513-pr-body.md`:

```markdown
Fixes #513.

## What was actually wrong

Blocks (`as { }`) self-register in the function-ref registry when their
creating line executes. A frame that holds a block argument serializes it as
a `FunctionRef` name reference. When a paused subprocess is re-forked, the
fresh process restores the checkpoint BEFORE running any code, so the block
is not registered yet — and `FunctionRefReviver` threw eagerly, killing the
whole resume. The revived value was garbage anyway: replay rebinds block
arguments at function entry before anything can call them.

The earlier investigation doc blamed a popped block frame; that theory is
wrong and is corrected in-repo.

## The fix

- `FunctionRefReviver`: an unregistered block ref now revives to a lazy stub
  that throws a precise error IF invoked (a tripwire that never fires in
  correct replays). Named functions keep the eager throw — for them a miss
  means the program really changed. The `__block_<n>` naming scheme now has
  a single source of truth (`lib/runtime/blockNames.ts`) shared by the
  backend that mints names and the reviver that recognizes them.
- Three regression fixtures: nested pause through `run(maxCost:)`, through a
  user-level `guard(...) as { }`, and through a user-DEFINED block-taking
  wrapper (the userland-extensibility goal, pinned).
- `run()` collapsed to a single always-guarded call site (the #512 review
  note this bug was blocking). Every `run()` now exercises the guarded path.
- Scoped-callback sibling case probed; outcome recorded in the task history.

## Testing

- New unit tests for the reviver contract split.
- New fixtures pass; `nested-pause-resume`, `pause-multi-cycle`,
  `callback-forwarding-nested-relay`, `run-max-cost`, and
  `cost-no-double-charge-across-pause` pass locally.
- CI runs the full agency suite.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

```bash
git push -u origin fix/513-block-ref-revive
gh pr create --title "Revive block refs across subprocess resume via lazy stub (#513)" --body-file /tmp/513-pr-body.md
```

Expected: PR URL printed. Report it to the owner.
