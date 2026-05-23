# End-Hook Callback Substep Completion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `onLLMCallEnd` interrupts in `runPrompt` resume WITHOUT re-running the LLM API call. After resume the user-supplied callback re-fires (giving the user another chance to approve), but the underlying `_runPrompt` work — the API request, the assistant message push, the token-stat update — happens exactly once.

**Surfaced by:** the `guard()` stdlib function. With a `$0.0000001` budget the first `llm()` call costs ~6e-6 and trips the callback's interrupt; on each resume the LLM call re-fires, adding another ~6e-6 of spend per cycle. Observed linearly: 6e-6 → 12e-6 → 18e-6 → 24e-6 → 30e-6 across five cycles.

---

## Root cause (revised — earlier draft of this plan misdiagnosed it)

The blame is NOT on the outer user-code `Runner.step` wrapping the `llm(...)` call site. That outer step *does* receive a `Promise<Interrupt[]>` return value, halts correctly, and writes its own counter correctly. The re-execution lives one frame deeper: inside `runPrompt`'s OWN substep machinery, implemented by `PromptRunner` in `lib/runtime/promptRunner.ts`.

Current shape of the LLM substep inside `runPrompt` ([prompt.ts L366-424](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/prompt.ts#L366-L424)):

```ts
await pr.step("initialLlmCall", async () => {
  const lenBefore = messages.getMessages().length;
  messages.push(smoltalk.userMessage(prompt));
  ...
  const result = await _runPrompt({ ctx, messages, ... });   // ← fires onLLMCallStart, calls API, pushes assistant msg,
                                                              //   updates token stats, runs memory hooks, fires onLLMCallEnd
  if (result.kind === "interrupt") {
    messages.setMessages(messages.getMessages().slice(0, lenBefore));   // ← REWIND
    closeLlmSpan();
    return result.interrupts;                                            // ← bail without marking step complete
  }
  ...
});
```

`PromptRunner.step` ([promptRunner.ts L92-128](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/promptRunner.ts#L92-L128)) deliberately does NOT push the key to `completedSteps` when the body returns interrupts — its design contract is "rewind to before this step on resume."

That contract was correct when the only interrupts that could surface inside a step were "before the work" hooks (`onLLMCallStart`). It is fatally wrong for `onLLMCallEnd`, which fires AFTER the LLM API call has already happened and been paid for. The body's `messages.setMessages(...slice(0, lenBefore))` then throws the assistant message on the floor too — completing the waste.

So the fix is to **split the single `initialLlmCall` substep into a sequence of finer-grained substeps**, each of which is small enough that the "rewind on interrupt" contract is correct for it:

```diagram
╭──────────────╮  ╭──────────────╮  ╭──────────────╮  ╭──────────────╮
│ .user        │→ │ .start       │→ │ .api         │→ │ .end         │
│ push user    │  │ onLLMCall    │  │ API call +   │  │ onLLMCall    │
│ + memory     │  │ Start hook   │  │ msg push +   │  │ End hook     │
│ injection    │  │              │  │ token stats  │  │              │
╰──────────────╯  ╰──────────────╯  ╰──────────────╯  ╰──────────────╯
                                                              ↑
                                                              └─ user
                                                                 callback
                                                                 can
                                                                 safely
                                                                 re-fire
```

`.api` has no user-controlled hooks → cannot interrupt → never re-runs. `.end` can interrupt freely; on resume the prior three substeps are skipped and `.end` re-fires with persisted hook data. Symmetric split for `nextLlmCall`.

This is the same shape already used by the parallel tool branches: `start` / `invoke` / `end` / `log` are four separate `b.step` calls ([prompt.ts L661-776](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/prompt.ts#L661-L776)). We're applying the same pattern one level up.

**Tech Stack:** TypeScript runtime — primarily `lib/runtime/prompt.ts` (refactor `_runPrompt` and its two call sites). No changes to `promptRunner.ts`, `runner.ts`, `hooks.ts`, or codegen.

---

### Task 1: Failing fixtures

**Files:**
- Create: `tests/agency/onllmcallend-interrupt-no-rerun.agency` + `.test.json`
- Create: `tests/agency/guard-cost.test.json` (promote the existing `tests/agency/guard-cost.agency` example to a real fixture)

- [ ] **Step 1: Minimal reproducer**

```
let runs: number = 0

callback("onLLMCallEnd") as data {
  interrupt myapp::checkpoint("paused", {})
}

node main() {
  runs = runs + 1
  llm("Reply with the single word: pong")
  return runs
}
```

`.test.json` supplies one interrupt response (any shape — the callback's return value is irrelevant to the cost-tracking question). Expected after one approve cycle: `expectedOutput == 1`. Today: `expectedOutput == 2`.

- [ ] **Step 2: Promote guard-cost** — supply enough interrupt handlers to drive the run to completion. With the bug fixed, ONE approve handler suffices (today the example bleeds to four+ because of the linear re-spend); the fixture asserts `expectedOutput == "done"` AND `expectedTotalCost <= 1e-5` (one LLM call's worth).

- [ ] **Step 3: Confirm both fail**

```bash
pnpm run agency test tests/agency/onllmcallend-interrupt-no-rerun.agency > /tmp/end-hook-rerun.log 2>&1
pnpm run agency test tests/agency/guard-cost.agency >> /tmp/end-hook-rerun.log 2>&1
```

Expected failure messages: counter == 2 (not 1); cost grows linearly across resumes.

- [ ] **Step 4: Commit**

---

### Task 2: Trace what `_runPrompt` does between substep entry and `onLLMCallEnd`

**Files:**
- Read: `lib/runtime/prompt.ts` — focus on `_runPrompt` body and the `pr.step("initialLlmCall", ...)` / `pr.step("round.${round}.nextLlmCall", ...)` wrappers.

Build the mutation table (delete after Task 4 ships). For each piece of mutable state `_runPrompt` touches, note:
- WHAT it is (`messages`, `self.messagesJSON`, `targetStack.localCost`, `ctx.globals.__tokenStats`, `self.pendingToolCalls`, etc.)
- WHEN it is mutated (before/after API call, before/after `onLLMCallEnd`)
- WHETHER its state needs to be preserved across `onLLMCallEnd` interrupt + resume (yes for messages and cost; no for the locally-scoped `endTime`)
- HOW resume can recover it (already in `self.messagesJSON`? need a new `self.runnerState` slot? recoverable from messages themselves?)

Three slots demand particular attention because they currently live ONLY in the `_runPrompt` closure:

- `completion` (smoltalk PromptResult) — `onLLMCallEnd` reads `usage`, `cost`, `finishReason`, `output`. Must be persisted.
- `toolCalls` (`smoltalk.ToolCallJSON[]`) — used after `_runPrompt` returns to drive the tool loop. Already recoverable from the last assistant message's `toolCalls` field, OR we can persist `self.pendingToolCalls` earlier (today it's set after the step body).
- `endTime - startTime` (number) — passed to `onLLMCallEnd` as `timeTaken`. Must be persisted.

These are exactly the shape of the per-tool-branch persistence already done at [L692](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/prompt.ts#L692) (`self.runnerState.toolTimings ??= {}`). We'll mirror that pattern.

---

### Task 3: Split `_runPrompt` into `.start` / `.api` / `.end` substeps

**Files:**
- Modify: `lib/runtime/prompt.ts`

The cleanest refactor: change `_runPrompt`'s signature to accept the `PromptRunner` and a `keyPrefix`, and have IT call `pr.step` for each substep. The outer `pr.step("initialLlmCall", ...)` wrapper goes away — `runPrompt` calls `_runPrompt({ ..., pr, keyPrefix: "initialLlmCall" })` directly.

- [ ] **Step 1: New `_runPrompt` signature**

```ts
type RunPromptOutcome = { messages: MessageThread; toolCalls: smoltalk.ToolCallJSON[] };

async function _runPrompt({
  ctx,
  messages,
  ...,
  pr,
  keyPrefix,
}: {
  ...existing fields...
  pr: PromptRunner;
  keyPrefix: string;
}): Promise<RunPromptOutcome> { ... }
```

The function no longer returns `RunPromptResult` with `kind: "interrupt"` — interrupts inside `pr.step` throw `PromptBailout` which propagates straight up to `runPrompt`'s outer `try/catch`. The tagged-union return type goes away. (`RunPromptResult` exported type can be deleted.)

- [ ] **Step 2: Three `pr.step` calls inside `_runPrompt`**

```ts
// SubStep 1: start hook
await pr.step(`${keyPrefix}.start`, async () => {
  const startInterrupts = await callHook({
    ctx, name: "onLLMCallStart",
    data: { prompt, tools, model: clientConfig.model, messages: messages.toJSON().messages },
  });
  return startInterrupts ?? undefined;
});

// SubStep 2: API call + assistant push + token stats + memory hooks
// NOTE: no user-controlled hook fires inside this step. It cannot
// produce interrupts. The `pr.step` wrapper is here for completed-
// step bookkeeping only.
let completion: PromptResult | undefined;
let toolCalls: ToolCallJSON[] = [];
await pr.step(`${keyPrefix}.api`, async () => {
  // re-check cancellation
  if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();

  // (existing API request, response handling, push assistant message,
  //  updateTokenStats, targetStack.localCost/localTokens, memory hooks)
  ...
  completion = response.value;
  toolCalls = completion.toolCalls || [];
  messages.push(smoltalk.assistantMessage(completion.output, toolCalls.length > 0 ? { toolCalls } : undefined));
  updateTokenStats(...);
  targetStack.localCost += ...;
  targetStack.localTokens += ...;
  // memory hooks (best-effort, log-and-continue)

  // Persist the data .end will need on resume. Keyed by keyPrefix so
  // a later `nextLlmCall` step doesn't clobber `initialLlmCall`.
  self.runnerState.llmCallData ??= {};
  self.runnerState.llmCallData[keyPrefix] = {
    model: completion.model ?? clientConfig.model ?? "unknown model",
    usage: completion.usage,
    cost: completion.cost,
    finishReason: (completion as any).finishReason ?? (completion as any).finish_reason,
    output: completion.output,
    timeTaken: endTime - startTime,
  };
  // toolCalls are recoverable from messages, but cache for clarity.
  self.runnerState.llmCallData[keyPrefix].toolCalls = toolCalls;
});

// SubStep 3: end hook
await pr.step(`${keyPrefix}.end`, async () => {
  const persisted = self.runnerState.llmCallData[keyPrefix];
  const endInterrupts = await callHook({
    ctx, name: "onLLMCallEnd",
    data: {
      model: JSON.stringify(persisted.model),
      result: persisted,           // shaped like a PromptResult
      usage: persisted.usage,
      cost: persisted.cost,
      timeTaken: persisted.timeTaken,
      messages: messages.toJSON().messages,
    },
  });
  return endInterrupts ?? undefined;
});

// Recover completion-derived locals from persistence so the caller
// reads consistent values on both fresh runs and resumes.
const persisted = self.runnerState.llmCallData[keyPrefix];
return {
  messages,
  toolCalls: persisted.toolCalls ?? [],
};
```

- [ ] **Step 3: Move `statelogClient.promptCompletion(...)` into `.api`**

It currently fires after the API call. Moving it inside the `.api` body keeps it idempotent (runs exactly once) and inherits the surrounding `llmCall` span.

---

### Task 4: Rewire the two call sites in `runPrompt`

**Files:**
- Modify: `lib/runtime/prompt.ts`

- [ ] **Step 1: Replace the `initialLlmCall` wrapper**

Before:
```ts
await pr.step("initialLlmCall", async () => {
  const lenBefore = messages.getMessages().length;
  // memory recall + system message + user message push
  ...
  const result = await _runPrompt({ ... });
  if (result.kind === "interrupt") {
    messages.setMessages(messages.getMessages().slice(0, lenBefore));
    closeLlmSpan();
    return result.interrupts;
  }
  ...
});
```

After:
```ts
// .user step: memory recall + system + user message push
let injectedFactsContent: string | null = null;
await pr.step("initialLlmCall.user", async () => {
  if (memoryOption && ctx.memoryManager) { ... }
  messages.push(smoltalk.userMessage(prompt));
});

currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
try {
  const result = await _runPrompt({
    ctx, messages, tools, prompt, responseFormat, clientConfig,
    stateStack, pr, keyPrefix: "initialLlmCall",
  });
  messages = result.messages;
  toolCalls = result.toolCalls;
  // (existing memory-injection cleanup, self.messagesJSON, self.pendingToolCalls)
} catch (e) {
  if (e instanceof PromptBailout) { closeLlmSpan(); throw e; }
  closeLlmSpan();
  throw e;
}
```

The `messages.setMessages(... .slice(0, lenBefore))` revert disappears — each individual substep is small enough that "rewind to before this step" is the correct semantics. (The `.user` step pushes the user message and either completes — leaving it pushed and remembered on resume — or interrupts inside the memory recall code path, in which case nothing was pushed yet and the next resume re-runs cleanly.)

- [ ] **Step 2: Same restructure for `nextLlmCall`**

```ts
await pr.step(`round.${round}.nextLlmCall.prep`, async () => {
  closeLlmSpan();
  // (no-op pre-call setup; reserve the substep so the LLM API call below
  //  can read `closeLlmSpan` having already happened)
});
currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
try {
  const nextResult = await _runPrompt({
    ..., pr, keyPrefix: `round.${round}.nextLlmCall`,
  });
  messages = nextResult.messages;
  toolCalls = nextResult.toolCalls;
  self.toolCallRound = round + 1;
  self.messagesJSON = messages.toJSON().messages;
  self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
} catch (e) {
  if (e instanceof PromptBailout) { closeLlmSpan(); throw e; }
  closeLlmSpan();
  throw e;
}
```

(The `.prep` step exists only if span bookkeeping needs idempotence; usually a no-op wrapper is unnecessary because `startSpan` is safe to re-call on resume — the prior span is already closed by `pr`'s checkpoint-time finalization. Pick whichever is simpler after re-reading the span code.)

- [ ] **Step 3: Run the fixtures**

```bash
pnpm run agency test tests/agency/onllmcallend-interrupt-no-rerun.agency > /tmp/end-hook-rerun.log 2>&1
pnpm run agency test tests/agency/guard-cost.agency >> /tmp/end-hook-rerun.log 2>&1
```

Both must pass.

- [ ] **Step 4: Wide regression sweep**

```bash
pnpm test:run -- prompt promptRunner callback fork llm-tools memory > /tmp/regr.log 2>&1
```

Check for: token-stat drift, doubled `statelogClient.promptCompletion` events, memory-hook re-execution, missing `closeLlmSpan` calls on resume.

- [ ] **Step 5: Commit**

---

### Task 5: Cross-link with sibling end-hook plans

`onAgentEnd` fires outside any runner (intentional). No fix needed.

`onNodeEnd` (value-returning) and `onFunctionEnd` (finally-block) are codegen-level end hooks covered by `docs/superpowers/plans/2026-05-22-callback-interrupts-deferred-return.md`. The substep-split pattern from this plan is the runtime analog of that codegen change — they're solving the same shape of bug at different layers.

- [ ] **Step 1: Update the deferred-return plan** to add a "see also" pointer to this plan.

- [ ] **Step 2: Delete the mutation table** from Task 2 if you kept it.

- [ ] **Step 3: Commit**

---

### Validation checklist

- [ ] `tests/agency/onllmcallend-interrupt-no-rerun` passes; counter shows exactly-once body execution.
- [ ] `tests/agency/guard-cost` passes with a SINGLE approve handler and total cost ≤ one LLM call's worth.
- [ ] `statelogClient.promptCompletion` fires exactly once per LLM call across approve cycles (check fixture event counts).
- [ ] No regressions in multi-tool callback interrupt fixtures, fork/race fixtures, or memory fixtures.
- [ ] `make` succeeds, `pnpm run lint:structure` clean.

---

### Risks and dependencies

- **`PromptBailout` propagation through `_runPrompt`:** the refactored `_runPrompt` now lets `PromptBailout` escape (thrown by inner `pr.step`). The caller's `try/catch` must distinguish `PromptBailout` from `AgencyCancelledError` and other throws (it already does — see the outer `try/catch` at [L478-484](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/prompt.ts#L478-L484)). Verify the new intermediate `try/catch` around `_runPrompt` calls in `runPrompt` re-throws `PromptBailout` after `closeLlmSpan()`.

- **`self.runnerState.llmCallData[keyPrefix]` serialization:** this data must survive checkpoint/restore. It rides on the `runnerState` object already serialized as part of `self.locals` (same vehicle as `completedSteps`). Sanity-check by inspecting a checkpoint snapshot.

- **`statelogClient.promptCompletion` idempotence on resume:** moved into the `.api` substep so resume skips it. Verify event counts in a fixture that resumes through a `.end` interrupt.

- **`llmCall` span lifecycle across resumes:** `closeLlmSpan` is called from the outer `finally` and from the `try/catch` wrappers. On resume, a fresh span is opened. Ensure no leaked spans by checking span open/close counts in a multi-resume fixture.

- **Memory-hook re-execution on resume:** memory's `onTurn` and `compactIfNeeded` run inside `.api` today. After the refactor they still do, and `.api` is skipped on resume — so they fire exactly once. This is actually a bonus correctness win (today memory hooks would re-fire on every approve cycle).

- **Out of scope:** PFA-bound state mutation (plan 2) and callback rejection propagation (plan 3) are separate; this plan does not touch them.
