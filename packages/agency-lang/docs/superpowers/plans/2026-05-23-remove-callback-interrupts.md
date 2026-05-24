# Remove Interrupts from Callbacks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Drop the "callbacks can raise interrupts" feature entirely. Callback bodies become plain async-effect blocks: they run, they may throw JS errors (which are logged and dropped), and that's it. Implementing guards as a runtime builtin (separate plan) lets us avoid the entire callback-interrupt control-flow path.

**Preserve untouched:** the interrupt mechanism for ordinary user code in nodes and functions, including all the substep counter machinery (`__substep_K`, `__condbranch_K`, `__iteration_K`), the concurrent-interrupt primitives (`runBatch`, fork/race/parallel-tools), the leaf-stamping `interruptReturn` / `interruptAssignment` templates, `interruptWithHandlers`, `respondToInterrupts`, `handle` blocks, scoped callback collection, `PromptRunner` substep idempotency, and `BranchRunner` per-branch substep idempotency.

**Reference docs (do not regress):**
- `docs/dev/interrupts.md` — substep counter system + the `Runner.hook` section that this plan rewrites.
- `docs/dev/concurrent-interrupts.md` — `runBatch`, slice-only checkpoint composition, BranchState invariants 1–10.

---

## What must absolutely keep working after this plan

| Capability | Tested by | Files that own it |
| --- | --- | --- |
| `interrupt myapp::foo(...)` inside a node body (envelope shape) | `tests/agency/interrupts/*`, `tests/agency-js/interrupts/*` | `interruptReturn.mustache`, `interruptAssignment.mustache` (`{{#nodeContext}}` branch), `interruptWithHandlers`, `respondToInterrupts` |
| `interrupt myapp::foo(...)` inside a function body (bare shape) | `tests/agency-js/interrupts/*` | Same templates (`{{^nodeContext}}` branch) |
| `handle` blocks intercepting interrupts | `tests/agency/handlers/*` | Handler stack on `__ctx.handlers`, `pushHandler` / `popHandler` |
| Substep resume inside if/else/while/for/match/thread | `tests/agency/substeps/*` | `TsIfSteps`, `TsForSteps`, `TsWhileSteps`, `TsThreadSteps`, `clearLocalsWithPrefix` |
| Fork batched interrupts | `tests/agency/fork/*` | `runBatch` mode `"all"`, `Runner.runForkAll` |
| Race + abort signal cascade | `tests/agency/fork/race/*` | `runBatch` mode `"race"`, `raceWinnerLocalKey: __race_winner_<id>` |
| Parallel tool calls + multi-tool interrupt batching | `tests/agency/fork/llm-tools/*` | `PromptRunner.parallel`, `BranchRunner`, `recordBranchOutcomes: false` |
| Scoped callback registration via `callback("onX") as data { … }` | `tests/agency/callback-*` (the non-interrupt ones) | Callback lifting pass, `stack.collectScopedCallbacks`, `gatherCallbacks` |
| Global hooks via `registerGlobalHook` | (no fixture; manual) | `_globalHooks` registry in `hooks.ts` |
| Recursion guard for callback re-entry | `tests/agency/callback-recursion` | `_activeCallbacksALS` in `hooks.ts` |

If any of these regress at any point during this plan, stop and diagnose — the deletion went too far.

**Tech Stack:** Mostly TypeScript runtime (`lib/runtime/hooks.ts`, `runner.ts`, `prompt.ts`, `promptRunner.ts`). One typechecker rule (`lib/typechecker/`). No changes to the interrupt codegen templates.

---

## Task 1: Add typechecker rule — `interrupt` not allowed in callback bodies

**Files:**
- Modify: `lib/typechecker/` (find the AST walker that visits function/callback bodies)
- Create: `tests/typechecker/interrupt-in-callback-rejected.test.ts` (or extend an existing typechecker test file)

This is the gate that replaces the runtime feature. Once `interrupt` statements are statically forbidden inside callback bodies, the runtime can stop trying to support them.

- [ ] **Step 1: Locate the visitor**

The callback-lifting pass turns `callback("onX") as data { ... }` into a top-level AgencyFunction. Find where that lifted function's body is type-checked (or where the original `callback(...)` statement is parsed before lifting). Either point works — pre-lift is cleaner because the error message can reference the original `callback(...)` location.

- [ ] **Step 2: Walk the body for `interrupt` statements / expressions**

Both forms must be rejected:
- Statement: `interrupt myapp::foo("msg", {})`
- Assignment: `const x = interrupt myapp::foo("msg", {})`

