# ALS Migration Phase 4 Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish pruning the codegen-emitted setup-block locals (`__graph`, `statelogClient`, `__stateStack`, `__ctx`) so generated agency code reads runtime context from `agencyStore` (ALS) instead of from per-scope `const` declarations, and add a body-level `agencyStore.run` wrap as defense-in-depth.

**Architecture:** Each local being pruned gets the same treatment that `__threads` got in PR #201:

1. Introduce a tiny `__<name>()` accessor in `lib/runtime/asyncContext.ts` that reads from the active `agencyStore` frame (or returns `undefined` when no frame is installed, matching pre-migration lenient behavior).
2. Export the accessor from `lib/runtime/index.ts`, add to `imports.mustache`.
3. Flip every `__X` reference in `lib/templates/.../*.mustache` and the IR builders (`lib/ir/builders.ts` / `prettyPrint.ts`) to `__X()` (or `getRuntimeContext().X` at sites where a `TypeError` from an undefined dereference would be unactionable — see PR #201's `system.mustache` precedent).
4. Drop the `const __X = ...` declaration from `setupEnv()` in `lib/ir/builders.ts` and from the corresponding `setupEnv({...})` calls in `lib/backends/typescriptBuilder.ts`.
5. For `classMethod.mustache`, drop the explicit `const __X = ...` line and inline the source (e.g. `__setupData.threads` style) where still needed.
6. Regenerate templates (`pnpm run templates`), commit code + templates.
7. Regenerate fixtures (`make fixtures`), commit fixtures.
8. Push, open PR, watch Copilot review.

**Tech Stack:** TypeScript, typestache mustache templates, vitest, the existing `lib/runtime/asyncContext.ts` ALS infrastructure (`agencyStore`, `getRuntimeContext`, `runInBootstrapFrame`, `BootstrapThreadStore`).

**Workflow conventions (apply to every task):**

- Create a fresh worktree per PR: `git worktree add -b <branch-name> .worktrees/<branch-name> main` from `/Users/adityabhargava/agency-lang/packages/agency-lang/`. The agency-lang package lives at `.worktrees/<branch-name>/packages/agency-lang/`.
- After `git worktree add`, run `pnpm install` in the worktree (templates and stdlib build depend on it).
- Commit code + templates in one commit, then fixture regen in a separate follow-up commit on the same PR. Reviewers can stop at the first commit.
- Templates: only edit `.mustache`; run `pnpm run templates` to regenerate the `.ts`. Commit both.
- Commit messages and PR bodies via file (`git commit -F /tmp/msg.txt`, `gh pr create --body-file /tmp/body.md`) — apostrophes break on the command line.
- Validation: `pnpm tsc --noEmit && pnpm run lint:structure && pnpm test:run`. Do NOT run the full agency suite locally — CI runs it.
- Save test output to a file (`pnpm test:run 2>&1 | tee /tmp/vitest-out.log | tail -10`) so re-runs aren't needed.

---

## Task 1: Prune dead `__graph` and `statelogClient` locals

**Why:** These two `setupEnv` locals are declared in every generated function/node setup block (and `classMethod`) but **never referenced** by any other template, IR builder, or codegen path. `grep -rEn "\\b__graph\\b" lib/` only finds the declaration site itself. Same for `statelogClient`. This is the smallest possible win — pure dead-code removal with no ALS work.

**Files:**
- Modify: `lib/ir/builders.ts:542-577` (drop `statelogClient` and `graph` params + `constDeclId` lines from `setupEnv`)
- Modify: `lib/backends/typescriptBuilder.ts:1473-1482` (drop `statelogClient:` and `graph:` from setupEnv call in function-body emission)
- Modify: `lib/backends/typescriptBuilder.ts:2179-2188` (drop them from node-body emission)
- Modify: `lib/templates/backends/typescriptGenerator/classMethod.mustache:7-8` (drop the two `const` lines)

**Estimated fixture fan-out:** ~90 files (every generated module loses 2 lines).

### Steps

- [ ] **Step 1: Create worktree**

```bash
git worktree add -b prune-dead-setup-locals .worktrees/prune-dead-setup-locals main
cd .worktrees/prune-dead-setup-locals/packages/agency-lang
pnpm install
```

- [ ] **Step 2: Verify the dead-local claim**

```bash
grep -rEn "\b__graph\b" lib/ stdlib/ | grep -v "\.ts:" | grep -v "/runtime/" | head
grep -rEn "\bstatelogClient\b" lib/templates/ lib/ir/ lib/backends/typescriptBuilder.ts | head
```

Expected: only the declaration sites in `setupEnv`, `classMethod.mustache`, and (for `statelogClient`) the two `setupEnv` calls in `typescriptBuilder.ts`. If anything else uses them, STOP and reassess scope.

- [ ] **Step 3: Edit `lib/ir/builders.ts`'s `setupEnv`**

Drop `statelogClient` and `graph` from both the destructuring params and the `TsStatements` array. The signature becomes:

```ts
setupEnv({
  stateStack,
  stack,
  step,
  self,
  ctx,
}: {
  stateStack?: TsNode;
  stack: TsNode;
  step: TsNode;
  self: TsNode;
  ctx: TsNode;
}): TsStatements {
  return ts.statements([
    ...(stateStack ? [ts.constDecl("__stateStack", stateStack)] : []),
    ts.constDeclId(ts.runtime.stack, stack),
    ts.constDeclId(ts.runtime.step, step),
    ts.constDeclId(ts.runtime.self, self),
    ts.constDeclId(ts.runtime.ctx, ctx),
    ts.letDecl("__forked"),
    ts.letDecl("__functionCompleted", ts.bool(false)),
  ]);
},
```

Also remove `statelogClient` and `graph` from `ts.runtime` if they have no other consumers (they don't — these were only used by `setupEnv`):

```bash
grep -n "runtime\.statelogClient\|runtime\.graph" lib/
```

If only `setupEnv` referenced them, drop the entries from the `runtime: { ... }` object at the bottom of `builders.ts`.

- [ ] **Step 4: Update both `setupEnv` callers in `lib/backends/typescriptBuilder.ts`**

Search for `setupEnv({` (two hits, around lines 1473 and 2179). Remove the `statelogClient: ts.ctx("statelogClient"),` and `graph: ts.ctx("graph"),` lines from both.

- [ ] **Step 5: Edit `classMethod.mustache`**

Remove:
```
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
```

- [ ] **Step 6: Regenerate templates**

```bash
pnpm run templates
```

Verify the generated `classMethod.ts` no longer mentions either local.

- [ ] **Step 7: Type-check + lint + tests**

```bash
pnpm tsc --noEmit
pnpm run lint:structure
pnpm test:run 2>&1 | tee /tmp/vitest-dead-locals.log | tail -20
```

Expected: tsc clean, lint clean, fixture comparison tests fail (vitest reports ~90 failures, all of form "expected vs received — `statelogClient` / `__graph` lines missing"). Other tests should pass.

- [ ] **Step 8: Build + fixture regen**

```bash
make           # rebuild dist so stdlib codegen reflects the change
make fixtures  # regen integration test fixtures
```

- [ ] **Step 9: Re-run vitest, confirm 4423/4423 pass**

```bash
pnpm test:run 2>&1 | tee /tmp/vitest-dead-locals-2.log | tail -10
```

- [ ] **Step 10: Spot-check fixtures**

```bash
grep -n "__graph\|statelogClient" tests/typescriptBuilder/simple.mjs
# Expected: no output
```

- [ ] **Step 11: Commit code + templates**

```bash
git add lib/ir/builders.ts lib/backends/typescriptBuilder.ts \
  lib/templates/backends/typescriptGenerator/classMethod.mustache \
  lib/templates/backends/typescriptGenerator/classMethod.ts
cat > /tmp/commit-dead-locals.txt <<'EOF'
codegen: remove dead __graph and statelogClient setup locals

The setupEnv helper declares `const __graph = ...` and
`const statelogClient = ...` (also redeclared in classMethod.mustache),
but no template, IR builder, or downstream codegen path ever references
either local. Verified via grep across lib/templates, lib/ir, and
lib/backends — only the declaration sites match. Drop both declarations
and the corresponding ts.runtime entries.

Pure dead-code removal — no ALS work. The accessor migrations for
__ctx and __stateStack land in follow-up PRs.

Fixture regen lands in the next commit.
EOF
git commit -F /tmp/commit-dead-locals.txt
```

- [ ] **Step 12: Commit fixtures**

```bash
git add -A
cat > /tmp/commit-dead-locals-fixtures.txt <<'EOF'
fixtures: regen after removing dead __graph and statelogClient locals

Generated via `make fixtures`.
EOF
git commit -F /tmp/commit-dead-locals-fixtures.txt
```

- [ ] **Step 13: Push + open PR**

```bash
git push -u origin prune-dead-setup-locals
gh pr create --base main \
  --title "codegen: remove dead __graph and statelogClient setup locals" \
  --body-file /tmp/pr-dead-locals.md
```

PR body talks about: dead-code finding, grep-based verification, no behavior change.

- [ ] **Step 14: Watch Copilot review**

```bash
sleep 90 && gh api repos/egonSchiele/agency-lang/pulls/<N>/comments --jq '.[] | {path, line, body}'
```

If comments arrive, address them in a follow-up commit (do NOT amend).

---

## Task 2: Prune `__stateStack` local via `__stateStack()` accessor

**Why:** `__stateStack` is one of the four remaining setup-block locals. It has real consumers (passed to `checkpoints.create*` and `interruptWithHandlers`) so this PR is the template for migrating non-dead locals.

**Files:**
- Modify: `lib/runtime/asyncContext.ts` — add `__stateStack()` accessor next to `__threads()`
- Modify: `lib/runtime/index.ts` — export `__stateStack`
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` — add `__stateStack` to runtime import list
- Modify: `lib/ir/builders.ts` — drop `stateStack` from `setupEnv`, change `runtime.stateStack` (if it exists) or introduce one
- Modify: `lib/backends/typescriptBuilder.ts` — drop `stateStack:` from both `setupEnv` calls; flip the two `ts.id("__stateStack")` / `ts.raw("__stateStack.pop()")` references at lines ~1593, ~2095, ~2136 to `__stateStack()` calls. Note: `__stateStack.pop()` happens inside `finally` blocks on Runner-managed state — it removes the frame this scope pushed. After ALS migration we still need to pop; just change to `__stateStack().pop()`.
- Modify: `lib/templates/backends/typescriptGenerator/classMethod.mustache:27` — `__stateStack.pop()` → `__stateStack().pop()`
- Modify: `lib/templates/backends/typescriptGenerator/resultCheckpointSetup.mustache:3` — `__ctx.checkpoints.createPinned(__stateStack, ...)` → `... (__stateStack(), ...)`
- Modify: `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` — lines 18, 32 (both `__stateStack` references)
- Modify: `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache` — lines 22, 38

**Special case — `forkBlockSetup.mustache:10`:** `const __stateStack = __forkBranchStack;` — this is a local rebind inside a fork branch body. Leave it alone (or rename `__forkBranchStack` directly into the fork emission and drop the alias). The accessor would not return the branch-specific stack here. Document this exception in the PR body.

**Estimated fixture fan-out:** ~90 files.

### Steps

- [ ] **Step 1: Create worktree, install**

```bash
git worktree add -b prune-stateStack-local .worktrees/prune-stateStack-local main
cd .worktrees/prune-stateStack-local/packages/agency-lang
pnpm install
```

- [ ] **Step 2: Add the `__stateStack()` accessor**

In `lib/runtime/asyncContext.ts`, right after `__threads()`:

```ts
/**
 * Generated-code accessor for the current StateStack. Mirrors __threads()
 * — reads from the active agencyStore frame. Returns undefined when no
 * frame is installed; the only emission site that can hit that path is
 * the finally-block `__stateStack().pop()` in classMethod scopes called
 * outside any Agency execution frame (e.g. as a tool by an LLM where no
 * outer ALS frame is set). The optional chaining at the call site
 * (templates emit `__stateStack()?.pop()` there) handles that cleanly.
 *
 * Sites where undefined would crash unactionably (e.g.
 * `interruptWithHandlers(..., __stateStack(), ...)`) should call
 * getRuntimeContext().stack directly to get the strict-throw error.
 */
export function __stateStack(): StateStack | undefined {
  return agencyStore.getStore()?.stack;
}
```

Add `import type { StateStack } from "./state/stateStack.js";` to the file's existing imports.

- [ ] **Step 3: Export from `lib/runtime/index.ts`**

Add `__stateStack` to the existing `asyncContext.js` re-export.

- [ ] **Step 4: Add to imports template**

In `lib/templates/backends/typescriptGenerator/imports.mustache:27`:

```
  __call, __callMethod, __threads, __stateStack, getRuntimeContext,
```

- [ ] **Step 5: Flip template emission sites**

For each `.mustache` file in the Files list, replace `__stateStack` references with `__stateStack()`. Use `sed -i ''` for bulk changes but verify each one is in a safe context (no chained access on potentially-undefined values without optional chaining):

```bash
# classMethod.mustache finally block: use optional chaining
sed -i '' 's/__stateStack\.pop()/__stateStack()?.pop()/' \
  lib/templates/backends/typescriptGenerator/classMethod.mustache

# Other sites pass __stateStack as an argument — switch to plain call:
for f in lib/templates/backends/typescriptGenerator/resultCheckpointSetup.mustache \
         lib/templates/backends/typescriptGenerator/interruptReturn.mustache \
         lib/templates/backends/typescriptGenerator/interruptAssignment.mustache; do
  # Match `__stateStack` NOT followed by `()` and not preceded by `__`
  sed -i '' -E 's/([(, ])__stateStack([,)])/\1__stateStack()\2/g' "$f"
done
```

After the substitutions, diff each file and visually confirm. Then regenerate `.ts` via `pnpm run templates`.

- [ ] **Step 6: Update `lib/ir/builders.ts`**

Remove `stateStack` from the `setupEnv` signature and body:

```ts
setupEnv({
  stack,
  step,
  self,
  ctx,
}: {
  stack: TsNode;
  step: TsNode;
  self: TsNode;
  ctx: TsNode;
}): TsStatements {
  return ts.statements([
    ts.constDeclId(ts.runtime.stack, stack),
    ts.constDeclId(ts.runtime.step, step),
    ts.constDeclId(ts.runtime.self, self),
    ts.constDeclId(ts.runtime.ctx, ctx),
    ts.letDecl("__forked"),
    ts.letDecl("__functionCompleted", ts.bool(false)),
  ]);
},
```

If `ts.runtime.stack` referred to the State frame (not the StateStack), introduce a `ts.runtime.stateStack` as a TsRaw call expression (like `ts.runtime.threads` now is): `{ kind: "raw", code: "__stateStack()" } as TsRaw`.

- [ ] **Step 7: Update `lib/backends/typescriptBuilder.ts`**

- Lines 1473, 2179: drop `stateStack:` from the `setupEnv({...})` calls.
- Line 2095: `ts.id("__stateStack")` → `ts.runtime.stateStack` (or `ts.raw("__stateStack()")`).
- Lines 1593, 2136: `ts.raw("__stateStack.pop()")` → `ts.raw("__stateStack()?.pop()")`.

- [ ] **Step 8: Regenerate templates, build, validate**

```bash
pnpm run templates
make
pnpm tsc --noEmit
pnpm run lint:structure
pnpm test:run 2>&1 | tee /tmp/vitest-stateStack-1.log | tail -20
```

Expect ~90 fixture failures.

- [ ] **Step 9: Regen fixtures + re-validate**

```bash
make fixtures
pnpm test:run 2>&1 | tee /tmp/vitest-stateStack-2.log | tail -10
```

Should show 4423/4423 passing.

- [ ] **Step 10: Spot-check a generated file**

```bash
grep -n "__stateStack" tests/typescriptBuilder/simple.mjs | head
# Expect: __stateStack() or __stateStack()?.pop() — no bare __stateStack
```

- [ ] **Step 11: Commit code + templates, fixtures, push, open PR**

Mirror Task 1's commit/PR pattern. Commit message templates:

```text
codegen: drop __stateStack local, read via ALS accessor

Follow-up to PR #201 (__threads accessor). Adds an __stateStack()
accessor in lib/runtime/asyncContext.ts that returns the active
agencyStore frame's StateStack (or undefined when no frame). Every
template, IR builder, and typescriptBuilder.ts emission site flips
from `__stateStack` to `__stateStack()`. setupEnv no longer declares
the const; classMethod.mustache uses `__stateStack()?.pop()` in the
finally block (the only call site that can run outside a frame).

forkBlockSetup.mustache's `const __stateStack = __forkBranchStack;`
is left untouched — that's an intentional local rebind to the
fork-branch stack and shouldn't be sourced from the parent ALS frame.

Fixture regen lands in the next commit.
```

Open the PR with `gh pr create --base main`.

- [ ] **Step 12: Watch Copilot review, fix any issues in follow-up commits.**

---

## Task 3: Prune `__ctx` local via `__ctx()` accessor

**Why:** Final and largest local prune. `__ctx` is referenced ~17 times in `typescriptBuilder.ts` and many times in every template (`__ctx.checkpoints.*`, `__ctx.getInterruptResponse(...)`, `__ctx.globals.*`, etc.). After this, `setupEnv` reduces to just `__stack/__step/__self/__forked/__functionCompleted` and `classMethod.mustache` becomes much leaner.

**Files:**
- Modify: `lib/runtime/asyncContext.ts` — add `__ctx()` accessor
- Modify: `lib/runtime/index.ts` — export `__ctx`
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` — add `__ctx` to import list
- Modify: `lib/ir/builders.ts` — drop `ctx` from `setupEnv` signature/body; change `ts.runtime.ctx` (line 734) to a `TsRaw` `__ctx()` call (mirrors what `ts.runtime.threads` became in PR #201)
- Modify: `lib/backends/typescriptBuilder.ts` — drop `ctx:` from both `setupEnv` calls; audit every emission site that builds raw strings containing `__ctx` (e.g. lines around 1487 for `__ctx.globals.isInitialized`, 1489 for `__initializeGlobals(__ctx)`); these need to switch to `__ctx()`
- Modify: every template that uses `__ctx`:
  - `blockSetup.mustache:1,7,12`
  - `classMethod.mustache:6,7,8,11,12,14` (drop the `const __ctx = ...` line on 6, change every other reference to `__ctx()`)
  - `debugger.mustache:1` (`debugStep(__ctx, ...)` → `debugStep(__ctx(), ...)` — caveat: if the call is in a node-context where `__ctx()` MUST be non-undefined, prefer `getRuntimeContext().ctx`)
  - `interruptReturn.mustache:2,12,18,24,32,34`
  - `interruptAssignment.mustache:2,16,22,28,38,40`
  - `resultCheckpointSetup.mustache:2,3,5,6,7`
  - `functionCatchFailure.mustache:15`
- Modify: `lib/runtime/runner.ts` — the codegen-emitted `__ctx?.getResultCheckpoint()` (`runner.haltResult` may carry it) needs no change; runtime helpers already use `getRuntimeContext().ctx` directly.

**Decision: lenient `__ctx()` vs strict `getRuntimeContext().ctx`.** Same trade-off as `__threads()` in PR #201. Recommend `__ctx()` for sites that:
- Pass `__ctx` as an argument to a function that itself uses ALS (e.g. `__initializeGlobals(__ctx())` — but actually `__initializeGlobals` reads from ALS, so the argument can be dropped entirely; verify against the helper's signature).
- Read a property that's typed `| undefined`-tolerant by the consumer.

Use `getRuntimeContext().ctx` at sites where a `Cannot read properties of undefined` would be opaque:
- `__ctx.checkpoints.create(...)` — checkpoint creation outside an ALS frame is a programmer error worth a clear message.
- `__ctx.getInterruptResponse(...)` — same.

**Estimated fixture fan-out:** ~90 files. Diff per file will be substantially larger than `__threads` because `__ctx` appears in many more lines.

### Steps

- [ ] **Step 1: Create worktree, install**

```bash
git worktree add -b prune-ctx-local .worktrees/prune-ctx-local main
cd .worktrees/prune-ctx-local/packages/agency-lang
pnpm install
```

- [ ] **Step 2: Add `__ctx()` accessor**

In `lib/runtime/asyncContext.ts`, next to `__threads()` and `__stateStack()`:

```ts
/**
 * Generated-code accessor for the current RuntimeContext. Returns the
 * `ctx` field of the active agencyStore frame, or undefined when no
 * frame is installed. See the strict/lenient guidance in
 * docs/dev/async-context.md — emission sites that would crash
 * unactionably on undefined should use `getRuntimeContext().ctx`
 * instead.
 */
export function __ctx(): RuntimeContext<any> | undefined {
  return agencyStore.getStore()?.ctx;
}
```

- [ ] **Step 3: Export, add to imports template** (same pattern as Tasks 1+2)

- [ ] **Step 4: Update `ts.runtime.ctx` in `lib/ir/builders.ts`**

```ts
ctx: { kind: "raw", code: "__ctx()" } as TsRaw,
```

Drop `ctx` from `setupEnv`. Update the `ts.ctx(varName)` helper if it still references `ts.runtime.ctx`:

```ts
ctx(varName: string): TsNode {
  return ts.prop(ts.runtime.ctx, varName);
},
```

`ts.prop(<TsRaw>, "X")` should emit `__ctx().X`. Confirm via a unit test or manual probe.

- [ ] **Step 5: Flip each template**

For each template in the Files list, change `__ctx` → `__ctx()` *except* for sites flagged "strict" (use `getRuntimeContext().ctx` there). Suggested decisions:

- `__ctx.checkpoints.*` → `getRuntimeContext().ctx.checkpoints.*`
- `__ctx.getInterruptResponse` → `getRuntimeContext().ctx.getInterruptResponse`
- `__ctx.getResultCheckpoint` → `__ctx()?.getResultCheckpoint()` (sites are inside `failure(...)` constructors where undefined would degrade gracefully)
- `__ctx._pendingArgOverrides` and `__ctx.globals.isInitialized` → `__ctx().*` if always inside a Runner frame

Document each decision in the PR body.

- [ ] **Step 6: Update `lib/backends/typescriptBuilder.ts`**

Search for every `ts.id("__ctx")`, `ts.raw("...__ctx...")`, and `ts.ctx(...)`. Roughly 17 sites. For each, decide strict-vs-lenient and rewrite. Easiest mechanical pattern:

```bash
grep -n "__ctx" lib/backends/typescriptBuilder.ts
```

- [ ] **Step 7: Regenerate templates, build, validate**

```bash
pnpm run templates
make
pnpm tsc --noEmit
pnpm run lint:structure
pnpm test:run 2>&1 | tee /tmp/vitest-ctx-1.log | tail -20
```

Expect ~90 fixture failures.

- [ ] **Step 8: Regen fixtures, re-validate**

```bash
make fixtures
pnpm test:run 2>&1 | tee /tmp/vitest-ctx-2.log | tail -10
```

Confirm 4423/4423.

- [ ] **Step 9: Diff a representative fixture, sanity-check codegen**

```bash
git diff tests/typescriptBuilder/simple.mjs | head -60
```

Look for: no bare `__ctx` declaration, all `__ctx` references now `__ctx()` or `getRuntimeContext().ctx`.

- [ ] **Step 10: Commit code + templates, fixtures, push, open PR**

```text
codegen: drop __ctx local, read via ALS accessor

The third and largest local in the Phase 4 cleanup. setupEnv no
longer declares `const __ctx = ...`. Every reference in templates
and typescriptBuilder.ts flips to either:

  - `__ctx()` — lenient, returns undefined outside any ALS frame.
    Used at sites where degradation is graceful (failure(...)
    constructors that can carry an undefined checkpoint).
  - `getRuntimeContext().ctx` — strict throw. Used at sites where
    undefined would produce an opaque TypeError (checkpoint
    creation, interrupt response lookup, global initialization
    guards). Mirrors the system.mustache decision from PR #201.

After this PR, the setup block becomes: __stack, __step, __self,
__forked, __functionCompleted. classMethod.mustache loses the
`const __ctx = ...` line entirely.

Fixture regen lands in the next commit.
```

- [ ] **Step 11: Address Copilot review.**

---

## Task 4: Body-level `agencyStore.run` wrap

**Why:** Defense in depth. Today, each `Runner.step` body re-enters ALS via `Runner.runInScope`, but code that runs *between* Runner steps (the `try { ... }` body of a function/node, hooks, finally blocks) runs in whatever outer ALS frame happened to be installed. Nothing user-facing reaches that gap today, but the gap means a future refactor could silently lose the per-scope frame. Wrapping the whole try block in `agencyStore.run({ ctx, stack, threads }, async () => { ... })` makes the contract explicit and removes the gap.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` — function-body emission (~1573) and node-body emission (~2214). Wrap the `ts.tryCatch(...)` body inside `agencyStore.run({ ... }, async () => { <body> })`. The `agencyStore` import needs to be added to `imports.mustache` if not present.
- Modify: `lib/templates/backends/typescriptGenerator/classMethod.mustache:19-29` — wrap the `try { ... } catch { ... } finally { ... }` block.

**Subtleties:**
- The `finally` block currently does `__stateStack.pop()` (or `__stateStack()?.pop()` post-Task 2). After wrapping, the pop runs inside the ALS frame — that's fine, no semantic difference.
- The `runner` variable must be declared OUTSIDE the `agencyStore.run` wrap so it's visible from both the wrap and the `if (runner.halted)` check after.
- Async closure: `agencyStore.run` accepts a function whose return value is the wrapped fn's return. Make sure to `return await agencyStore.run(...)` so the surrounding `async` function awaits the inner block.

**Estimated fixture fan-out:** ~90 files (every generated function/node body gets the wrap).

### Steps

- [ ] **Step 1: Create worktree, install** (same as prior tasks)

- [ ] **Step 2: Sketch the desired generated code**

Before:
```ts
const runner = new Runner(...);
try {
  // body
} catch (...) {
  // ...
} finally {
  __stateStack()?.pop();
}
```

After:
```ts
const runner = new Runner(...);
try {
  await agencyStore.run(
    { ctx: __setupData.ctx, stack: __setupData.stack, threads: __setupData.threads },
    async () => {
      // body
    },
  );
} catch (...) {
  // ...
} finally {
  __stateStack()?.pop();
}
```

- [ ] **Step 3: Edit `typescriptBuilder.ts` to emit the wrap**

Update both `ts.tryCatch` emission sites (function-body around line 1573; node-body around line 2214). Wrap their `body` argument in an `agencyStore.run(...)` call expression.

Create a small builder in `lib/ir/builders.ts`:

```ts
/** Wrap a block body in `await agencyStore.run({ ctx, stack, threads }, async () => { ... })`. */
withAlsFrame(body: TsNode[]): TsNode {
  return ts.raw(
    `await agencyStore.run(
      { ctx: __setupData.ctx, stack: __setupData.stack, threads: __setupData.threads },
      async () => {
${body.map((n) => printTs(n, 1)).join("\n")}
      },
    );`
  );
}
```

(Or refactor to use proper IR nodes once the pattern works.)

- [ ] **Step 4: Ensure `agencyStore` is imported**

Check `imports.mustache:9-30`. `agencyStore` is exported from `agency-lang/runtime` but probably not imported into generated code yet. Add it.

- [ ] **Step 5: Edit `classMethod.mustache`**

Wrap the `try { ... }` body the same way.

- [ ] **Step 6: Regenerate templates, build, validate, regen fixtures, re-validate** (standard cycle)

- [ ] **Step 7: Sanity-test a real Agency program with the new wrap**

```bash
cat > /tmp/wrap-smoke.agency <<'EOF'
def double(x: number): number {
  return x * 2
}

node main(): number {
  return double(21)
}
EOF
pnpm run agency /tmp/wrap-smoke.agency
# Expect: 42
```

If this crashes, the wrap is malformed.

- [ ] **Step 8: Commit, push, PR** (standard workflow)

PR body should explicitly call out: no behavior change today, but closes the gap between Runner-step entries; future work that adds code to the try block body will see the right ALS frame automatically.

---

## Task 5: Remove `class` from Agency (separate workstream)

**Why:** Out of scope for the ALS migration but mentioned in the original handoff as upcoming work that would simplify codegen further. Removing classes deletes `classMethod.mustache` entirely and folds class-emitter logic out of `lib/backends/typescriptBuilder/classEmitter.ts`. The user said to do ALS work first, then this.

**This is a placeholder.** Do NOT execute this task as part of the ALS-cleanup plan. When the user is ready, brainstorm a separate spec. Notes that will help that future work:

- `classEmitter.ts` is one of the bigger files under `lib/backends/typescriptBuilder/`.
- The parser has `class` / `extends` / `new` / `super` keywords — see `lib/parsers/`. Removal needs parser, AST, type checker, and codegen passes.
- `lib/types/classDefinition.ts` defines the AST node.
- ~30 test fixtures under `tests/typescriptGenerator/` (`class-*.mjs`) need to be deleted or migrated to plain object/function patterns.
- Documentation: `docs/site/guide/` likely has class examples to remove.

---

## Verification checklist (apply at the end of every task)

- [ ] `pnpm tsc --noEmit` — clean
- [ ] `pnpm run lint:structure` — clean
- [ ] `pnpm test:run` — 4423/4423 pass
- [ ] `make` — builds without error
- [ ] Spot-checked a representative fixture for the expected codegen shape
- [ ] No bare references to the pruned local in `tests/typescriptBuilder/`, `tests/typescriptGenerator/`, `tests/debugger/`, or `stdlib/*.js`
- [ ] Commits split: code + templates in commit 1, fixtures in commit 2
- [ ] PR body documents which sites picked `__X()` vs `getRuntimeContext().X` and why
- [ ] Copilot review checked within ~2 minutes of opening the PR (`gh api repos/.../pulls/<N>/comments`)

## Open questions / risks

- **`__ctx()` returning undefined.** Once `__ctx` becomes a function call, the cost is one function call per access — many per node body. Negligible runtime cost but verifies the call shape. If profiling shows it, cache locally in hot paths (`const ctx = __ctx();`).
- **Fixtures cap.** Each PR regenerates ~90 fixtures. If multiple PRs land in parallel, expect merge conflicts on the same fixture files. Sequence the PRs — merge one before opening the next.
- **Class removal interaction.** If classes are removed before Task 3 lands, `classMethod.mustache` disappears and that edit drops out. The plan still works; just skip the classMethod edit.
- **Real-LLM CI flakiness.** Independent issue (see ampcode thread for diagnosis). Don't conflate flaky thread/memory test failures with regressions from these PRs.
