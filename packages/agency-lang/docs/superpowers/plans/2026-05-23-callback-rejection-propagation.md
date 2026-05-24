# Callback Rejection Propagation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

> **Implementation status (2026-05-23):** Tasks 1–3 done. Codegen-emitted hook sites (`onNodeStart` / `onNodeEnd` / `onFunctionStart` / `onFunctionEnd`) now correctly halt the enclosing runner with the failure when a callback's interrupt is rejected. The `tests/agency/callback-rejection-halts-function` fixture covers this.
>
> Tasks 4–5 (LLM and tool runtime call sites) are implemented in `hooks.ts`/`prompt.ts` (the `CallbackOutcome.kind === "failure"` path propagates through `_runPrompt` → `runPrompt` → `llm()` site), but cannot be end-to-end tested yet: those sites resume across `callHook` (not `Runner.hook`), and the resume mechanism doesn't preserve the callback frame on the deserialize queue (the `pr.step` outer checkpoint stamp overwrites the callback's own checkpoint at `promptRunner.ts` L100‑115). On resume the callback re-enters with a fresh frame, doesn't find its saved `__interruptId_N`, and raises a brand-new interrupt instead of consuming the saved reject response. The LLM-rejection fixture this plan originally wrote (`callback-rejection-aborts-llm`) hits exactly this and was removed pending a fix to bug #1 (`docs/superpowers/plans/2026-05-23-callback-end-hook-substep-completion.md`) plus a complementary fix for callback-frame restoration on the callHook path. Once both land, that fixture can be re-added.

**Goal:** When a callback body raises an `interrupt` and the user **rejects** it, the rejection must reach the call site that fired the callback and produce a sensible effect there (abort the LLM call, signal the tool as rejected, halt the enclosing function/node, etc.). Today the rejection is silently dropped — the callback returns, the caller sees `undefined`, execution continues as if approved.

**Surfaced by:** the in-tree `guard()` stdlib function. When the user rejects the `std::guard_exceeded` interrupt, the `__guardCheck` callback halts internally with a `failure(...)` value, but `runPrompt` never sees it — the LLM call keeps running and `block()` returns the LLM's answer instead of a failure.

---

## How rejection flows today (corrected from the previous plan draft)

