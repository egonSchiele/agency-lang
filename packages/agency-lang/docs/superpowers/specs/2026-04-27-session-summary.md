# Fork Parallel Interrupts — Session Summary

## Branch: `adit/parallel-interrupts`

## What we built

Fork threads that trigger interrupts now collect ALL unresolved interrupts (not just the first) and return them as an `Interrupt[]` batch. The TypeScript API uses `respondToInterrupts(interrupts, responses)` to resume all interrupted threads at once.

## Completed changes

### Core runtime
1. **`interruptId`** on `Interrupt` type — each interrupt gets a globally unique nanoid. Used to route responses back to the correct thread on resume.
2. **`BranchState.result`** — `{ result: any }` wrapper on branch state for caching completed fork thread results. Serialized/deserialized so it survives across multiple interrupt cycles.
3. **`hasInterrupts()`** — type guard for `Interrupt[]`. Validates every element (not just first).
4. **`RuntimeContext._interruptResponses`** — private field with `setInterruptResponses()` and `getInterruptResponse()` / `getInterruptData()` accessors. Stores both the response and interruptData per interrupt, keyed by interruptId. NOT serialized.
5. **`Runner.fork()`** — collects all interrupts from `Promise.allSettled`, caches completed thread results in `BranchState.result`, creates a shared checkpoint, stores interruptId on branches. Also handles nested fork interrupt arrays (flattens them).
6. **`respondToInterrupts()`** — new function. Builds ID-keyed response map, restores from shared checkpoint, sets responses on context, re-executes. For single-interrupt cases, also passes `interruptData` to `graph.run()` for backward compat with node transitions.
7. **`runNode`** — normalizes `result.data` to always be `Interrupt[]` (wraps single interrupts in array).