Surface an error like:
```
error: `interrupt` is not allowed inside a callback body.
  Callbacks fire as side effects; their body cannot pause execution
  to ask the user a question. Move the `interrupt` into the
  calling node/function instead, or use a runtime guard
  (std::thread::guard) if you wanted budget enforcement.
```

Include the source location of the offending `interrupt`.

- [ ] **Step 3: Test fixture(s)**

Create at least:
- `interrupt` in `onLLMCallStart` body — rejected with clear error.
- `interrupt` in `onToolCallStart` body — rejected.
- `interrupt` inside an `if` branch inside a callback body — still rejected (visitor must recurse).
- Negative control: `interrupt` inside a regular function/node — still accepted.

- [ ] **Step 4: Run typechecker tests**

```bash
pnpm test:run -- typechecker > /tmp/tc.log 2>&1
```

- [ ] **Step 5: Commit**

---

## Task 2: Strip `CallbackOutcome` and revert hooks.ts to `Promise<void>`

**Files:**
- Modify: `lib/runtime/hooks.ts`
- Modify: `lib/runtime/hooks.test.ts`

- [ ] **Step 1: Revert return types**

| Function | Before | After |
| --- | --- | --- |
| `invokeCallback` | `Promise<CallbackOutcome>` | `Promise<void>` |
| `fireWithGuard` | `Promise<CallbackOutcome>` | `Promise<void>` |
| `invokeCallbacks` | `Promise<CallbackOutcome>` | `Promise<void>` |
| `callHook` | `Promise<CallbackOutcome>` | `Promise<void>` |
| `invokeOneCallback` | `Promise<CallbackOutcome>` | — (delete) |
| `callHookAndDrop` | wraps callHook + logs drops | — (delete; every site just calls `callHook`) |
| `fireGlobalHooks` | `Promise<void>` | unchanged or fold into `invokeCallbacks` |

- [ ] **Step 2: Delete `CallbackOutcome`, `extractCallbackFailure`**

These exist solely to convey callback-raised interrupts/failures back to call sites. With Task 1's rule, the data flow they implement is impossible.

- [ ] **Step 3: Delete the `onAgentStart`/`onAgentEnd` defensive throw**

The "cannot raise interrupts" defensive check in `invokeCallbacks` was specific to the case where a user accidentally registered an interrupt-raising callback on a top-level hook. After Task 1, that case is caught at typecheck time, so the runtime throw is dead.

- [ ] **Step 4: Keep these pieces of `hooks.ts` intact**

- `_activeCallbacksALS` recursion guard (still needed; nothing about it depends on interrupt propagation).
- `_globalHooks` registry + `registerGlobalHook` export.
- `gatherCallbacks` (still walks stack-scoped + top-level + TS-passed in fire order).
- The "stateStack-supplied vs default ctx.stateStack" distinction in `invokeCallbacks` — fire-site code in `prompt.ts` still wants to fire onto a branch stack so scoped callbacks registered inside a branch's frame chain are found.

- [ ] **Step 5: Update `hooks.test.ts`**

Delete cases that exercise the tagged-union return shape. Keep cases that test recursion guard, gatherCallbacks ordering, global-hook registration, and the stateStack-vs-default distinction. Probably halves the file.

- [ ] **Step 6: Build & run hook tests**

```bash
make
pnpm test:run -- hooks > /tmp/hooks.log 2>&1
```

- [ ] **Step 7: Commit**

---

## Task 3: Revert `Runner.hook` to plain `await callHook(...)`

**Files:**
- Modify: `lib/runtime/runner.ts`
- Modify: `docs/dev/interrupts.md` — the "Callback hook firing" section needs to be rewritten or deleted.

`Runner.hook`'s only reason to exist as a specialized substep was to halt the runner when a callback raised interrupts. Without that, codegen sites can fire hooks inline.

- [ ] **Step 1: Find every codegen-emitted `runner.hook(...)` call**

```bash
rg "runner\.hook\(" lib/templates lib/backends lib/codegenBuiltins
```

- [ ] **Step 2: Replace each emitted call**

Either:
- (a) Emit `await callHook({ ctx: __ctx, name: "...", data: { ... } });` directly at the call site. Simpler; no substep counter advancement, which is fine because the call doesn't checkpoint.
- (b) Keep a thin wrapper `Runner.hook` whose body is just `await callHook(...)` — useful only if the codegen would otherwise be uglier.

Pick whichever produces the cleaner generated code. Probably (a) for `onNodeStart` / `onFunctionStart` / `onNodeEnd` / `onFunctionEnd` / `onEmit`.