1. Agency code: `interrupt myapp::foo("msg", {})` inside a callback body.
2. Codegen template ([interruptReturn.mustache L6-12](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/templates/backends/typescriptGenerator/interruptReturn.mustache#L6-L12), [interruptAssignment.mustache L10-15](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/templates/backends/typescriptGenerator/interruptAssignment.mustache)) translates that to a call to `interruptWithHandlers(...)`, then dispatches on the result:
   ```ts
   if (__response.type === "approve") { /* use value */ }
   else if (__response.type === "reject") {
     runner.halt(failure("interrupt rejected", { retryable: false, checkpoint: ... }));
     return;
   }
   // else propagated → runner.halt with the interrupts
   ```
3. The callback's `AgencyFunction.invoke(...)` returns `runner.haltResult` — a `Failure` object — when the user rejected.
4. In [hooks.ts L141-159](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/hooks.ts#L141-L159), `invokeCallback` checks ONLY `hasInterrupts(result)`. A `Failure` isn't an interrupt array, so the function returns `undefined` and the rejection vanishes.

So the bug is structural: `interruptWithHandlers` itself can return a `Rejected` (as it does for tool calls — see [prompt.ts L534-547](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/prompt.ts#L534-L547)), but agency-level codegen wraps that into a `Failure` before the runtime can see it. The fix lives at the call-site level — each `callHook` / `invokeCallbacks` consumer needs to recognise the `Failure` return and decide what rejection means there.

Pattern analog from tools: when a TOOL's invoke returns a `Rejected` (e.g. via policy, or by the tool body literally calling `reject(...)`), `runInvokeStep` does:
```ts
if (isRejected(toolResult)) {
  messages.push(smoltalk.toolMessage(rejection.value, { tool_call_id, name }));
  stack.deleteBranch(branchKey);
  return { invokeOutcome: "rejected" };
}
```
We need the same shape but driven off `isFailure(callbackResult)` for callbacks.

**Tech Stack:** TypeScript runtime — `lib/runtime/hooks.ts`, `lib/runtime/prompt.ts`, `lib/runtime/runner.ts`. No codegen / template changes.

---

### Task 1: Failing fixtures (one per call-site category)

Three categories of callback fire site, each with its own "rejection means X" interpretation:

| Category                       | Hooks                                                 | Rejection means…                         | Failing fixture                                  |
| ------------------------------ | ----------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| Runner.hook (codegen)          | onNodeStart, onNodeEnd, onFunctionStart, onFunctionEnd | halt enclosing function/node with the failure | `callback-rejection-halts-function`              |
| LLM hooks (runtime)            | onLLMCallStart, onLLMCallEnd                          | abort `runPrompt` with the failure       | `callback-rejection-aborts-llm`                  |
| Tool hooks (runtime, per-branch) | onToolCallStart, onToolCallEnd                       | route through existing `isRejected` tool path | `callback-rejection-rejects-tool-call`           |

- [ ] **Step 1: Function/node rejection fixture**

`tests/agency/callback-rejection-halts-function.agency`:
```
let bodyContinued: boolean = false

callback("onNodeStart") as data {
  interrupt myapp::abort("really continue?", {})
}

node main() {
  bodyContinued = true
  return "should not reach here"
}
```
`.test.json` supplies `{"action": "reject"}`. Expected: the run halts; `bodyContinued == false`. Today: `bodyContinued == true`.

- [ ] **Step 2: LLM rejection fixture (via guard-cost-reject)**

`tests/agency/guard-cost-reject.agency`:
```
node main() {
  const result: string = guard(0.0000001) as {
    const reply: string = llm("Reply with the single word: pong")
    return reply
  }
  return result
}
```
`.test.json` rejects the first `std::guard_exceeded` interrupt. Expected: `main()` returns a failure (`isFailure(expectedOutput) == true`) carrying the rejection reason. Today: returns the LLM's "pong" reply, ignoring the rejection.

- [ ] **Step 3: Tool rejection fixture**

`tests/agency/callback-rejection-rejects-tool-call.agency`:
```
def someTool(x: number): string {
  return "tool ran: " + x
}

callback("onToolCallStart") as data {
  interrupt myapp::approve_tool("allow?", {toolName: data.toolName})
}

node main() {
  return llm("Call someTool with x=1", tools=[someTool])
}
```
Test driver rejects the `approve_tool` interrupt. Expected: the assistant message includes a `toolMessage` of "tool rejected by policy" (or the rejection's value) instead of the tool's real output; `someTool` is never invoked. Today: the callback's rejection vanishes, the tool runs normally.

- [ ] **Step 4: Confirm all three fail**

```bash
for f in callback-rejection-halts-function guard-cost-reject callback-rejection-rejects-tool-call; do
  pnpm run agency test tests/agency/$f.agency >> /tmp/cb-reject.log 2>&1
done
```

- [ ] **Step 5: Commit**

---

### Task 2: Tagged-union return type for callback results

**Files:**
- Modify: `lib/runtime/hooks.ts`

Replace the current `Promise<Interrupt[] | undefined>` return shape with a tagged union that distinguishes success / interrupts / failure. The change is internal to `hooks.ts` plus its callers.

- [ ] **Step 1: New type**

```ts
export type CallbackOutcome =
  | { kind: "ok" }
  | { kind: "interrupts"; interrupts: Interrupt[] }
  | { kind: "failure"; failure: ResultFailure };
```

(Use the existing `ResultFailure` type from `lib/runtime/result.ts`.)

- [ ] **Step 2: Update `invokeCallback`**

```ts
async function invokeCallback(...): Promise<CallbackOutcome> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    const result = await (fn as AgencyFunction).invoke(...);
    if (hasInterrupts(result)) return { kind: "interrupts", interrupts: result };
    if (isFailure(result))    return { kind: "failure", failure: result };
    return { kind: "ok" };
  }
  // Plain JS callback — no interrupt/failure mechanism. fn might throw, which
  // fireWithGuard catches and logs; on normal return we always get "ok".
  await fn(data);
  return { kind: "ok" };
}
```

NOTE: there's a wrinkle for `onNodeStart` (and other node-context hooks). The codegen halts the runner with `{ messages: __threads, data: failure(...) }` (the node return-shape envelope), not the bare failure. So `invokeCallback` needs to peel the envelope when `fn.scopeName` is a node-context callback. Simplest: in `invokeCallback`, after getting `result`, also check `isFailure(result?.data)` and surface that. Verify shape with the function/node fixture.

- [ ] **Step 3: Update `fireWithGuard`, `invokeOneCallback`, `invokeCallbacks`, `callHook`**

All four return `Promise<CallbackOutcome>`. `invokeCallbacks` (which fires multiple callbacks in sequence) collects interrupts across siblings as today and folds in failures with "first failure wins, later callbacks skipped" semantics — matching how JS errors short-circuit a `Runner.step` body.

```ts
const collected: Interrupt[] = [];
for (const fn of gatherCallbacks(...)) {
  const outcome = await fireWithGuard(fn, data, ctx, name, stateStack);
  if (outcome.kind === "failure") return outcome;          // first failure wins
  if (outcome.kind === "interrupts") collected.push(...outcome.interrupts);
}
return collected.length > 0
  ? { kind: "interrupts", interrupts: collected }
  : { kind: "ok" };
```

- [ ] **Step 4: Update `callHookAndDrop`**

Stays log-and-drop for failures too (top-level callbacks have no caller to halt — same fundamental limitation as for interrupts).

---

### Task 3: Wire `Runner.hook` to halt on callback failure

**Files:**
- Modify: `lib/runtime/runner.ts`
- Possibly: `lib/runtime/runBatch.ts` if the runBatch-driven path needs a corresponding leaf-return tweak.

This handles the FIRST category — codegen-emitted hook sites (`onNodeStart`, `onNodeEnd`, `onFunctionStart`, `onFunctionEnd`).

- [ ] **Step 1: Read `Runner.hook` and its runBatch path**

Find the place where `invokeOneCallback`'s return is currently inspected. It's wrapped in a `runBatch` child invoke that previously returned `Interrupt[] | undefined`.

- [ ] **Step 2: On `{ kind: "failure" }`, halt the runner**

```ts
const outcome = await invokeOneCallback({ ctx, fn, name, data, stateStack });
if (outcome.kind === "failure") return outcome.failure;   // returned to runBatch invoke
```

The surrounding `Runner.hook` checks the runBatch result; if it's a failure, halts via `this.halt(failure)`. The next user-code generated step sees `runner.halted` and returns `runner.haltResult` — propagating the failure up the call stack via the function's existing return-value convention.

For node-context callbacks, halt with the node envelope shape: `this.halt({ messages: this.frame.threads, data: failure })`. Mirrors what the codegen template's reject branch does for the callback itself.

- [ ] **Step 3: Verify the function/node rejection fixture passes**

```bash
pnpm run agency test tests/agency/callback-rejection-halts-function.agency
```

---

### Task 4: Wire `runPrompt` to abort on LLM callback failure

**Files:**
- Modify: `lib/runtime/prompt.ts` (the `onLLMCallStart` / `onLLMCallEnd` fire sites inside `_runPrompt`)

This handles the SECOND category. Depends on Task 2 having changed `callHook`'s signature.

- [ ] **Step 1: Read the fire sites**

Today:
```ts
const startInterrupts = await callHook({ ctx, name: "onLLMCallStart", data: ... });
if (startInterrupts) return { kind: "interrupt", interrupts: startInterrupts };
```

After Task 2, `callHook` returns a `CallbackOutcome`. Update:
```ts
const startOutcome = await callHook({ ctx, name: "onLLMCallStart", data: ... });
if (startOutcome.kind === "interrupts") return { kind: "interrupt", interrupts: startOutcome.interrupts };
if (startOutcome.kind === "failure")    return { kind: "failure", failure: startOutcome.failure };
```

- [ ] **Step 2: Extend `RunPromptResult` with a failure variant**

```ts
export type RunPromptResult =
  | { kind: "ok"; messages: MessageThread; toolCalls: ToolCallJSON[] }
  | { kind: "interrupt"; interrupts: Interrupt[] }
  | { kind: "failure"; failure: ResultFailure };
```

- [ ] **Step 3: `runPrompt`'s outer try handles the failure**

When `_runPrompt` returns `{ kind: "failure", failure }`, `runPrompt` returns the failure. The `llm()` call site (in user code) receives a `Failure` value just as if any other function had returned one — falls through to user `handle` blocks or surfaces up.

- [ ] **Step 4: Same wiring for the end-hook**

If the `onLLMCallEnd` substep split from `docs/superpowers/plans/2026-05-23-callback-end-hook-substep-completion.md` has already shipped, the `.end` `pr.step` body needs to return a failure and `runPrompt`'s caller of `_runPrompt` propagates it. If that plan hasn't shipped yet, do it in the current single-step body.

- [ ] **Step 5: Verify the LLM rejection fixture passes**

```bash
pnpm run agency test tests/agency/guard-cost-reject.agency
```

---

### Task 5: Wire tool callbacks through the existing `isRejected` rail

**Files:**
- Modify: `lib/runtime/prompt.ts` (`onToolCallStart` / `onToolCallEnd` fire sites inside the per-tool branchFn)

This handles the THIRD category. Closest in shape to the tool-body rejection path already at L534-547.

- [ ] **Step 1: `onToolCallStart` rejection**

Current:
```ts
await b.step(`round.${round}.tool.${toolCall.id}.start`, async () =>
  await invokeCallbacks({ ctx, name: "onToolCallStart", data: ..., stateStack: branchStack }),
);
if (b.interrupts) return;
```

After: `invokeCallbacks` now returns a `CallbackOutcome`. If `kind === "failure"`, the tool branch should treat it like a rejection — push a `toolMessage` containing the failure's reason, clean up the branch, skip the invoke / end-hook / log steps. Concretely:
```ts
const startOutcome = await invokeCallbacks({ ... });
if (startOutcome.kind === "interrupts") {
  // BranchRunner needs an explicit "halt with these interrupts" path —
  // today b.step does this implicitly; keep using b.step but pass the
  // interrupts through.
  // (See Task 6 risk note on adapter shape.)
  return;
}
if (startOutcome.kind === "failure") {
  messages.push(smoltalk.toolMessage(
    startOutcome.failure.error ?? "Tool rejected by callback",
    { tool_call_id: toolCall.id, name: toolCall.name },
  ));
  stack.deleteBranch(branchKey);
  return;
}
```

- [ ] **Step 2: `onToolCallEnd` rejection**

Trickier because the tool ALREADY RAN by the time the end-hook fires. Two options:

  (a) Treat the rejection as a hard error retroactively — overwrite the success `toolMessage` with the rejection message. Risk: the side effects the tool performed (file writes, API calls) cannot be rolled back, but the LLM sees a clean "rejected" view. This matches the symmetric option for `onLLMCallEnd` — the rejection makes the operation's RESULT invalid even though the work happened.

  (b) Surface the rejection as a halt of the whole tool round — abort the parallel batch with the failure, propagate up to `runPrompt`. More disruptive but more honest.

Recommended: (a) for tool end-hooks. Add a comment that side effects are not rolled back.

- [ ] **Step 3: Verify the tool rejection fixture passes**

```bash
pnpm run agency test tests/agency/callback-rejection-rejects-tool-call.agency
```

---

### Task 6: Broader regression sweep

- [ ] **Step 1: Run the whole callback fixture family**

```bash
pnpm test:run -- callback fork llm-tools memory guard > /tmp/cb-reject-regr.log 2>&1
```

Watch for: existing "rejection silently no-ops" tests that now correctly fail (some might exist that codified the buggy behavior — those need to be updated, not papered over). No regressions in approve / propagate / resolve paths.

- [ ] **Step 2: `make` + `pnpm run lint:structure`**

- [ ] **Step 3: Commit**

---

### Task 7: Docs + cleanup

**Files:**
- Modify: `docs/dev/callback-hooks.md` (if exists) — document the rejection contract per category.
- Modify: `docs/site/appendix/callbacks.md` — per-hook table: what "reject" means at each site.
- Modify: `docs/superpowers/plans/2026-05-23-callback-end-hook-substep-completion.md` — cross-link.

---

### Validation checklist

- [ ] `callback-rejection-halts-function` passes; node body never executed past the rejecting callback.
- [ ] `guard-cost-reject` passes; `llm()` returns a `Failure`, `block()` surfaces it.
- [ ] `callback-rejection-rejects-tool-call` passes; tool body never invoked, LLM sees a rejection `toolMessage`.
- [ ] No regressions in the broader callback / fork-callback / memory / guard fixture families.
- [ ] `make` succeeds, `pnpm run lint:structure` clean.

---

### Risks and dependencies

- **Codegen produces `failure(...)` not `Rejected`** — the runtime check is `isFailure`, NOT `isRejected`. Easy mistake when copy-pasting from the tool-rejection rail. (Earlier draft of this plan misnamed the predicate.)

- **Node-context envelope shape** — `onNodeStart`/`onNodeEnd` callbacks halt with `{ messages, data: failure(...) }` not bare `failure(...)`. `invokeCallback` must peel the envelope or `Runner.hook` must wrap before halting; pick one and stay consistent.

- **`BranchRunner` rejection path** — `BranchRunner.step` today only knows about interrupts (`b.interrupts`). Adding a `b.failure` slot (or equivalent) keeps the parallel `pr.parallel` shape symmetric: callback-rejected branches don't block siblings, and the parallel orchestrator can fold rejections into per-branch `toolMessages` independently. Alternatively, treat callback failures inside a branch as immediate "halt this branch only" with no fancy batching. Recommend the simpler latter.

- **`onToolCallEnd` post-hoc rejection** — the tool already ran and may have side effects (file writes, API calls). Rejection at end-hook time only changes what the LLM sees, not what already happened. Documented in the appendix.

- **Backwards compatibility** — any existing user code that relied on rejection-as-no-op will start failing loudly. Note in CHANGELOG.

- **Top-level callbacks (`onAgentStart`/`onAgentEnd`)** — log + drop for failures too, same fundamental limitation as for interrupts (no surrounding frame). Document.

- **`runBatch` invoke contract** — `invoke` returns `T | Interrupt[]` today and MUST NOT throw. If `Runner.hook`'s runBatch child needs to return a failure, the return type widens to `T | Interrupt[] | Failure` — verify the runBatch processing logic handles the new shape, OR keep `invoke`'s contract intact by encoding the failure inside `T` (Runner.hook already knows the shape it expects).
