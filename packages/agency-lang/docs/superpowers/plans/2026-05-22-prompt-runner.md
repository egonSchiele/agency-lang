# PromptRunner: Callback Interrupts + Parallel Tool Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow scoped callbacks invoked during `runPrompt` to halt execution via `interrupt(...)`, and run tool calls within one LLM round concurrently — by introducing a small `PromptRunner` abstraction that owns the idempotent-step + checkpoint-on-interrupt machinery.

**Architecture:** Introduce a `PromptRunner` class in `lib/runtime/promptRunner.ts` with two control-flow primitives — `step()` for sequential idempotent steps that throw `PromptBailout` on interrupt, and `parallel()` for fork-style branches that merge interrupts into one shared checkpoint. Refactor `runPrompt`'s existing tool-interrupt path through `step()` first (no behavior change), then wire callbacks through `step()` (new: callbacks can interrupt), then convert the tool loop to `parallel()` (new: concurrent tool execution). `removedTools` and `toolErrorCounts` accept eventually-consistent semantics — removals take effect on the next LLM round, never the current one.

**Tech Stack:** TypeScript, Vitest, the existing Agency runtime (`StateStack`, `Checkpoints`, `MessageThread`, smoltalk).

---

## Background & key references

Before starting, read:
- `lib/runtime/prompt.ts` — current implementation of `runPrompt` and `_runPrompt`.
- `lib/runtime/hooks.ts` — `callHook` and `invokeCallback`. PR #182 already changed `callHook` to return `Promise<Interrupt[] | undefined>` and added the `callHookAndDrop` "fire-and-forget" wrapper that the four `prompt.ts` sites currently use. Phase 3 of this plan unwraps that wrapper at the `prompt.ts` sites and threads the interrupts into `pr.step` instead.
- `lib/runtime/state/stateStack.ts:113–160` — `getOrCreateBranch`, `setResultOnBranch`, `setInterruptOnBranch`, `popBranches`, `deleteBranch`. Used unchanged.
- `lib/runtime/state/checkpointStore.ts` — `ctx.checkpoints.create()`. Called once per bailout.
- `lib/runtime/interrupts.ts` — `Interrupt` type, `hasInterrupts`, `isRejected`.
- `lib/backends/typescriptBuilder.ts:2458–2578` (`processLlmCall`) — the existing callsite. Unchanged by this plan: the compiler already checks `runPrompt`'s return value for interrupts.
- `docs/dev/checkpointing.md` and `docs/dev/concurrent-interrupts.md` — semantics this plan must preserve.

The CLAUDE.md sections **"CRITICAL: Handlers are safety infrastructure"** and the testing notes apply throughout. In particular: **handlers must remain registered and invoked across all interrupt/resume paths**. Verify after each task that an interrupt propagated through a `PromptRunner` still hits any enclosing `handle` block in the existing fixture tests.

---

## File structure

### New files
- `lib/runtime/promptRunner.ts` — the `PromptRunner` class, `BranchRunner` class, `PromptBailout` exception, and `RunnerState` type.
- `lib/runtime/promptRunner.test.ts` — unit tests. `PromptRunner` is a pure(ish) class — its dependencies (`ctx`, `stateStack`, `checkpoints`, `messages snapshot`) can be stubbed.

### Modified files
- `lib/runtime/prompt.ts` — `runPrompt` and `_runPrompt` refactored to drive their logic through `PromptRunner`. The 400-line body becomes a linear script.
- `lib/runtime/hooks.ts` — `callHook` returns `Promise<Interrupt[] | undefined>` instead of `void`. The "loud throw" branch (lines 115–121) is removed; interrupts are returned to the caller, which is now responsible for bailout.

### Test fixtures touched
- `tests/agency-js/concurrent-interrupt-isolation/` — should keep passing.
- `tests/agency-js/tool-retry/` — should keep passing (sequential per-tool retry/removal semantics still hold within a round).
- `tests/agency-js/interrupts/` — should keep passing.
- `tests/agency-js/hooks/lifecycle/` — should keep passing.
- One **new** fixture under `tests/agency-js/callback-interrupts/` — verifies a callback in `onLLMCallEnd` can throw an interrupt that is caught by an outer `handle` block.
- One **new** fixture under `tests/agency-js/parallel-tools/` — verifies multiple tool calls in one round run concurrently (timing-based check) and that concurrent interrupts merge.

---

## Phase 1 — `PromptRunner` skeleton (no behavior change)

### Task 1: Define types and exception

**Files:**
- Create: `lib/runtime/promptRunner.ts`
- Test: `lib/runtime/promptRunner.test.ts`

- [ ] **Step 1: Sketch the file**

Create `lib/runtime/promptRunner.ts` with the public surface, no implementation yet:

```ts
import type { Interrupt } from "./interrupts.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { MessageJSON } from "smoltalk";
import type { GraphState } from "./types.js";

/** Thrown by PromptRunner.step on interrupt. Caught only at the top of
 *  runPrompt. Never propagates outside lib/runtime/prompt.ts. */
export class PromptBailout extends Error {
  constructor(public readonly interrupts: Interrupt[]) {
    super("PromptBailout");
    this.name = "PromptBailout";
  }
}

/** Frame-backed completion tracking. Lives on `self.runnerState` so it
 *  survives checkpoint/restore the same way `self.messagesJSON` does. */
export type RunnerState = {
  completedSteps: Record<string, true>;
};

export type PromptRunnerOpts = {
  self: any; // frame locals
  ctx: RuntimeContext<GraphState>;
  stateStack: StateStack;
  checkpointInfo: SourceLocationOpts | undefined;
  snapshotMessages: () => MessageJSON[];
};

export class PromptRunner {
  constructor(private opts: PromptRunnerOpts) {
    this.opts.self.runnerState ??= { completedSteps: {} };
  }

  async step(
    _key: string,
    _body: () => Promise<Interrupt[] | void>,
  ): Promise<void> {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 2: Write the first failing test**

```ts
// lib/runtime/promptRunner.test.ts
import { describe, it, expect } from "vitest";
import { PromptRunner, PromptBailout } from "./promptRunner.js";