### Generated code changes
8. **`__stateStack` and `__isForked`** — passed through the entire function call chain. Every function call receives the parent's stateStack and isForked flag. Fork blocks set `__stateStack = __forkBranchStack` and `__isForked = true`. This ensures fork threads use branch stacks for ALL function calls within them (not ctx.stateStack). Nodes set `__stateStack = ctx.stateStack` and `__isForked = false`.
9. **Interrupt detection** — generated code uses `isInterrupt(x) || hasInterrupts(x)` for interrupt detection after function calls and fork calls. This dual check will be simplified to just `hasInterrupts(x)` after batch normalization.
10. **Fork block finally** — checks `isInterrupt(runner.haltResult) || hasInterrupts(runner.haltResult)` before deciding to pop the branch frame. Prevents frame loss for nested forks returning interrupt arrays.
11. **Interrupt templates** — `interruptReturn.mustache` and `interruptAssignment.mustache` store `interruptId` on frame BEFORE creating checkpoint (so it's captured in snapshot). On resume, look up response via `ctx.getInterruptResponse(__self.__interruptIdKey)` with fallback to `__state?.interruptData?.interruptResponse` for legacy non-fork path.

### Type unification
12. **Handler results unified with interrupt responses** — both now use `"approve"` / `"reject"` / `"propagate"` (was `"approved"` / `"rejected"` / `"propagated"` for handlers). No more `__handlerApprove` etc. — `approve()`, `reject()`, `propagate()` are used directly everywhere.

### Public API
13. **`approve(value?)`** and **`reject(value?)`** — exported from both compiled modules and `agency-lang/runtime`. Pure response constructors.
14. **`respondToInterrupts(interrupts, responses)`** — compiled module export wraps internal function with ctx.
15. **`hasInterrupts(data)`** — public type guard.
16. **`result.data`** is always `Interrupt[]` when interrupts occur.

### Evaluate templates
17. Updated to use `hasInterrupts`, `approve`, `reject`, `respondToInterrupts`. Support `resolve` action (maps to `approve(value)`). Removed `modify` action.

### Debugger
18. Driver unwraps interrupt arrays at the main loop entry point. Test helpers updated for `hasInterrupts`. Driver tests (37) skipped pending full migration.

### Prompt/tool calls
19. `executeToolCalls` in `prompt.ts` — partially updated to check `hasInterrupts(result)` for fork arrays from tool calls. Type `ExecuteToolCallsResult` still needs updating.

## Important invariants and guidelines

1. **ALL interrupts should be interrupt batches (`Interrupt[]`)**. A single interrupt is `[interrupt]`. The next phase (batch normalization) will make this universal. Until then, there's a dual representation with boundary patches.

2. **Handlers process one interrupt at a time**. `interruptWithHandlers` is called per-interrupt. Handler functions never see arrays.

3. **Debug interrupts are always single-element arrays**. Never multiple debug interrupts simultaneously.

4. **`isInterrupt` is becoming internal-only**. Users use `hasInterrupts`. `isInterrupt` stays for internal checks (inside `hasInterrupts`, handler result checking).

5. **`__stateStack` must propagate through all function calls**. Every `buildStateConfig` includes `stateStack: opts?.stateStack ?? ts.id("__stateStack")`. Fork blocks set it to `__forkBranchStack`. This prevents cross-thread frame corruption on the shared `ctx.stateStack`.

6. **`__isForked` must propagate through all function calls**. Prevents frame popping for functions called within fork threads. Their frames must survive for the checkpoint.

7. **`interruptId` must be stored on frame BEFORE checkpoint creation** in interrupt templates. Otherwise the checkpoint doesn't include it and resume can't find the response.

8. **`modify` response type is removed from the public API**. `resolve` maps to `approve(value)`.

9. **Never force push** (project rule from CLAUDE.md).

## Known skipped tests

- `lib/debugger/driver.test.ts` — 37 tests, needs debugger migration to new API
- `tests/agency/fork/race-interrupt` — race + interrupt resume needs work
- `tests/agency/fork/fork-after-node-transition` — fork interrupts after node transition
- `tests/agency/fork/fork-llm-tool-nested` — fork interrupts inside LLM tool calls
- `tests/agency/fork/fork-llm-deep-loop` — deep nesting of LLM + tool + fork + interrupt

## Remaining work (next session)

### Phase 1: Interrupt batch normalization
See `docs/superpowers/specs/2026-04-27-interrupt-batch-normalization.md` for full spec. Key changes:
- `interruptWithHandlers` returns `Interrupt[]` not `Interrupt`
- `debugStep` wraps in array
- `ExecuteToolCallsResult` uses `Interrupt[]`
- `executeToolCalls` unified to always return array
- `runPrompt` simplified (no array branching)
- Generated code simplified from `isInterrupt(x) || hasInterrupts(x)` to `hasInterrupts(x)`
- Remove all `if (isInterrupt(x)) { x = [x]; }` patches

### Phase 2: Remove old API (was Task 11)
- Remove `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`, `respondToInterrupt`
- Remove `InterruptModify`, `InterruptResolve` types
- Update debugger driver to use `respondToInterrupts`
- Clean up imports template

### Phase 3: Unskip tests
- Debugger driver tests
- Fork after node transition
- Fork inside LLM tool calls
- Race with interrupts

## Key files modified
- `lib/runtime/interrupts.ts` — core interrupt types, factories, `respondToInterrupts`
- `lib/runtime/runner.ts` — `Runner.fork()` collection logic
- `lib/runtime/node.ts` — `setupFunction` returns stateStack, `runNode` normalizes to array
- `lib/runtime/state/stateStack.ts` — `BranchState.result` field
- `lib/runtime/state/context.ts` — `_interruptResponses` field
- `lib/runtime/prompt.ts` — `executeToolCalls` partial update for arrays
- `lib/backends/typescriptBuilder.ts` — `buildStateConfig`, `setupEnv`, interrupt checks
- `lib/ir/builders.ts` — `setupEnv` and `functionCallConfig` updated for stateStack/isForked
- `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` — unified response lookup
- `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache` — same
- `lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache` — `__stateStack`, `__isForked`, frame pop guard
- `lib/templates/backends/typescriptGenerator/imports.mustache` — unified approve/reject, new exports
- `lib/templates/cli/evaluate.mustache` — batch interrupt handling
- `lib/templates/cli/judgeEvaluate.mustache` — same
- `lib/debugger/driver.ts` — array unwrapping at entry