- [ ] **Step 3: Remove `Runner.hook` method**

Once nothing references it, delete it from `runner.ts`. Also delete any `runBatch`-with-per-callback-children plumbing that exists only to support `Runner.hook` (the `"sequential"` mode usage that came from this — but **double-check this isn't used by anything else first**; `runBatch` itself stays).

- [ ] **Step 4: Rewrite or delete the "Callback hook firing" section in `docs/dev/interrupts.md`**

The current text (lines 202–231) describes substep-counter resume-skipping for callback interrupts. Replace with a one-paragraph note: "Codegen-emitted hook sites fire via inline `await callHook(...)`. Callback bodies cannot contain `interrupt` statements (enforced by the typechecker); a callback that throws a JS error is logged and dropped by `fireWithGuard`."

- [ ] **Step 5: Rebuild & verify**

```bash
make
pnpm test:run -- callback fork handler substep > /tmp/runner.log 2>&1
```

- [ ] **Step 6: Commit**

---

## Task 4: Revert PromptRunner LLM-hook plumbing + RunPromptResult failure variant

**Files:**
- Modify: `lib/runtime/promptRunner.ts`
- Modify: `lib/runtime/prompt.ts`

- [ ] **Step 1: Delete `pr.fireHook` (if it exists)**

It was added to give LLM-hook callbacks a substep-idempotent fire site that could halt `_runPrompt` on failure. With callback-interrupts gone, every `onLLMCallStart` / `onLLMCallEnd` call site reverts to plain `await callHook(...)`.

- [ ] **Step 2: Delete `RunPromptResult.failure` variant**

The tagged union goes back to:
```ts
export type RunPromptResult =
  | { kind: "ok"; messages: MessageThread; toolCalls: ToolCallJSON[] }
  | { kind: "interrupt"; interrupts: Interrupt[] };
```

The `interrupt` variant stays — that's how `runPrompt` surfaces multi-tool batched interrupts to its caller. Per `concurrent-interrupts.md` lines 162–203, the parallel-tool path returns `runBatch`'s `kind: "interrupts"` shape up through `_runPrompt`'s result, and that's load-bearing for resume.

- [ ] **Step 3: Delete the `llmFailure` stash**

The local in `runPrompt` that held a failure between substeps disappears with the `failure` variant.

- [ ] **Step 4: Keep `PromptRunner.step` and `PromptRunner.parallel` unchanged**

`pr.step` is still used for substep idempotency around user-level mutations (`messages.push`, token-stat updates, etc.) — that's unrelated to callbacks. `pr.parallel` is the runBatch adapter for tool branches.

- [ ] **Step 5: Keep `BranchRunner` unchanged**

Per `concurrent-interrupts.md` lines 173–203, `BranchRunner.step` collects interrupts on `b.interrupts` rather than throwing. That's for **tool-body interrupts** (a tool implementation calling `interrupt`), not for callback-body interrupts. With Task 1 in place, tool bodies can still interrupt; callbacks cannot.

- [ ] **Step 6: Audit the `messages.setMessages(slice(0, lenBefore))` revert patterns**

PR #189 added these inside some `pr.step` bodies to keep `messages.push` idempotent when a callback-interrupt would cause the step to re-run. With callback-interrupts gone, audit each one:
- If the only reason it was added was to handle callback-raised interrupts inside the step → revert.
- If it also handles a real user-code interrupt path → keep.

Run `git log -p lib/runtime/prompt.ts` for PR #189's commits to see which lines were added; cross-reference each with the substep boundaries.

- [ ] **Step 7: Revert `_runPrompt`'s `pr` + `keyPrefix` parameter expansion, IF you're not pursuing the end-hook substep split independently**

The "split `_runPrompt` into `.start`/`.api`/`.end` substeps" work in `docs/superpowers/plans/2026-05-23-callback-end-hook-substep-completion.md` was only a blocker for callback-driven guards. With builtin guards, the end-hook re-spend bug is no longer user-facing for guards. Decide:
- (a) Drop the partial refactor. Revert `_runPrompt`'s signature to pre-PR-#189. Delete the linked plan doc.
- (b) Keep the partial refactor and ship the full end-hook split for non-guard reasons (e.g., users registering their own `onLLMCallEnd` callbacks via TS).

Default: (a) unless someone has a real use case for (b).

- [ ] **Step 8: Build & test**

```bash
make
pnpm test:run -- prompt promptRunner > /tmp/prompt.log 2>&1
```

- [ ] **Step 9: Commit**

---

## Task 5: Delete obsolete fixtures and plan docs

**Files to delete:**

Fixtures (whole pairs of `.agency` + `.test.json`):
- `tests/agency/callback-rejection-halts-function.*`
- `tests/agency/callback-rejection-aborts-llm.*`
- `tests/agency/guard-cost-reject.*` (if present)
- `tests/agency/onllmcallend-interrupt-no-rerun.*` (if present — it was the end-hook substep fixture)
- The `multi-tool-callback-interrupts-*` family (whichever ones exist in `tests/agency/fork/llm-tools/` or wherever; these codified the buggy "rejection silently dropped" behavior)

Plan docs:
- `docs/superpowers/plans/2026-05-23-callback-rejection-propagation.md`
- `docs/superpowers/plans/2026-05-23-callback-end-hook-substep-completion.md` (delete unless Task 4 step 7 went path (b))
- `docs/superpowers/plans/2026-05-23-guard-statestack-architecture.md` (PFA-bound state across serialize/deserialize — was scoped to making callback-driven guards work; replace with whatever StateStack changes the builtin-guard design needs in a NEW plan)
- Any older `2026-05-22-callback-interrupts-*` phase plans that are now historical (move to an `archive/` subdir rather than delete if you want to keep the history searchable)

Spec to update or replace:
- `docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md` — already the spec for builtin guards. Stays; will be the source of truth for the next plan.

- [ ] **Step 1: Delete fixtures**
- [ ] **Step 2: Delete plan docs** (or move to `archive/`)
- [ ] **Step 3: `rg "callback-rejection" docs/ lib/ tests/`** — confirm no stragglers reference the deleted material
- [ ] **Step 4: Commit**

---

## Task 6: Codegen template audit

**Files to read (and confirm NOT changed):**
- `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`
- `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache`

These two templates emit the leaf interrupt sites for ordinary user code. They have a `{{#nodeContext}}` / `{{^nodeContext}}` split because a node returns `{ messages, data }` while a function returns the bare value — that has **nothing** to do with callbacks and stays.

- [ ] **Step 1: Re-read both templates**

Confirm every branch is still load-bearing:
- The `__response.type === "approve"` path is for `respondToInterrupts({ type: "approve" })`.
- The `__response.type === "reject"` path is for `respondToInterrupts({ type: "reject" })` — the halt-on-reject for ordinary user-code interrupts.
- The `interruptWithHandlers` + `isRejected` path is for handler-rejected interrupts.
- The unhandled-propagation path stamps the leaf checkpoint per `concurrent-interrupts.md` invariant 2 and surfaces the interrupt array up the call stack.

All four paths exist for ordinary user interrupts. None of them are callback-specific. Templates stay unchanged.

- [ ] **Step 2: Check the callback-lifting pass**

The pass that lifts `callback("onX") as data { ... }` to top-level. Depending on how it works:
- If it lifts to an AgencyFunction with full Runner machinery: that's now overkill — but it's not harmful. The Runner just never sees an interrupt because the typechecker forbade them. Decide whether to simplify to a plain async function (smaller generated code; possibly worth a follow-up) or leave as-is (zero risk).
- If it lifts to a plain async closure: nothing to change.

Recommend leaving as-is for this plan; simplification is a separate cleanup.

- [ ] **Step 3: `rg "callback" lib/templates/backends/typescriptGenerator/`** — confirm no template branches reference callback-specific logic.

---

## Task 7: Regression sweep

- [ ] **Step 1: Run every category listed in the "must keep working" table**

```bash
pnpm test:run -- \
  interrupts handlers substeps fork race \
  llm-tools callback prompt promptRunner runBatch \
  hooks runner > /tmp/regression.log 2>&1
```

(`pnpm test:run -- <pattern>` is a name-match; the above hits the major fixture directories.)

- [ ] **Step 2: Run integration tests for substep blocks**

```bash
pnpm test:run -- substeps > /tmp/substeps.log 2>&1
```

Specifically verify that if/else/while/for/match/thread interrupt-resume still works (invariants 1, 4 from `concurrent-interrupts.md`; the entire "How substeps work" body of `interrupts.md`).

- [ ] **Step 3: Run the deepest fork+tool composition test**

`tests/agency/fork/fork-llm-tool-nested.test.json` — the regression test for the slice-only capture fix. Per `concurrent-interrupts.md` invariant 1, this must still pass after any change in this area.

- [ ] **Step 4: Run the runBatch unit tests**

```bash
pnpm test:run -- runBatch > /tmp/runBatch.log 2>&1
```

All 19 cases in `lib/runtime/runBatch.test.ts` must pass — those cover the modes, cached short-circuit, abort propagation, race-resume dispatch.

- [ ] **Step 5: Structural lint**

```bash
pnpm run lint:structure
```

- [ ] **Step 6: `make`**

- [ ] **Step 7: Commit**

---

## Task 8: Documentation

**Files:**
- Modify: `docs/dev/interrupts.md` — rewrite the "Callback hook firing" section (done in Task 3 step 4).
- Modify: `docs/site/appendix/callbacks.md` — remove any text describing how to raise interrupts from callbacks. Add a brief note that `interrupt` is statically forbidden inside callback bodies and why.
- Modify: `docs/site/guide/` — any guide pages that mention callback-raised interrupts.
- Add: `CHANGELOG.md` entry — breaking change for any user that relied on the (broken) callback-interrupt behavior.

- [ ] **Step 1: Audit**

```bash
rg -i "interrupt.*callback|callback.*interrupt" docs/
```

- [ ] **Step 2: Update each hit per the above guidance**
- [ ] **Step 3: Commit**

---

## Validation checklist

- [ ] Typechecker rejects `interrupt` statements inside callback bodies with a clear error pointing at the source location.
- [ ] `interrupt` inside ordinary nodes/functions still works for both envelope (`{ messages, data }`) and bare-failure shapes.
- [ ] `respondToInterrupts({ type: "approve" | "reject" | "modify" | "resolve" })` still drives resumes correctly via the unchanged `interruptReturn` / `interruptAssignment` templates.
- [ ] `handle` blocks still catch interrupts as before.
- [ ] Substep counter resume (`__substep_K`, `__condbranch_K`, `__iteration_K`) works for if/else, while, for, match, thread.
- [ ] Fork + multi-cycle resume work (`tests/agency/fork/fork-multi-cycle-interrupt`).
- [ ] Race + abort cascade work (`tests/agency/fork/race/*`).
- [ ] Parallel multi-tool batched interrupts work (`tests/agency/fork/llm-tools/multi-tool-{all-interrupt,mixed,multi-cycle}`).
- [ ] Deepest nested case works (`tests/agency/fork/fork-llm-tool-nested`).
- [ ] Scoped `callback("onX") as data { ... }` still fires correctly for all hook categories (just can't interrupt).
- [ ] Global `registerGlobalHook` still fires.
- [ ] Recursion guard still prevents callback re-entry (`tests/agency/callback-recursion`).
- [ ] No references to `CallbackOutcome`, `extractCallbackFailure`, `callHookAndDrop`, `pr.fireHook`, `Runner.hook` remain.
- [ ] `make` and `pnpm run lint:structure` clean.

---

## Risks and dependencies

- **`Runner.hook` removal touches multiple codegen sites.** Re-grep after the change to confirm no template still emits a call to a method that no longer exists. The build will catch this if the templates are recompiled (`pnpm run templates`), but the fixture build (`make fixtures`) is the surer signal.

- **`messages.setMessages(slice(0, lenBefore))` reverts in `prompt.ts`** (Task 4 Step 6) — be conservative. If you're unsure whether a revert pattern was added for a callback-interrupt reason or a real user-code reason, leave it. False positives from the revert (the runtime is more cautious than needed) are harmless; false negatives (deleting a real bugfix) break user-visible behavior.

- **Callback-lifting pass left as-is.** Task 6 Step 2 explicitly recommends not simplifying it. If reviewing this plan you want to also simplify, treat that as a separate follow-up plan — bundling it here makes the diff harder to review.

- **`docs/dev/interrupts.md` substep documentation must NOT be touched** except for the "Callback hook firing" section. The substep counter system applies to ordinary user code and stays the same.

- **`concurrent-interrupts.md` is fully preserved.** Nothing in this plan touches `runBatch`, BranchState, the slice rule, the leaf-stamping templates, or any of the 10 invariants in that doc.

- **Branch hygiene.** Recommend starting a fresh branch from `main` and re-applying the keep-list (PromptRunner.step/parallel, BranchRunner, scoped-callback machinery — whichever of these aren't already in `main`) rather than reverting on the existing PR #189 branch. The revert diff will be larger than just re-deriving the keep-list from scratch.

- **PR #189 disposition.** Close (don't merge) with a comment pointing at this plan and the (forthcoming) builtin-guards plan, so the history is clear.

- **CHANGELOG breaking-change entry.** Any external user who wrote `callback("onX") as data { interrupt ... }` will hit a typechecker error. They get a clear message; document the workaround (move the interrupt into the calling node, or use `guard()`).