function makeRunner(overrides: Partial<any> = {}) {
  const self: any = {};
  const ctx: any = {
    checkpoints: { create: () => "cp-1", get: () => ({ moduleId: "", scopeName: "", stepPath: "" }) },
    statelogClient: { checkpointCreated: () => {} },
  };
  const opts = {
    self,
    ctx,
    stateStack: {} as any,
    checkpointInfo: undefined,
    snapshotMessages: () => [],
    ...overrides,
  };
  return { runner: new PromptRunner(opts), self };
}

describe("PromptRunner.step", () => {
  it("runs the body on first call and marks it completed", async () => {
    const { runner, self } = makeRunner();
    let ran = 0;
    await runner.step("a", async () => { ran++; });
    expect(ran).toBe(1);
    expect(self.runnerState.completedSteps.a).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test — confirm failure**

```bash
pnpm test:run lib/runtime/promptRunner.test.ts 2>&1 | tee /tmp/run1.txt
```
Expected: FAIL with "not implemented".

- [ ] **Step 4: Implement the minimal `step()`**

Replace the stub body of `step`:

```ts
async step(key: string, body: () => Promise<Interrupt[] | void>): Promise<void> {
  if (this.opts.self.runnerState.completedSteps[key]) return;
  await body();
  this.opts.self.runnerState.completedSteps[key] = true;
}
```

- [ ] **Step 5: Run the test — confirm pass**

```bash
pnpm test:run lib/runtime/promptRunner.test.ts 2>&1 | tee /tmp/run2.txt
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/promptRunner.ts lib/runtime/promptRunner.test.ts
git commit -m "add PromptRunner skeleton with idempotent step()"
```

### Task 2: Skip-on-resume behavior

**Files:**
- Test: `lib/runtime/promptRunner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("skips a body whose key is already completed (resume case)", async () => {
  const { runner, self } = makeRunner();
  self.runnerState = { completedSteps: { a: true } };
  let ran = 0;
  await runner.step("a", async () => { ran++; });
  expect(ran).toBe(0);
});
```

(The constructor `??=` should preserve the preset `runnerState`. If it overwrites it, fix.)

- [ ] **Step 2: Run** — Expected: PASS already if `??=` is correct; otherwise FAIL → fix the constructor.

```bash
pnpm test:run lib/runtime/promptRunner.test.ts 2>&1 | tee /tmp/run3.txt
```

- [ ] **Step 3: Commit if any fixup needed**

```bash
git add -A && git commit -m "verify PromptRunner skips completed steps on resume"
```

### Task 3: Bailout on returned interrupts

**Files:**
- Modify: `lib/runtime/promptRunner.ts`
- Test: `lib/runtime/promptRunner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { hasInterrupts } from "./interrupts.js";

function fakeInterrupt(kind = "k"): any {
  return { kind, interruptId: "i-1", interruptData: {}, checkpoint: undefined };
}

describe("PromptRunner.step interrupt handling", () => {
  it("throws PromptBailout when the body returns interrupts", async () => {
    const { runner } = makeRunner();
    await expect(
      runner.step("a", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
  });

  it("does NOT mark the key completed when bailing", async () => {
    const { runner, self } = makeRunner();
    await runner.step("a", async () => [fakeInterrupt()] as any).catch(() => {});
    expect(self.runnerState.completedSteps.a).toBeUndefined();
  });

  it("snapshots messages and creates a checkpoint with the right source location", async () => {
    let createdWith: any;
    const ctx: any = {
      checkpoints: {
        create: (_s: any, _c: any, info: any) => { createdWith = info; return "cp-1"; },
        get: () => ({ moduleId: "m", scopeName: "s", stepPath: "p" }),
      },
      statelogClient: { checkpointCreated: () => {} },
    };
    const self: any = {};
    const captured: any[] = [];
    const runner = new PromptRunner({
      self, ctx, stateStack: {} as any,
      checkpointInfo: { moduleId: "m", scopeName: "s", stepPath: "p" },
      snapshotMessages: () => { captured.push("snapshot"); return [{ role: "user", content: "hi" }] as any; },
    });
    const intr = fakeInterrupt();
    await runner.step("a", async () => [intr] as any).catch(() => {});
    // stepPath is `${basePath}/${key}` so the per-call key (`a`) is
    // appended to the runPrompt-level checkpointInfo.stepPath (`p`).
    expect(createdWith).toEqual({ moduleId: "m", scopeName: "s", stepPath: "p/a" });
    expect(self.messagesJSON).toEqual([{ role: "user", content: "hi" }]);
    expect(captured.length).toBe(1);
    expect(intr.checkpointId).toBe("cp-1");
  });
});
```

- [ ] **Step 2: Run** — confirm failures.

- [ ] **Step 3: Implement**

Replace `step`:

```ts
import { hasInterrupts } from "./interrupts.js";

async step(key: string, body: () => Promise<Interrupt[] | void>): Promise<void> {
  if (this.opts.self.runnerState.completedSteps[key]) return;
  const result = await body();
  if (result && hasInterrupts(result as any)) {
    this.opts.self.messagesJSON = this.opts.snapshotMessages();
    // Thread `key` into `stepPath` so multiple step(...) calls in the
    // same runPrompt produce distinct checkpoints. Without this they all
    // share `checkpointInfo.stepPath` and the checkpoint store cannot
    // tell them apart on resume.
    const basePath = this.opts.checkpointInfo?.stepPath ?? "";
    const stepPath = basePath ? `${basePath}/${key}` : key;
    const cpId = this.opts.ctx.checkpoints.create(this.opts.stateStack, this.opts.ctx, {
      moduleId: this.opts.checkpointInfo?.moduleId ?? "",
      scopeName: this.opts.checkpointInfo?.scopeName ?? "",
      stepPath,
    });
    const cp = this.opts.ctx.checkpoints.get(cpId)!;
    for (const i of result as Interrupt[]) {
      i.checkpoint = cp;
      i.checkpointId = cpId;
    }
    this.opts.ctx.statelogClient.checkpointCreated({
      checkpointId: cpId,
      reason: "interrupt",
      sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
    });
    throw new PromptBailout(result as Interrupt[]);
  }
  this.opts.self.runnerState.completedSteps[key] = true;
}
```

- [ ] **Step 4: Run all `promptRunner.test.ts` tests** — confirm all pass.

```bash
pnpm test:run lib/runtime/promptRunner.test.ts 2>&1 | tee /tmp/run4.txt
```

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/promptRunner.ts lib/runtime/promptRunner.test.ts
git commit -m "PromptRunner.step bails with checkpoint on interrupt"
```

---

## Phase 2 — Route existing tool-interrupt path through `PromptRunner`

Goal: replace the inline interrupt-collection block in `prompt.ts` (lines 644–669 of the current implementation) with a call through `PromptRunner.step`. **No new behavior, no callback interrupts yet.** This is the load-bearing refactor that proves the abstraction.

### Task 4: Instantiate `PromptRunner` in `runPrompt`

**Files:**
- Modify: `lib/runtime/prompt.ts`

- [ ] **Step 1: Import and construct**

Near the top of `runPrompt`, after `self` is initialized but before the messages-restore block, add:

```ts
import { PromptRunner, PromptBailout } from "./promptRunner.js";

// ... later, inside runPrompt, after `self.__initialized` setup:
const pr = new PromptRunner({
  self,
  ctx,
  stateStack,
  checkpointInfo,
  snapshotMessages: () => messages.toJSON().messages,
});
```

Note the closure captures `messages` by reference. `messages` is reassigned in a few places — verify the closure still observes those reassignments. (It will, because JavaScript variables in closures resolve at access time, not capture time. But the reassignments overwrite the local binding; the closure must observe the current `messages`. Test this by adding a `console.log` temporarily if uncertain.)

If the closure does NOT see reassignments (because `let messages = ...` rebinding doesn't propagate into the already-captured closure — actually it does for `let`/`var` in the same scope), use a stable wrapper:

```ts
let messagesRef: MessageThread = messages;
const pr = new PromptRunner({ /* ... */, snapshotMessages: () => messagesRef.toJSON().messages });
// and assign `messagesRef = messages` whenever `messages` is reassigned.
```

Pick whichever is correct after a 30-second read of the code; both work.

- [ ] **Step 2: Build to check types**

```bash
pnpm run build 2>&1 | tee /tmp/build1.txt
```
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "instantiate PromptRunner in runPrompt"
```

### Task 5: Replace the tool-interrupt block with a step call

**Files:**
- Modify: `lib/runtime/prompt.ts`

- [ ] **Step 1: Wrap the outer try/catch**

Wrap the body of `runPrompt` (currently lines ~409–709) so that `PromptBailout` is caught at the top:

```ts
let shouldPop = true;
try {
  // ... existing body, including the while/tool loop ...
} catch (error) {
  if (error instanceof PromptBailout) {
    shouldPop = false;
    return error.interrupts;
  }
  if (isAbortError(error)) throw error;
  throw error;
} finally {
  closeLlmSpan();
  if (shouldPop) stateStack.pop();
}
```

- [ ] **Step 2: Convert the inline interrupt-collection block**

In the tool loop, find the block (currently lines 644–669) that creates a checkpoint when `interrupts.length > 0` and returns them. Replace it with:

```ts
if (interrupts.length > 0) {
  await pr.step(`round.${self.toolCallRound - 1}.toolInterrupts`, async () => interrupts);
  // unreachable — pr.step throws PromptBailout
}
```

The `step` body simply returns the collected interrupts; `pr.step` does the rest. Use `self.toolCallRound - 1` because the round counter was already incremented at the top of the loop iteration.

(Subtle: we **want** this step to bail every time it runs on resume. We do NOT want it to be skipped because it completed on a prior pass — it CAN'T have completed, because it throws. So this is safe: it'll either throw or not be reached at all.)

- [ ] **Step 3: Build and run the existing fixtures**

```bash
pnpm run build 2>&1 | tee /tmp/build2.txt
pnpm run agency test js tests/agency-js/concurrent-interrupt-isolation 2>&1 | tee /tmp/test-cii.txt
pnpm run agency test js tests/agency-js/tool-retry 2>&1 | tee /tmp/test-tr.txt
pnpm run agency test js tests/agency-js/interrupts 2>&1 | tee /tmp/test-int.txt
pnpm run agency test js tests/agency-js/hooks 2>&1 | tee /tmp/test-hk.txt
```
Expected: all PASS. The behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "route tool-call interrupts through PromptRunner.step"
```

---

## Phase 3 — Callback interrupts

### Task 6: Swap `callHookAndDrop` → `callHook` at the four prompt.ts sites

**Files:**
- Modify: `lib/runtime/prompt.ts`

**Background:** PR #182 (already merged to main) landed the full `callHook` plumbing:
- `callHook` returns `Promise<Interrupt[] | undefined>`.
- `invokeCallback` and `fireWithGuard` thread the array through.
- Multi-callback batching collects interrupts across siblings (mirrors `runForkAll`).
- `callHookAndDrop` is a "fire-and-forget" wrapper that calls `callHook` and `console.error`-logs any returned interrupts.

PR #182 migrated `lib/runtime/prompt.ts` to use `callHookAndDrop` at all four hook sites so the existing swallow-and-log behavior was preserved. This task **undoes that migration for the four prompt.ts sites only** so the returned `Interrupt[]` can flow into `pr.step` (Task 7) and reach the user.

The two `node.ts` sites (`onAgentStart` / `onAgentEnd`) keep using `callHookAndDrop` permanently — they fire outside any agency frame and cannot propagate. Do NOT touch them.

- [ ] **Step 1: Verify the prerequisite landed**

```bash
grep -n "export async function callHook\b\|export async function callHookAndDrop\b" lib/runtime/hooks.ts
grep -n "callHookAndDrop\|callHook\b" lib/runtime/prompt.ts
```
Expected: `callHook` returns `Promise<Interrupt[] | undefined>` in `hooks.ts`. Four `callHookAndDrop` sites in `prompt.ts` (lines 57, 194, 483, 609 — verify by reading).

- [ ] **Step 2: Update the import**

```ts
// lib/runtime/prompt.ts
import { callHook } from "./hooks.js";
```

(Removes `callHookAndDrop` from the import. The four call sites below switch back to `callHook`.)

- [ ] **Step 3: Swap each of the four sites back to `callHook`**

Replace `await callHookAndDrop({...})` → `await callHook({...})` at:
1. `onLLMCallStart` (around line 57)
2. `onLLMCallEnd` (around line 194)
3. `onToolCallStart` (around line 483)
4. `onToolCallEnd` (around line 609)

Argument shape is unchanged. Each call now returns `Interrupt[] | undefined` instead of `void`. In this task, the returned value is still ignored — Task 7 wraps each in `pr.step(...)` which will consume it.

- [ ] **Step 4: Verify the only `callHookAndDrop` users left are in `node.ts`**

```bash
grep -rn "callHookAndDrop" lib/runtime/
```
Expected: 3 hits — the import on line 4 of `node.ts` and the two call sites at lines 174 and 222. Zero hits in `prompt.ts`.

- [ ] **Step 5: Build and run the existing prompt fixtures**

```bash
pnpm run build 2>&1 | tee /tmp/build3.txt
pnpm run agency test js tests/agency-js/hooks 2>&1 | tee /tmp/test-hk0.txt
pnpm run agency test js tests/agency-js/concurrent-interrupt-isolation 2>&1 | tee /tmp/test-cii0.txt
```
Expected: clean build, all fixtures pass. **Behavior is unchanged** because no existing fixture has a callback that returns an interrupt (and the four sites still ignore the return value in this task — Task 7 wires them up).

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "swap callHookAndDrop -> callHook at the four prompt.ts sites"
```

### Task 7: Wire each callback site in `prompt.ts` through `pr.step`

**Files:**
- Modify: `lib/runtime/prompt.ts`

There are 4 `await callHook(...)` sites:
1. `_runPrompt` — `onLLMCallStart` (line 57)
2. `_runPrompt` — `onLLMCallEnd` (line 194)
3. Tool loop — `onToolCallStart` (line 483)
4. Tool loop — `onToolCallEnd` (line 609)

For #1 and #2: since `_runPrompt` is called from inside an enclosing step (see Task 8), it must propagate interrupts up rather than wrap them itself. Add a return-value carrier.

- [ ] **Step 1: Change `_runPrompt`'s return type**

```ts
type RunPromptResult =
  | { kind: "ok"; messages: MessageThread; toolCalls: ToolCallJSON[] }
  | { kind: "interrupt"; interrupts: Interrupt[] };

async function _runPrompt(args: { /* ... */ }): Promise<RunPromptResult> {
  // ...
  const startInterrupts = await callHook({ ctx, name: "onLLMCallStart", data: { ... } });
  if (startInterrupts) return { kind: "interrupt", interrupts: startInterrupts };
  // ... after the API call and message push ...
  const endInterrupts = await callHook({ ctx, name: "onLLMCallEnd", data: { ... } });
  if (endInterrupts) return { kind: "interrupt", interrupts: endInterrupts };
  return { kind: "ok", messages, toolCalls };
}
```

- [ ] **Step 2: Wrap both `_runPrompt` callsites in `runPrompt` with `pr.step`**

For the initial call (currently around line 371):

```ts
await pr.step(`round.${self.toolCallRound}.initialLlmCall`, async () => {
  // memory injection (existing code)
  messages.push(smoltalk.userMessage(prompt));
  currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
  let result: RunPromptResult;
  try {
    result = await _runPrompt({ /* same args as today */ });
  } catch (e) {
    closeLlmSpan();
    throw e;
  }
  if (result.kind === "interrupt") return result.interrupts;
  messages = result.messages;
  toolCalls = result.toolCalls;
  // strip transient memory injection (existing code)
  self.messagesJSON = messages.toJSON().messages;
  self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
});
```

For the round-end call (currently around line 683):

```ts
await pr.step(`round.${self.toolCallRound}.nextLlmCall`, async () => {
  closeLlmSpan();
  currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
  const result = await _runPrompt({ /* same args */ });
  if (result.kind === "interrupt") return result.interrupts;
  messages = result.messages;
  toolCalls = result.toolCalls;
  self.messagesJSON = messages.toJSON().messages;
  self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
});
```

Note: assignments to outer `messages`, `toolCalls`, `self.pendingToolCalls` happen **inside** the step body. After `pr.step` returns normally, those bindings reflect the new round's data. After a bailout, the throw skips the rest of `runPrompt`'s body. On resume, the step is skipped (its key is in `completedSteps`) — meaning we DO NOT redo the LLM call, and `messages`/`toolCalls` need to be re-derived from `self.pendingToolCalls` and the restored `messages`. The existing `self.messagesJSON` restore block at the top of `runPrompt` already handles `messages`. For `toolCalls`, add right after the restore block:

```ts
let toolCalls: ToolCallJSON[] = self.pendingToolCalls ?? [];
```

…and remove the now-redundant "Tool calls: restore from frame or make initial LLM call" branch (currently around line 333).

- [ ] **Step 3: Wrap the per-tool callback sites**

In the tool loop, replace the two `await callHook` lines:

```ts
await pr.step(`round.${round}.tool.${toolCall.id}.start`, async () =>
  await callHook({ ctx, name: "onToolCallStart", data: { toolName: handler.name, args: namedArgs } }));

// ... invocation, push tool message ...

await pr.step(`round.${round}.tool.${toolCall.id}.end`, async () =>
  await callHook({ ctx, name: "onToolCallEnd", data: { toolName: handler.name, result, timeTaken: ... } }));
```

Where `round` is a local declared at the top of the iteration: `const round = self.toolCallRound;` (don't increment until after).

- [ ] **Step 4: Build and run fixtures**

```bash
pnpm run build 2>&1 | tee /tmp/build4.txt
pnpm run agency test js tests/agency-js/concurrent-interrupt-isolation 2>&1 | tee /tmp/test-cii2.txt
pnpm run agency test js tests/agency-js/tool-retry 2>&1 | tee /tmp/test-tr2.txt
pnpm run agency test js tests/agency-js/interrupts 2>&1 | tee /tmp/test-int2.txt
pnpm run agency test js tests/agency-js/hooks 2>&1 | tee /tmp/test-hk2.txt
```
Expected: all PASS. No new behavior is exercised yet because no existing fixture has a callback that returns an interrupt.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "route LLM and tool callbacks through PromptRunner.step"
```

### Task 8: Add a fixture that exercises callback interrupts end-to-end

**Files:**
- Create: `tests/agency-js/callback-interrupts/agent.agency`
- Create: `tests/agency-js/callback-interrupts/agent.js`
- Create: `tests/agency-js/callback-interrupts/test.js`
- Create: `tests/agency-js/callback-interrupts/fixture.json`

- [ ] **Step 1: Look at an existing similar fixture**

Read `tests/agency-js/concurrent-interrupt-isolation/agent.agency`, `agent.js`, `test.js`, and `fixture.json`. Use them as the template.

- [ ] **Step 2: Write an Agency program with a scoped callback that raises an interrupt**

```agency
// tests/agency-js/callback-interrupts/agent.agency
node main() {
  let count = 0
  handle {
    callback onLLMCallEnd(data) {
      count = count + 1
      if (count >= 2) {
        return interrupt("budget exceeded", { count: count })
      }
    }
    const a = llm("say hi")
    const b = llm("say bye")
    return [a, b]
  } with (i) {
    return approve()
  }
}
```

(Adjust syntax as needed against `docs/site/guide/basic-syntax.md`.)

- [ ] **Step 3: Write the test driver**

Modeled after `concurrent-interrupt-isolation/test.js`. Run the agent under the deterministic test LLM provider (set `AGENCY_USE_TEST_LLM_PROVIDER=1`); assert that the second LLM call's `onLLMCallEnd` interrupt is caught by the `handle` block and `approve()` runs, allowing both LLM calls to complete.

Also add a second scenario where the outer `handle` rejects: assert execution halts and the agent returns the interrupt array.

- [ ] **Step 4: Run the new fixture**

```bash
pnpm run agency test js tests/agency-js/callback-interrupts 2>&1 | tee /tmp/test-cbint.txt
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/callback-interrupts/
git commit -m "fixture: callback in onLLMCallEnd can interrupt"
```

---

## Phase 4 — Parallel tool calls

### Task 9: Add `BranchRunner` and `PromptRunner.parallel`

**Files:**
- Modify: `lib/runtime/promptRunner.ts`
- Test: `lib/runtime/promptRunner.test.ts`

- [ ] **Step 1: Write failing tests first**

```ts
describe("PromptRunner.parallel", () => {
  it("runs each branch concurrently and completes when no interrupts", async () => {
    const { runner } = makeRunner();
    const order: string[] = [];
    await runner.parallel("group", ["a", "b", "c"], async (item, b) => {
      await b.step(`${item}.s1`, async () => { order.push(`start-${item}`); });
      await new Promise((r) => setTimeout(r, 5));
      await b.step(`${item}.s2`, async () => { order.push(`end-${item}`); });
    });
    // All three starts happen before any end (concurrent).
    const idxStartC = order.indexOf("start-c");
    const idxEndA = order.indexOf("end-a");
    expect(idxStartC).toBeLessThan(idxEndA);
  });

  it("merges interrupts from multiple branches into one bailout with one checkpoint", async () => {
    let cpCount = 0;
    const ctx: any = {
      checkpoints: { create: () => { cpCount++; return `cp-${cpCount}`; }, get: () => ({ moduleId: "", scopeName: "", stepPath: "" }) },
      statelogClient: { checkpointCreated: () => {} },
    };
    const self: any = {};
    const runner = new PromptRunner({ self, ctx, stateStack: {} as any, checkpointInfo: undefined, snapshotMessages: () => [] });
    let caught: PromptBailout | null = null;
    try {
      await runner.parallel("group", ["a", "b"], async (item, b) => {
        await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
      });
    } catch (e) {
      if (e instanceof PromptBailout) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.interrupts.length).toBe(2);
    expect(cpCount).toBe(1); // ONE shared checkpoint
    expect(caught!.interrupts.every((i) => i.checkpointId === "cp-1")).toBe(true);
  });

  it("skips a branch step whose key was already completed on a prior pass", async () => {
    const self: any = { runnerState: { completedSteps: { "a.s1": true } } };
    const ctx: any = {
      checkpoints: { create: () => "cp", get: () => ({ moduleId: "", scopeName: "", stepPath: "" }) },
      statelogClient: { checkpointCreated: () => {} },
    };
    const runner = new PromptRunner({ self, ctx, stateStack: {} as any, checkpointInfo: undefined, snapshotMessages: () => [] });
    let ran = 0;
    await runner.parallel("group", ["a"], async (item, b) => {
      await b.step(`${item}.s1`, async () => { ran++; });
    });
    expect(ran).toBe(0);
  });
});
```

- [ ] **Step 2: Implement `BranchRunner` and `parallel`**

```ts
export class BranchRunner {
  /** Collected interrupts in this branch. Once set, subsequent step calls
   *  short-circuit — the branch is effectively halted. */
  public interrupts: Interrupt[] | null = null;

  constructor(private self: any) {}

  async step(key: string, body: () => Promise<Interrupt[] | void>): Promise<void> {
    if (this.interrupts) return;
    this.self.runnerState ??= { completedSteps: {} };
    if (this.self.runnerState.completedSteps[key]) return;
    const result = await body();
    if (result && hasInterrupts(result as any)) {
      this.interrupts = result as Interrupt[];
      return;
    }
    this.self.runnerState.completedSteps[key] = true;
  }
}

// On PromptRunner:
async parallel<T>(
  keyPrefix: string,
  items: T[],
  branchFn: (item: T, b: BranchRunner) => Promise<void>,
): Promise<void> {
  const branches = items.map(() => new BranchRunner(this.opts.self));
  await Promise.all(items.map((item, i) => branchFn(item, branches[i])));
  const merged: Interrupt[] = [];
  for (const b of branches) if (b.interrupts) merged.push(...b.interrupts);
  if (merged.length === 0) return;

  this.opts.self.messagesJSON = this.opts.snapshotMessages();
  // CRITICAL: thread the per-call `keyPrefix` into the checkpoint's
  // `stepPath` so two different `parallel(...)` invocations within the
  // same runPrompt (or across resume cycles) get distinct checkpoint
  // entries. Without this, the runPrompt-level `checkpointInfo.stepPath`
  // collides across all parallel sites and the checkpoint store cannot
  // tell them apart on resume.
  const basePath = this.opts.checkpointInfo?.stepPath ?? "";
  const stepPath = basePath ? `${basePath}/${keyPrefix}` : keyPrefix;
  const cpId = this.opts.ctx.checkpoints.create(this.opts.stateStack, this.opts.ctx, {
    moduleId: this.opts.checkpointInfo?.moduleId ?? "",
    scopeName: this.opts.checkpointInfo?.scopeName ?? "",
    stepPath,
  });
  const cp = this.opts.ctx.checkpoints.get(cpId)!;
  for (const i of merged) { i.checkpoint = cp; i.checkpointId = cpId; }
  this.opts.ctx.statelogClient.checkpointCreated({
    checkpointId: cpId,
    reason: "interrupt",
    sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
  });
  throw new PromptBailout(merged);
}
```

The same `stepPath`-with-`keyPrefix` rule applies to `PromptRunner.step` too — update it (Task 3) so the per-step `key` argument is appended to `checkpointInfo.stepPath` when stamping its checkpoint. Otherwise step-level bailouts have the same collision problem across multiple `step(...)` calls in one `runPrompt`.

Notes:
- All `BranchRunner.step` calls write completion markers to the **same** `self.runnerState.completedSteps` map. This is fine because the keys include the per-item identifier (e.g. `tool.${toolCall.id}.start`) and so don't collide across branches.
- If `branchFn` throws something other than a returned-interrupt-array (e.g. a real error or a `PromptBailout` from a nested `step`), `Promise.all` rejects. We currently let it propagate. That means **don't call `pr.step` (which throws) from inside a parallel branch — call `b.step` (which collects)**. Document this on the class.

- [ ] **Step 3: Run all unit tests**

```bash
pnpm test:run lib/runtime/promptRunner.test.ts 2>&1 | tee /tmp/test-pr.txt
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/promptRunner.ts lib/runtime/promptRunner.test.ts
git commit -m "PromptRunner.parallel with shared-checkpoint interrupt merging"
```

### Task 10 — Prerequisite: Audit `tool-retry` for same-round removal dependence

**Files:**
- Read: `tests/agency-js/tool-retry/agent.agency`, `agent.js`, `test.js`, `fixture.json`
- Read: the `removedTools` / `toolErrorCounts` logic in `lib/runtime/prompt.ts`

**Why this is here:** The plan's Phase 4 introduces an eventual-consistency rule — "removals take effect on the next LLM round, not the current one." The Behavioral Changes Summary asserts "in practice no fixture relied on this," but the existence of a `tool-retry` fixture suggests otherwise. Confirm before writing any concurrent code in Task 10.

- [ ] **Step 1: Read `tool-retry` end to end**

```bash
ls tests/agency-js/tool-retry/
cat tests/agency-js/tool-retry/agent.agency
cat tests/agency-js/tool-retry/agent.js
cat tests/agency-js/tool-retry/test.js
cat tests/agency-js/tool-retry/fixture.json
```

For each scenario the test asserts, write down (a) which tools are called per round, (b) whether the test expects a tool to be skipped *within* the same round it failed, and (c) whether the test expects N retries before removal.

- [ ] **Step 2: Read the current `removedTools` logic**

```bash
grep -n "removedTools\|toolErrorCounts" lib/runtime/prompt.ts
```

For each push site and each filter site, decide whether the order matters when siblings run concurrently. The two critical predicates today are:
- "Skip this tool's invocation if it's already in `removedTools`" — runs INSIDE the per-tool iteration today.
- "Filter `tools` and `toolFunctions` by `!removedTools.includes(t.name)`" — runs AFTER the loop today.

Under sequential execution, an earlier tool's failure can push to `removedTools` before a later tool's iteration checks it. Under concurrent execution with the plan's design, all branches start in the same tick — so a same-round skip is impossible.

- [ ] **Step 3: Pick a strategy and write it down here**

Three options, pick one:

  - **(A) Accept the breakage.** If the `tool-retry` fixture really does rely on same-round removal, update the fixture with a comment ("under PromptRunner, removals take effect next round") and adjust its expectations. Document in the PR description as a behavior change.

  - **(B) Preserve same-round semantics via gated start.** Inside each branch's first step, check `removedTools.includes(handler.name)` BEFORE doing any work. Because branches start concurrently this still doesn't guarantee any specific ordering — but for "all tools that fail get removed, retries happen next round" the semantic is preserved at the granularity of the *failure-detection* step, which is what users actually care about. Concretely: have `b.step("tool.X.invoke", ...)` early-return when the tool is in `removedTools`. The race between two siblings both pushing on the first round is harmless (the set ignores duplicates).

  - **(C) Sequence the tools entirely.** Use `for (const toolCall of toolCalls) { await pr.step(...) }` instead of `pr.parallel`. Preserves all existing semantics; loses the parallelism win. Acceptable as a fallback if (A) and (B) are both unworkable.

Default recommendation: **(B)**, with a unit test added to `promptRunner.test.ts` covering the "tool already in removedTools when invoke step runs" early-return path.

- [ ] **Step 4: Document the decision in this plan**

Edit Task 10 Step 2 below to reflect whichever option you picked. Note the choice in the eventual commit message / PR description.

### Task 10: Convert the tool loop to use `parallel`

**Files:**
- Modify: `lib/runtime/prompt.ts`

This is the riskiest task. Take it slowly and verify with fixtures after each substep. Make sure the Task 10 prerequisite above has been done first — the `removedTools` strategy you pick there determines whether Step 2 below uses raw `b.step` calls or gated ones.

- [ ] **Step 1: Identify the tool loop body**

In `runPrompt`, locate the `for (const toolCall of toolCalls)` block (currently around line 422). The body's structure today is:
- Find handler
- Skip if removed
- Skip if branch has cached result (resume)
- Create branchKey/branchStack
- Fire `onToolCallStart` (will become `b.step` site)
- `enterToolCall` / invoke / `exitToolCall`
- Handle `isFailure` (push msg, increment `toolErrorCounts`, push to `removedTools`)
- Handle `isRejected` (push msg)
- Handle `hasInterrupts` (push to `interrupts[]`, set on branch)
- On success: push tool message, cache result, fire `onToolCallEnd`

After the loop, the `interrupts.length > 0` block bails (this was moved to `pr.step` in Task 5).

- [ ] **Step 2: Wrap the body in a `pr.parallel(...)` call**

Replace the entire `for (const toolCall of toolCalls)` block plus the trailing `interrupts.length > 0` bailout block with one `pr.parallel` call:

```ts
const round = self.toolCallRound; // capture before increment

// (Remove the per-iteration `interrupts: Interrupt[] = []` accumulator —
// branches now hold their own interrupts; the parallel call merges them.)

await pr.parallel(`round.${round}.tools`, toolCalls, async (toolCall, b) => {
  await b.step(`round.${round}.tool.${toolCall.id}.start`, async () => {
    // existing handler-lookup + skip-if-removed logic stays here, but
    // any "early continue" from the original loop becomes an early return
    // from the branch.
    // Also fire onToolCallStart inside this step:
    return await callHook({ ctx, name: "onToolCallStart", data: { toolName: handler.name, args: namedArgs } });
  });
  if (b.interrupts) return; // start callback interrupted

  await b.step(`round.${round}.tool.${toolCall.id}.invoke`, async () => {
    // existing invoke + failure/reject/interrupt handling.
    // Convert the "push to interrupts[]" path to: `return result;` where
    // result is the Interrupt[] from the tool — the BranchRunner.step
    // will detect hasInterrupts() and bail this branch.
    // Failure / rejected / success paths run as today: push appropriate
    // tool message, update `toolErrorCounts` / `removedTools`. Return void.
  });
  if (b.interrupts) return;

  await b.step(`round.${round}.tool.${toolCall.id}.end`, async () =>
    await callHook({ ctx, name: "onToolCallEnd", data: { toolName: handler.name, result, timeTaken } }));
});

// If we reach here, all tool branches completed without interrupting.
// Increment the round counter and clean up branches (existing logic).
self.toolCallRound++;
stack.popBranches();
tools = tools.filter((t) => !removedTools.includes(t.name));
toolFunctions = toolFunctions.filter((fn) => !removedTools.includes(fn.name));
```

Key behavior preservation:
- **`branchKey` / `branchStack`** still get created per tool — needed for `invoke` to use the branch stack. The "skip if `existing?.result !== undefined`" cached-result branch from the original code becomes naturally redundant because `b.step` already skips completed keys on resume. Verify by reading the comment block at lines 458–477 — its scenario is fork-in-tool with rejects. With the new design, each tool's invoke runs under its own branch stack and inner interrupts are captured the same way as today. The cached-result short-circuit can be removed.
- **`removedTools` / `toolErrorCounts`** mutations happen inside concurrent branches. Per the spec decision, **removals take effect on the next LLM round, not the current one** — the `.filter` line above runs after the `parallel` returns. Multiple branches mutating the same array/object: since we accept eventual consistency, the order is unimportant. But the JavaScript event loop guarantees only one task runs at a time, so `push` / property assignment are atomic in practice. Acceptable.
- **`onToolCallStart`/`onToolCallEnd`** fire concurrently per-tool. Existing tests don't assert ordering between siblings, so this is fine.

- [ ] **Step 3: Build**

```bash
pnpm run build 2>&1 | tee /tmp/build5.txt
```
Expected: clean.

- [ ] **Step 4: Run all relevant fixtures**

```bash
pnpm run agency test js tests/agency-js/concurrent-interrupt-isolation 2>&1 | tee /tmp/test-cii3.txt
pnpm run agency test js tests/agency-js/tool-retry 2>&1 | tee /tmp/test-tr3.txt
pnpm run agency test js tests/agency-js/interrupts 2>&1 | tee /tmp/test-int3.txt
pnpm run agency test js tests/agency-js/hooks 2>&1 | tee /tmp/test-hk3.txt
pnpm run agency test js tests/agency-js/callback-interrupts 2>&1 | tee /tmp/test-cbint2.txt
```
Expected: all PASS.

If `tool-retry` fails, look closely at the "removals take effect next round" semantic — the test might assume same-round removal. If so, document the behavior change in the test's comment and update the fixture, or note it as a known regression in the commit message.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "run tool calls in parallel within an LLM round"
```

### Task 11: Add a fixture for parallel tool calls and concurrent interrupts

**Files:**
- Create: `tests/agency-js/parallel-tools/agent.agency`
- Create: `tests/agency-js/parallel-tools/agent.js`
- Create: `tests/agency-js/parallel-tools/test.js`
- Create: `tests/agency-js/parallel-tools/fixture.json`

- [ ] **Step 1: Write an Agency program with two slow tools**

```agency
def slowTool1(): string {
  sleep(200)
  return "tool1 done"
}

def slowTool2(): string {
  sleep(200)
  return "tool2 done"
}

node main() {
  return llm("call both slowTool1 and slowTool2", { tools: [slowTool1, slowTool2] })
}
```

Configure the test LLM client to return a response that calls both tools in one round.

- [ ] **Step 2: Write the test driver**

Measure wall-clock time. Assert: total time is closer to 200ms than 400ms (within a margin) — proving concurrency. Also assert both tool results land in the final response.

- [ ] **Step 3: Add a second scenario**

A second test where both tools throw interrupts in the same round. Assert the agent returns both interrupts in one array, and that the shared checkpoint can be used to respond and resume.

- [ ] **Step 4: Run**

```bash
pnpm run agency test js tests/agency-js/parallel-tools 2>&1 | tee /tmp/test-pt.txt
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/parallel-tools/
git commit -m "fixture: tools in one LLM round run in parallel; interrupts merge"
```

---

## Phase 5 — Full suite + cleanup

### Task 12: Run the full test suite

- [ ] **Step 1: Run all tests**

```bash
pnpm test:run 2>&1 | tee /tmp/full-unit.txt
pnpm run agency test tests/agency 2>&1 | tee /tmp/full-agency.txt
pnpm run agency test js tests/agency-js 2>&1 | tee /tmp/full-agency-js.txt
```

Read the saved logs. Any regressions: triage one by one. Most likely categories:
- Statelog ordering assertions that depend on sequential tool execution.
- Tests that rely on `removedTools` removal taking effect within the same round.

For each regression, decide: real bug (fix in `promptRunner.ts` or `prompt.ts`) vs. acceptable behavior change (update the fixture with a comment).

- [ ] **Step 2: Lint and structural check**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/lint.txt
```
Expected: PASS.

- [ ] **Step 3: Commit any test-fixture adjustments**

```bash
git add -A
git commit -m "adjust fixtures for PromptRunner refactor"
```

### Task 13: Remove dead code in `prompt.ts`

After Tasks 5, 7, 10 the following are dead and should be removed:
- `self.pendingToolCalls`-based resume branch at the top of `runPrompt` (replaced by `pr.step` skip).
- The `existing?.result !== undefined` short-circuit and the long comment block at lines 458–477.
- The standalone `interrupts: Interrupt[] = []` accumulator inside the tool loop.

- [ ] **Step 1: Identify and delete**

Walk through `prompt.ts` and remove each. After every deletion, re-run the full fixture suite (`pnpm run agency test js tests/agency-js`) — anything that was load-bearing will fail loudly.

- [ ] **Step 2: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "remove dead resume/short-circuit logic now handled by PromptRunner"
```

### Task 14: Documentation

**Files:**
- Modify: `docs/dev/concurrent-interrupts.md` — add a section about tool-call concurrency within `runPrompt`.
- Create: `docs/dev/promptRunner.md` — short doc covering the abstraction, the `step` vs `parallel` distinction, and the `removedTools` next-round semantics.

- [ ] **Step 1: Write `docs/dev/promptRunner.md`**

Half a page. Audience: a future Agency contributor encountering `runPrompt` for the first time.

- [ ] **Step 2: Add a one-line link from `prompt.ts`**

```ts
// See docs/dev/promptRunner.md for the control-flow abstraction used here.
```

- [ ] **Step 3: Commit**

```bash
git add docs/dev/promptRunner.md docs/dev/concurrent-interrupts.md lib/runtime/prompt.ts
git commit -m "docs: PromptRunner abstraction"
```

---

## Behavioral changes summary

For the eventual PR description / changelog:

1. **Scoped callbacks can interrupt.** A callback registered via `callback("onLLMCallEnd") { ... }` (or any of the four other lifecycle hooks fired inside `runPrompt`: `onLLMCallStart`, `onLLMCallEnd`, `onToolCallStart`, `onToolCallEnd`) may `interrupt(...)`. The interrupt propagates to the enclosing `handle` block, just like an interrupt thrown directly from agent code. Before this PR, an interrupt at one of these sites was silently logged and dropped by `callHookAndDrop` (PR #182). Before that, it threw a hard error. This PR is the third and final step: interrupts at these four sites now actually propagate.
2. **Tool calls within one LLM round run concurrently.** Sibling tool calls now execute in parallel. Total latency for a round is `max(tool_durations) + LLM_latency` rather than `sum(tool_durations) + LLM_latency`.
3. **`removedTools` removals take effect on the next LLM round.** If tool A and tool B both fail in the same round, both still attempted; both are then removed before the next round. Previously, in sequential execution, B might be skipped if A's failure happened to flip the same flag — but in practice no fixture relied on this.

## Out of scope (do NOT do in this PR)

- Moving `llm()` itself into Agency code.
- Adding generic functions / `schema(T)`.
- Per-chunk streaming step boundaries.
- Changing the public callback contract beyond return type (no new callback names, no new data fields).
