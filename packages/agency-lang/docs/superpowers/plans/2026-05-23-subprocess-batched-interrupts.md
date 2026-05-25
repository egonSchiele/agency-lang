# Subprocess Batched Interrupts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the fork-guard introduced by the prior plan so that concurrent interrupts from inside a subprocess (subprocess-side `fork`, `race`, parallel LLM tool calls, multi-callback hooks) can be batched and either auto-resolved by the parent's handler chain or surfaced to the user — by making IPC-mode `interruptWithHandlers` participate in `runBatch`'s collector instead of blocking inside each leaf.

**Architecture:**
- IPC-mode `interruptWithHandlers` returns `Interrupt[]` when called from inside a `runBatch` child (detected via `localStack !== ctx.stateStack`); the existing single-interrupt block-on-decision fast path is preserved for non-runBatch leaves.
- `runBatch` collects naturally (no changes to `runBatch.ts`), stamps the shared parent checkpoint, propagates `Interrupt[]` up the call stack.
- Subprocess bootstrap sees `Interrupt[]` from the node return and sends a new `"interrupt-batch"` IPC message; the subprocess then exits (snapshot-and-respawn for every batched event, even when all decisions auto-resolve).
- Parent runs the unified handler chain on every interrupt in the batch. If all decisions auto-resolve (approve/reject), parent immediately respawns the subprocess from the shared checkpoint with all N decisions baked into the `resume` message. If any decision propagates, parent surfaces only the propagating subset to the user, with the auto-resolved siblings + their decisions stashed as hidden fields on the surfaced interrupts so the resume call can reconstruct the full N-entry response map.

**Tech Stack:** Node.js child_process IPC, Agency runtime (`runBatch`, checkpoints, interrupts, state serialization)

**Prerequisite:** `docs/superpowers/plans/2026-05-10-subprocess-propagation-and-resume.md` must be fully landed. This plan lifts the fork-guard added in that plan's Task 6 Step 5 and reuses its `_run` resume path, checkpoint shipping, and `IpcInterruptMessage.compiledPath` field.

**Related docs to read before starting:**
- `docs/dev/concurrent-interrupts.md` — `runBatch` model, slice rule, multi-cycle resume.
- `docs/dev/runBatch.md` — the primitive's contract; specifically the "no-throw `Interrupt[]`" invariant.
- `docs/dev/subprocess-ipc.md` — current single-interrupt IPC protocol.
- `docs/dev/checkpointing.md` — `Checkpoint.fromJSON` / `toJSON` and `RestoreSignal`.

---

## Scope notes

**In scope:**
- Subprocess-side `runBatch`-backed sites (`fork`, `race`, parallel LLM tools, multi-callback hooks) producing one OR multiple interrupts can be auto-resolved by parent handlers (fast path) or surfaced to the user (slow path).
- Mixed batches (some interrupts auto-resolve, others propagate to user) work end-to-end: only propagating interrupts surface to the user; auto-resolved siblings carry their decisions through the user-respond round-trip.
- Multi-cycle: a batched event can interrupt again on its first re-run.

**Out of scope (must fail loudly, not silently):**
- Subprocess-side nested subprocess execution (still blocked by `_run`'s `isIpcMode()` early throw; unchanged).
- Cross-process race cancellation: if a user rejects one propagating interrupt while N siblings auto-resolved, all branches are resumed (the rejection becomes that branch's failure; sibling branches still complete). True "abort the other branches because one was rejected" requires a separate design.
- Per-interrupt streaming (decisions are sent as a batch, not one-by-one). For interactive UX where the user wants to approve one and see what happens before approving the next, use serial `run()` calls instead of batched fork.

---

## File map

| File | Change |
|------|--------|
| `lib/runtime/ipc.ts` | Add `IpcInterruptBatchMessage` type. Add `handleInterruptBatchMessage` parent-side. Extend `SerializedInterrupt` (the on-wire shape carried out to the user via `settleWithPropagation`) with optional `_batchSiblings` + `_batchSiblingResponses`. Extend `_run` resume payload construction to merge in batched-sibling data. Remove the single-interrupt `handleInterruptMessage` (single interrupts now flow through the unified batch path) OR keep it for the non-runBatch fast path (decision below). |
| `lib/runtime/interrupts.ts` | In `interruptWithHandlers`'s IPC branch, detect `localStack !== ctx.stateStack`. When true, build the interrupt object (already-stamped checkpoint per prior plan's Task 6) and RETURN `[interruptObj]` instead of calling `sendInterruptToParent`. When false, keep the existing block-on-decision path unchanged. Remove the fork-guard throw added in prior plan's Task 6 Step 5. |
| `lib/runtime/subprocess-bootstrap.ts` | After `await nodeFn(...)`, inspect `result.data` for `Interrupt[]` (via `hasInterrupts`). If present, send `{type: "interrupt-batch", sharedCheckpoint, runId, compiledPath, interrupts}` and exit. Otherwise send the existing `"result"` message. Same logic on the resume path (`handleResume`). |
| `tests/agency-js/subprocess-batch-auto-approve/` | New integration test: subprocess fork with 2 branches, parent handler approves both. Asserts both branches complete via respawn. |
| `tests/agency-js/subprocess-batch-propagate/` | New integration test: subprocess fork with 2 branches, no parent handler. User sees both interrupts; on respond, subprocess resumes and completes. |
| `tests/agency-js/subprocess-batch-mixed/` | New integration test: subprocess fork with 3 branches; parent handler approves 1, propagates 1, rejects 1. Only the propagating interrupt surfaces to user. After user response, subprocess resumes; approved branch returns its handler value, rejected branch returns failure, propagated branch returns user value. |
| `tests/agency/subprocess/` | Convert `subprocess-fork-guard` test (positive guard from prior plan's Task 10 Step 4) into a regression test that exercises the now-working batched path. |
| `docs/dev/subprocess-ipc.md` | Document the unified IPC interrupt model. Cross-link to `runBatch.md`. Replace the "subprocess-side fork+propagation is not yet supported" section with the new protocol. |

**Decision on the single-interrupt path:** Keep the existing `handleInterruptMessage` (single-interrupt block-on-decision fast path) for non-`runBatch` leaves. Rationale: spawning a new subprocess for every single-interrupt event regresses performance; the fast path stays for the common case. Batched events always pay the respawn cost, which is fine because they pay it once per batch, not per interrupt.

---

## Code style guidance

Per `docs/dev/anti-patterns.md`, separate **what** from **how**:
- **Imperative code lives in a few helpers** (Task 1.5 below) — group-by, dedupe-merge, partial-response detection.
- **Orchestration code stays declarative** — `decideEach`, `buildSurfaced`, `mergeResumePayload`, `assertComplete`. Each task's main body reads top-to-bottom as a sequence of declarative calls.
- **Encapsulate side-channel state behind one object.** Instead of six `(intr as any)._batchSiblings` / `._batchSiblingResponses` / `._batchPropagatingCount` etc. attached separately, group them under a single `_batchResumeContext` field accessed via `attachBatchResumeContext` / `readBatchResumeContext` / `stripBatchResumeContext` helpers (Task 1.5). Consumers see one opaque field, not six leaky underscores.

This is the discipline the rest of the plan assumes. If a step's snippet starts to grow imperative — `for` loops, `if (!array.find(...))` dedupe checks, manual state mutation — it's a sign the helper should be promoted up to Task 1.5.

---

### Task 1: Add `IpcInterruptBatchMessage` type and serialized interrupt schema

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 1: Add the wire type**

In `lib/runtime/ipc.ts`, add alongside the existing `IpcInterruptMessage` type:

```ts
/**
 * A single interrupt's wire shape inside an interrupt-batch message.
 * One sharedCheckpoint at the message level dedupes the per-interrupt
 * checkpoint that runBatch overwrote onto every batch member.
 */
export type IpcBatchInterruptEntry = {
  kind: string;
  message: string;
  data: any;
  origin: string;
  interruptId: string;
  subprocessVotes: SubprocessVotes;
};

/**
 * Subprocess → parent: a runBatch-collected batch of interrupts that all
 * share one parent checkpoint stamped by runBatch's `stampSharedCheckpoint`.
 * Length-1 batches go through this path too (the unified IPC batch model);
 * single non-runBatch interrupts continue to use IpcInterruptMessage.
 */
export type IpcInterruptBatchMessage = {
  type: "interrupt-batch";
  sharedCheckpoint: any;       // serialized Checkpoint JSON (runBatch's shared cp)
  sharedCheckpointId: number;  // the cpId — needed for partial-response grouping on resume
  runId: string;
  compiledPath: string;
  interrupts: IpcBatchInterruptEntry[];
};
```

Add it to the `SubprocessToParent` union:

```ts
export type SubprocessToParent =
  | IpcInterruptMessage
  | IpcInterruptBatchMessage
  | IpcResultMessage
  | IpcErrorMessage;
```

- [ ] **Step 2: Extend the ipcLog detail formatter to recognize the new type**

In the `ipcLog` function, add an else-if branch:

```ts
else if (type === "interrupt-batch") detail = `n=${msg.interrupts?.length ?? 0}`;
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm run build 2>&1 | tee /tmp/task1-build.log`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/ipc.ts
git commit -m "feat: add IpcInterruptBatchMessage wire type for subprocess batched interrupts"
```

---

### Task 1.5: Declarative helpers and `BatchResumeContext` type

**Why:** Tasks 2, 4, and 5 each handle the "batched interrupt has resume context attached" model. Putting the imperative pieces (group-by, dedupe, attach/read/strip) in one helper module keeps every task's main body declarative and the side-channel surface small.

**Files:**
- Create: `lib/runtime/batchResume.ts`
- Create: `lib/runtime/batchResume.test.ts`

- [ ] **Step 1: Define the type**

```ts
// lib/runtime/batchResume.ts
import type { Interrupt } from "./interrupts.js";

/** Surfaced-to-user interrupts from a subprocess batch carry this so the
 *  resume path can reconstruct the full N-entry response map. Single
 *  opaque field instead of three separate `(intr as any)._batch*` side
 *  channels — see docs/dev/anti-patterns.md "Leaky abstractions". */
export type BatchResumeContext = {
  siblings: SerializedSiblingInterrupt[];
  siblingResponses: { type: string; value: any }[];
  /** How many interrupts in this batch propagated to the user. The resume
   *  path asserts that exactly this many surfaced interrupts from the same
   *  batch (grouped by checkpointId) come back via respondToInterrupts. */
  propagatingCount: number;
};

export type SerializedSiblingInterrupt = {
  kind: string; message: string; data: any; origin: string;
  interruptId: string; checkpoint: any; runId: string; compiledPath: string;
};

const FIELD = "_batchResumeContext" as const;

export function attachBatchResumeContext(intr: Interrupt<any>, ctx: BatchResumeContext): Interrupt<any> {
  (intr as any)[FIELD] = ctx;
  return intr;
}
export function readBatchResumeContext(intr: any): BatchResumeContext | null {
  return intr?.[FIELD] ?? null;
}
export function stripBatchResumeContext<T extends { [FIELD]?: unknown }>(intr: T): Omit<T, typeof FIELD> {
  const { [FIELD]: _omit, ...rest } = intr;
  return rest as Omit<T, typeof FIELD>;
}
```

- [ ] **Step 2: Add `buildBatchSiblings` and `buildSurfacedInterrupts` helpers**

```ts
import { createInterrupt } from "./interrupts.js";
import type { IpcInterruptBatchMessage } from "./ipc.js";

type DecisionEntry =
  | { interruptId: string; outcome: "approve"; value: any }
  | { interruptId: string; outcome: "reject"; value: any }
  | { interruptId: string; outcome: "propagate"; value: any };

/** Pair each auto-resolved decision with its original batch entry, so the
 *  resume payload can carry the sibling Interrupt[] alongside its decided response. */
export function buildBatchSiblings(
  msg: IpcInterruptBatchMessage,
  autoResolved: DecisionEntry[],
): { siblings: SerializedSiblingInterrupt[]; responses: { type: string; value: any }[] } {
  const entryById = new Map(msg.interrupts.map((e) => [e.interruptId, e]));
  const siblings = autoResolved.map((d) => {
    const entry = entryById.get(d.interruptId)!;
    return {
      kind: entry.kind, message: entry.message, data: entry.data, origin: entry.origin,
      interruptId: entry.interruptId, checkpoint: msg.sharedCheckpoint,
      runId: msg.runId, compiledPath: msg.compiledPath,
    };
  });
  const responses = autoResolved.map((d) => ({ type: d.outcome, value: d.value }));
  return { siblings, responses };
}

/** Construct the Interrupt[] surfaced to the user. Each carries the full
 *  BatchResumeContext so the resume path can rebuild the N-entry payload. */
export function buildSurfacedInterrupts(
  msg: IpcInterruptBatchMessage,
  propagating: DecisionEntry[],
  ctx: BatchResumeContext,
): Interrupt<any>[] {
  const entryById = new Map(msg.interrupts.map((e) => [e.interruptId, e]));
  return propagating.map((d) => {
    const entry = entryById.get(d.interruptId)!;
    const intr = createInterrupt({
      kind: entry.kind, message: entry.message, data: entry.data, origin: entry.origin,
      runId: msg.runId, interruptId: entry.interruptId,
    });
    intr.checkpoint = msg.sharedCheckpoint;
    (intr as any).checkpointId = msg.sharedCheckpointId;
    (intr as any).compiledPath = msg.compiledPath;
    return attachBatchResumeContext(intr, ctx);
  });
}
```

- [ ] **Step 3: Add `mergeBatchResumePayload` and `assertNoPartialBatchResponse`**

```ts
/** Walk surfaced interrupts and pull their batch context out, returning
 *  the full N-entry payload (user-provided + auto-resolved siblings)
 *  ready to ship as `{ interrupts, responses }` in the resume IPC message. */
export function mergeBatchResumePayload(
  userInterrupts: any[],
  userResponses: any[],
): { interrupts: any[]; responses: any[] } {
  const interrupts: any[] = [...userInterrupts];
  const responses: any[] = [...userResponses];
  const seenIds = new Set(userInterrupts.map((i) => i.interruptId));
  for (const intr of userInterrupts) {
    const ctx = readBatchResumeContext(intr);
    if (!ctx) continue;
    ctx.siblings.forEach((sib, i) => {
      if (seenIds.has(sib.interruptId)) return;
      seenIds.add(sib.interruptId);
      interrupts.push(sib);
      responses.push(ctx.siblingResponses[i]);
    });
  }
  return {
    interrupts: interrupts.map(stripBatchResumeContext),
    responses,
  };
}

/** Detect partial response: user dropped some surfaced interrupts from a
 *  single batch. Resuming would hang the subprocess on the dropped
 *  interrupt IDs, so we throw a clear error instead. */
export function assertNoPartialBatchResponse(userInterrupts: any[]): void {
  const groups = new Map<number, any[]>();
  for (const intr of userInterrupts) {
    if (!readBatchResumeContext(intr)) continue;
    const cpId = intr.checkpointId;
    const arr = groups.get(cpId) ?? [];
    arr.push(intr);
    groups.set(cpId, arr);
  }
  for (const [cpId, members] of groups) {
    const expected = readBatchResumeContext(members[0])!.propagatingCount;
    if (members.length !== expected) {
      throw new Error(
        `_run: partial response to batched subprocess interrupts: surfaced ${expected} ` +
        `propagating interrupts (sharing checkpoint ${cpId}) but only ${members.length} ` +
        `were re-supplied. respondToInterrupts must receive ALL surfaced interrupts from ` +
        `a single subprocess batch together.`,
      );
    }
  }
}
```

- [ ] **Step 4: Write unit tests for each helper**

In `lib/runtime/batchResume.test.ts`, cover:
- `attach/read/strip` round-trip preserves arbitrary other fields.
- `buildBatchSiblings`: input N decisions → output N siblings + N responses, indices align.
- `buildSurfacedInterrupts`: each surfaced interrupt has shared `checkpointId` matching `msg.sharedCheckpointId`.
- `mergeBatchResumePayload`: surfaced interrupts with overlapping `interruptId`s dedupe (sibling that's also in `userInterrupts` is not duplicated).
- `mergeBatchResumePayload`: strips `_batchResumeContext` from output.
- `assertNoPartialBatchResponse`: passes for complete batches; throws with the documented message for incomplete ones.

Run: `pnpm test:run lib/runtime/batchResume.test.ts 2>&1 | tee /tmp/task1.5-test.log`
Expected: all unit tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/batchResume.ts lib/runtime/batchResume.test.ts
git commit -m "feat: declarative helpers for subprocess batched-interrupt resume payload"
```

---

### Task 2: Subprocess bootstrap — detect `Interrupt[]` from node return and send batch message

**Files:**
- Modify: `lib/runtime/subprocess-bootstrap.ts`

- [ ] **Step 1: Add a helper to extract the shared batch info from interrupts**

The interrupts returned from a `runBatch`-backed site all carry the same `intr.checkpoint` and `intr.checkpointId` (per runBatch's `stampSharedCheckpoint` overwrite). In `subprocess-bootstrap.ts`, add a small helper near the top of the module:

```ts
import { hasInterrupts, type Interrupt } from "./interrupts.js";

function extractBatchMessage(
  result: any,
  runId: string,
  compiledPath: string,
): IpcInterruptBatchMessage | null {
  if (!hasInterrupts(result?.data)) return null;
  const interrupts = result.data as Interrupt[];
  // All members share the same checkpoint+checkpointId (runBatch.stampSharedCheckpoint
  // overwrites both — see runBatch.ts:236-239). Pick [0].
  const liveCp = interrupts[0].checkpoint;
  const sharedCheckpoint = liveCp?.toJSON?.() ?? liveCp;
  const sharedCheckpointId = (interrupts[0] as any).checkpointId;
  return {
    type: "interrupt-batch",
    sharedCheckpoint,
    sharedCheckpointId,
    runId,
    compiledPath,
    interrupts: interrupts.map((i) => ({
      kind: i.kind,
      message: i.message,
      data: i.data,
      origin: i.origin,
      interruptId: i.interruptId,
      // subprocessVotes.propagated reflects whether the subprocess's
      // handler chain returned "propagate" (explicit propagate() call)
      // vs "noResponse" (no handler). The single-interrupt fast path
      // distinguishes these — explicit propagate forces parent propagate,
      // noResponse lets parent's approve win. interruptWithHandlers tags
      // this on the interrupt object via the `_subprocessPropagated`
      // side channel set in Task 3. Missing → false (defensive).
      subprocessVotes: { propagated: (i as any)._subprocessPropagated === true },
    })),
  };
}
```

- [ ] **Step 2: Wire it into the `handleRun` and `handleResume` flow**

Find the existing block (around line 126):

```ts
const result = await nodeFn(...positionalArgs);
ipcLog("send", { type: "log", detail: `node ${msg.node} returned` });
await sendResultOrLimitError({
  type: "result",
  value: { data: result.data, tokens: result.tokens, ... },
});
process.exit(0);
```

Replace with:

```ts
const result = await nodeFn(...positionalArgs);
ipcLog("send", { type: "log", detail: `node ${msg.node} returned` });

const batch = extractBatchMessage(result, msg.runId, msg.scriptPath);
if (batch !== null) {
  // Subprocess produced a batch of interrupts — send the batch and exit.
  // Parent will either respawn with decisions (fast path) or surface to
  // the user (slow path); either way this subprocess is done.
  await sendOrDie(batch);
  process.exit(0);
}

await sendResultOrLimitError({
  type: "result",
  value: { data: result.data, tokens: result.tokens, messages: result.messages?.toJSON?.() ?? result.messages },
});
process.exit(0);
```

Make sure the same logic is in `handleResume` after its `respondToInterrupts` call returns — a resumed subprocess can also produce a batch (the multi-cycle case).

- [ ] **Step 3: Verify the build is still clean**

Run: `make 2>&1 | tee /tmp/task2-build.log`
Expected: clean build, no type errors.

- [ ] **Step 4: Run subprocess basics to ensure no regression**

Run: `pnpm run a test tests/agency/subprocess/run-basic.agency 2>&1 | tee /tmp/task2-run-basic.log`
Expected: PASS. (The new code path is unreachable until Task 3 changes `interruptWithHandlers`, so existing tests must still pass.)

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/subprocess-bootstrap.ts
git commit -m "feat: subprocess bootstrap detects Interrupt[] return and sends interrupt-batch message"
```

---

### Task 3: IPC-mode `interruptWithHandlers` falls through to non-IPC return path when inside a runBatch child

**Key insight (from review):** The non-IPC path at `interrupts.ts:236-258` already builds the right `[intr]` shape for both `hasPropagation` and `noResponse` outcomes. The change is NOT to add a new "build interrupt and return" block — it's to *gate* the IPC block so execution falls through to the existing return code. We also tag the interrupt with `_subprocessPropagated` so the bootstrap (Task 2) and the parent's `decideInterrupt` (Task 4) can distinguish explicit-propagate from no-handler.

**Files:**
- Modify: `lib/runtime/interrupts.ts`

- [ ] **Step 1: Create a pending test fixture (TDD scaffolding)**

Create `tests/agency/subprocess/_pending/batched-fork-no-handler.agency` and its `.test.json`. The agent body does a 2-branch `fork` whose body calls a bare `interrupt(...)`. Test expectation: until Task 5 lands the parent's batch handler, this will error at the parent end ("unknown message type" or similar) — that's fine because the file lives under `_pending/` and is not picked up by the default test runner. Task 5 Step 1 moves it out of `_pending/`.

- [ ] **Step 2: Gate the IPC branch with `localStack !== ctx.stateStack`**

In `lib/runtime/interrupts.ts`, find the existing IPC branch (around line 208):

```ts
if (isIpcMode()) {
  const parentDecision = await sendInterruptToParent(...);
  // ... block-on-decision path ...
}
```

Change the condition so the entire IPC block is skipped when inside a `runBatch` child. The function then falls through to the existing non-IPC return-`[intr]` code at lines 236-258:

```ts
const localStack = stack ?? ctx.stateStack;
const insideRunBatchChild = localStack !== ctx.stateStack;
if (isIpcMode() && !insideRunBatchChild) {
  const parentDecision = await sendInterruptToParent(...);
  // ... unchanged ...
}
// Fall through to the non-IPC return path below.
```

This is the entire structural change — no new return statement, no new interrupt construction. The existing `if (hasPropagation) return [intr]` at line 236 and the `noResponse` `return [intr]` at line 258 already produce the right shape.

- [ ] **Step 3: Tag the interrupt with `_subprocessPropagated`**

In the same fall-through block, BEFORE the existing `return [intr]` statements at lines 242 and 258, attach the propagation flag so the bootstrap (Task 2) and parent (Task 4) can distinguish. Add a small helper at the top of `interruptWithHandlers`:

```ts
function tagSubprocess(intr: Interrupt<any>, isPropagated: boolean): Interrupt<any> {
  if (isIpcMode()) {
    (intr as any)._subprocessPropagated = isPropagated;
    (intr as any).compiledPath = process.env.AGENCY_COMPILED_PATH ?? "";
  }
  return intr;
}
```

Then wrap the two return sites:

```ts
if (hasPropagation) {
  const intr = interrupt(...);
  ctx.statelogClient.interruptThrown(...);
  return [tagSubprocess(intr, true)];   // explicit propagate
}
// ...
const intr = interrupt(...);
ctx.statelogClient.interruptThrown(...);
return [tagSubprocess(intr, false)];    // noResponse (no handler ran)
```

- [ ] **Step 4: Share the checkpoint creation with the IPC fast path**

Prior plan's Task 6 Step 3 added a checkpoint-creation block inside the IPC branch. After Task 3 Step 2, that block must run BEFORE the `if (isIpcMode() && !insideRunBatchChild)` gate so both the IPC fast path and the fall-through (batched) path stamp the same checkpoint on the interrupt.

**The two consumers want different shapes:**
- IPC fast path (`sendInterruptToParent`) needs `checkpointJson` (JSON, marshalled over IPC).
- Fall-through path stamps a live `Checkpoint` instance onto `intr.checkpoint` (matching `runBatch.stampSharedCheckpoint`'s contract that `intr.checkpoint` is a live object).

Extract a helper that returns BOTH shapes:

```ts
function createIpcCheckpoint(
  ctx: RuntimeContext<any>,
  localStack: StateStack,
  location: { moduleId: string; scopeName: string; stepPath: string } | undefined,
): { cpId: number; checkpoint: Checkpoint; checkpointJson: any } | null {
  if (!isIpcMode()) return null;
  const loc = location ?? { moduleId: "", scopeName: "", stepPath: "" };
  try {
    const cpId = ctx.checkpoints.create(localStack, ctx, loc);
    const checkpoint = ctx.checkpoints.get(cpId)!;
    return { cpId, checkpoint, checkpointJson: checkpoint.toJSON() };
  } catch (e) {
    if (process.env.AGENCY_IPC_DEBUG === "1") {
      process.stderr.write(`[ipc:child] checkpoint creation failed: ${e}\n`);
    }
    return null;
  }
}
```

Call once at the top of `interruptWithHandlers`'s IPC handling region:

```ts
const ipcCp = createIpcCheckpoint(ctx, localStack, location);
```

In the IPC fast path: pass `ipcCp?.checkpointJson` to `sendInterruptToParent`.
In `tagSubprocess` (Step 3): also stamp `intr.checkpoint = ipcCp?.checkpoint` and `intr.checkpointId = ipcCp?.cpId` so the leaf-side checkpoint is on the returned `[intr]`. `runBatch.stampSharedCheckpoint` will later overwrite both with the SHARED parent checkpoint — that's the correct final state; the leaf-stamp is just the vehicle.

(This is the refactor risk the reviewer flagged: if the two paths drift on what they stamp, multi-cycle resumes will diverge. Code-review focus on this step.)

- [ ] **Step 4.5: Verify side-channel survives `runBatch`**

`_subprocessPropagated` is attached via `(intr as any)._subprocessPropagated = ...`. Confirm it round-trips:
- Through `runBatch.stampSharedCheckpoint` (overwrites only `checkpoint`/`checkpointId`, not arbitrary fields).
- Through the propagation up to `subprocess-bootstrap`'s `extractBatchMessage`, which reads it BEFORE any IPC serialization.

Add a unit test in `lib/runtime/interrupts.test.ts` (or a new file):

```ts
test("tagSubprocess flag survives runBatch return", async () => {
  // Set up a fake IPC env, a stack that differs from ctx.stateStack,
  // call interruptWithHandlers, run the returned Interrupt[0] through a
  // mock runBatch flow, assert _subprocessPropagated is still on the
  // object at the end.
});
```

If the field doesn't survive (e.g., `runBatch` deep-clones), pivot: promote `_subprocessPropagated` to a documented field on the `Interrupt` type in `lib/runtime/interrupts.ts` (not a side channel).

- [ ] **Step 5: Remove the fork-guard added in prior plan's Task 6 Step 5**

Delete the `if (isIpcMode() && hasPropagation && localStack !== ctx.stateStack) throw ...` block. The runtime now supports this case.

- [ ] **Step 6: Build clean**

Run: `make 2>&1 | tee /tmp/task3-build.log`
Expected: clean build.

- [ ] **Step 7: Run all existing subprocess tests**

Run:
```bash
pnpm run a test tests/agency/subprocess 2>&1 | tee /tmp/task3-subprocess.log
```
Expected: every test passes. The non-runBatch single-interrupt path is unchanged; the new batched path is reachable but the parent doesn't yet handle the `interrupt-batch` message — that's Task 4. So no test should hit the new path yet (the `_pending/` test is excluded).

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/interrupts.ts tests/agency/subprocess/_pending
git commit -m "feat: IPC-mode interruptWithHandlers falls through to [intr] return inside runBatch children; tag _subprocessPropagated; remove fork-guard"
```

---

### Task 3.5: Extract `spawnSubprocess` helper (prerequisite for Task 4)

**Why:** `_run` and the new `handleInterruptBatchMessage` fast path both spawn a subprocess with the same fork options, stdio setup, env, message handlers, and timer. Duplicating that logic in Task 4 (as the first draft of this plan did) creates drift risk. Extract a single helper now so Task 4 just calls it.

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 1: Extract `spawnSubprocess` from `_run` / `attachSessionHandlers`**

Pull the `fork(subprocessBootstrapPath, ...)` call, the stdio attach calls, the wall-clock timer setup, and the `child.on("message"|"close"|"error")` wiring into:

```ts
type SubprocessSpawnOpts = {
  ctx: any;
  stateStack: any;
  limits: RunLimits;
  compiledPath: string;
  resolvePromise: (v: any) => void;
  rejectPromise: (v: any) => void;
};

function spawnSubprocess(opts: SubprocessSpawnOpts): RunSession {
  const memoryMb = Math.max(1, Math.floor(opts.limits.memory / (1024 * 1024)));
  const child = fork(subprocessBootstrapPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1", AGENCY_COMPILED_PATH: opts.compiledPath },
    execArgv: [`--max-old-space-size=${memoryMb}`],
  });
  const session: RunSession = {
    child, limits: opts.limits, ctx: opts.ctx, stateStack: opts.stateStack,
    compiledPath: opts.compiledPath, resolvePromise: opts.resolvePromise,
    rejectPromise: opts.rejectPromise, settled: false, startedAt: Date.now(),
    wallClockTimer: null, stdoutBytes: 0, stoppedForwarding: false,
    propagated: false,  // from prior plan's Task 7
  };
  attachStdoutForwarder(session, child.stdout, process.stdout);
  attachStdoutForwarder(session, child.stderr, process.stderr);
  session.wallClockTimer = setTimeout(() => {
    session.wallClockTimer = null;
    settleWithLimitFailure(session, "wall_clock", session.limits.wallClock, Date.now() - session.startedAt);
  }, session.limits.wallClock);
  child.on("message", (m: any) => { void handleChildMessage(session, m); });
  child.on("close", (code, signal) => handleChildClose(session, code, signal));
  child.on("error", (err: Error) => settle(session, session.rejectPromise, new Error(`Subprocess error: ${err.message}`)));
  return session;
}
```

- [ ] **Step 2: Rewrite `_run` to call `spawnSubprocess`**

Replace the inline spawn block in `_run` with `const session = spawnSubprocess({...})` and then `session.child.send(runInstruction)`.

Note: this should NOT pass AGENCY_COMPILED_PATH via env in the OLD `_run` if it wasn't there before (prior plan's Task 6 Step 4 added it). Confirm the env-var-pass is consistent across both call sites.

- [ ] **Step 3: Run regression**

Run: `pnpm run a test tests/agency/subprocess 2>&1 | tee /tmp/task3.5-regress.log`
Expected: every test passes — pure refactor, no behavior change.

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/ipc.ts
git commit -m "refactor: extract spawnSubprocess helper (no behavior change)"
```

---

### Task 4: Parent — `handleInterruptBatchMessage`: auto-resolve path (fast path)

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 1: Write the failing integration test FIRST**

Create `tests/agency-js/subprocess-batch-auto-approve/agent.agency`:

```agency
def confirmItem(item: string): boolean {
  return interrupt("Confirm: ${item}", { item })
}

node main(items: string[]): boolean[] {
  return fork(items) as item {
    confirmItem(item)
  }
}
```

Create `tests/agency-js/subprocess-batch-auto-approve/test.js`:

```js
import { test, expect } from "vitest";
import { compile, run, runWithHandler } from "../../../lib/exports.js";
// or whichever entrypoint the existing agency-js tests use; mirror an existing one

test("subprocess fork: parent handler approves all branches", async () => {
  const compiled = await compile(/* the agent source above */);
  // Top-level handler: approve all interrupts of kind "user"
  const result = await runWithHandler(compiled, "main", { items: ["a", "b"] }, (intr) => {
    if (intr.kind === "user") return { type: "approve", value: true };
    return undefined;
  });
  expect(result.data).toEqual([true, true]);
});
```

(Adjust API shape to match the existing agency-js test conventions — check `tests/agency-js/subprocess-no-handler/` for the canonical wiring.)

Create `tests/agency-js/subprocess-batch-auto-approve/fixture.json` matching the existing fixture format.

Run: `pnpm test:run tests/agency-js/subprocess-batch-auto-approve 2>&1 | tee /tmp/task4-test-fail.log`
Expected: FAIL — the parent currently has no `handleInterruptBatchMessage`, so the IPC message gets dropped or causes an unhandled message error.

- [ ] **Step 2: Add the per-interrupt handler helper**

In `lib/runtime/ipc.ts`, add:

```ts
type BatchDecisionEntry =
  | { interruptId: string; outcome: "approve"; value: any }
  | { interruptId: string; outcome: "reject"; value: any }
  | { interruptId: string; outcome: "propagate"; value: any };

async function decideInterrupt(
  s: RunSession,
  entry: IpcBatchInterruptEntry,
): Promise<BatchDecisionEntry> {
  const { kind, message, data, origin, interruptId } = entry;
  try {
    const handlerResult = await interruptWithHandlers(kind, message, data, origin, s.ctx, s.stateStack);
    const childPropagated = entry.subprocessVotes?.propagated === true;
    if (isApproved(handlerResult)) {
      return { interruptId, outcome: "approve", value: (handlerResult as any).value };
    }
    if (hasInterrupts(handlerResult) || childPropagated) {
      // Either parent has no resolving handler, OR the child propagated and
      // any-propagate beats any-approve in the unified chain.
      return { interruptId, outcome: "propagate", value: undefined };
    }
    return { interruptId, outcome: "reject", value: (handlerResult as any).value };
  } catch (err) {
    return {
      interruptId, outcome: "reject",
      value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
```

- [ ] **Step 3a: Add `decideAll` — sequential handler chain runs**

```ts
async function decideAll(s: RunSession, entries: IpcBatchInterruptEntry[]): Promise<BatchDecisionEntry[]> {
  // Sequential rather than concurrent: ctx.handlers is shared state.
  // Mirrors today's runHandlerChain ordering semantics.
  const out: BatchDecisionEntry[] = [];
  for (const e of entries) out.push(await decideInterrupt(s, e));
  return out;
}
```

- [ ] **Step 3b: Add `buildAutoResumePayload` — declarative payload for fast-path respawn**

```ts
function buildAutoResumePayload(
  msg: IpcInterruptBatchMessage,
  decisions: BatchDecisionEntry[],
): { interrupts: any[]; responses: any[] } {
  const interrupts = msg.interrupts.map((entry) => ({
    kind: entry.kind, message: entry.message, data: entry.data, origin: entry.origin,
    interruptId: entry.interruptId,
    checkpoint: msg.sharedCheckpoint,
    runId: msg.runId, compiledPath: msg.compiledPath,
  }));
  const responses = decisions.map((d) => ({ type: d.outcome, value: d.value }));
  return { interrupts, responses };
}
```

- [ ] **Step 3c: Add `handleInterruptBatchMessage` — orchestration only**

The function reads top-to-bottom as a sequence of declarative steps. All imperative work is delegated to helpers.

```ts
async function handleInterruptBatchMessage(s: RunSession, msg: IpcInterruptBatchMessage): Promise<void> {
  const decisions = await decideAll(s, msg.interrupts);
  const anyPropagate = decisions.some((d) => d.outcome === "propagate");
  if (anyPropagate) {
    throw new Error("TODO Task 5: propagation path not yet implemented");
  }
  // Fast path: every interrupt auto-resolved. Mark old session settled
  // before respawn so the original subprocess's `close` event (it exited
  // after sending the batch) doesn't try to settle a second time.
  s.settled = true;
  clearTimer(s);
  try { s.child.kill("SIGKILL"); } catch (_) { /* already gone */ }
  const { interrupts, responses } = buildAutoResumePayload(msg, decisions);
  void _runResumeInternal(s, msg.compiledPath, interrupts, responses);
}
```

Add the `_runResumeInternal` helper using the `spawnSubprocess` extracted in Task 3.5:

```ts
function _runResumeInternal(
  s: RunSession,
  compiledPath: string,
  interrupts: any[],
  responses: any[],
): void {
  const newSession = spawnSubprocess({
    ctx: s.ctx,
    stateStack: s.stateStack,
    limits: s.limits,
    compiledPath,
    resolvePromise: s.resolvePromise,
    rejectPromise: s.rejectPromise,
  });
  const resumeMsg = {
    type: "resume",
    scriptPath: compiledPath,
    runId: s.ctx.getRunId(),
    interrupts,
    responses,
    ipcPayload: s.limits.ipcPayload,
  };
  ipcLog("send", resumeMsg);
  newSession.child.send(resumeMsg);
}
```

Wire the new handler into the main message dispatcher in `handleChildMessage`:

```ts
if (msg.type === "interrupt") {
  await handleInterruptMessage(s, msg);
} else if (msg.type === "interrupt-batch") {
  await handleInterruptBatchMessage(s, msg);
} else if (msg.type === "result") {
  settle(s, s.resolvePromise, msg.value);
} else if (msg.type === "error") {
  handleErrorMessage(s, msg);
}
```

- [ ] **Step 4: Run the test from Step 1**

Run: `pnpm test:run tests/agency-js/subprocess-batch-auto-approve 2>&1 | tee /tmp/task4-test-pass.log`
Expected: PASS.

- [ ] **Step 5: Run all subprocess tests to ensure no regression**

Run: `pnpm run a test tests/agency/subprocess 2>&1 | tee /tmp/task4-regress.log`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/ipc.ts tests/agency-js/subprocess-batch-auto-approve
git commit -m "feat: parent handleInterruptBatchMessage fast path (all-auto-resolved respawn)"
```

---

### Task 5: Parent — propagation path (slow path): surface propagating subset, stash auto-resolved siblings

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 1: Write the failing test FIRST**

Create `tests/agency-js/subprocess-batch-propagate/`:

```agency
def confirmItem(item: string): boolean {
  return interrupt("Confirm: ${item}", { item })
}

node main(items: string[]): boolean[] {
  return fork(items) as item {
    confirmItem(item)
  }
}
```

Test (`test.js`): run `main` with no parent handler. Expect the result to be `Interrupt[]` of length 2 (both `kind: "user"`). Approve both via `respondToInterrupts([i0, i1], [{type: "approve", value: true}, {type: "approve", value: true}])`. Expect the final result `[true, true]`.

Run: `pnpm test:run tests/agency-js/subprocess-batch-propagate 2>&1 | tee /tmp/task5-test-fail.log`
Expected: FAIL — the current handler throws the "TODO Task 5" error.

- [ ] **Step 2a: Partition decisions**

In `handleInterruptBatchMessage`, replace `throw new Error("TODO Task 5: ...")` with:

```ts
if (!anyPropagate) { /* fast path, already implemented in Task 4 */ }
// Slow path begins.
const propagating = decisions.filter((d) => d.outcome === "propagate");
const autoResolved = decisions.filter((d) => d.outcome !== "propagate");
```

- [ ] **Step 2b: Build siblings and surfaced interrupts via helpers**

Delegate the imperative work to the Task 1.5 helpers:

```ts
const { siblings, responses: siblingResponses } = buildBatchSiblings(msg, autoResolved);
const surfaced = buildSurfacedInterrupts(msg, propagating, {
  siblings,
  siblingResponses,
  propagatingCount: propagating.length,
});
```

- [ ] **Step 2c: Tear down the subprocess and settle with the surfaced interrupts**

```ts
s.propagated = true;
leakedTempDirs.add(dirname(s.compiledPath));
try { s.child.kill("SIGKILL"); } catch (_) { /* already gone */ }
settle(s, s.resolvePromise, surfaced);
return;
```

- [ ] **Step 3: Modify `_run` resume entry to merge sibling responses via helpers**

At the top of `_run` (or wherever the resume path branches), when `interrupts.length > 0 && responses.length > 0`, replace any inline merge with two helper calls:

```ts
import { assertNoPartialBatchResponse, mergeBatchResumePayload } from "./batchResume.js";

assertNoPartialBatchResponse(interrupts);  // throws on partial response
const { interrupts: fullInterrupts, responses: fullResponses } =
  mergeBatchResumePayload(interrupts, responses);
// Hand fullInterrupts + fullResponses to the existing ResumeInstruction path
// (prior plan's Task 3 Step 2). The helper already stripped _batchResumeContext.
```

The reason for two separate helpers: `assertNoPartialBatchResponse` is a side-effect-free precondition check; `mergeBatchResumePayload` is the construction step. Keeping them split lets tests verify each in isolation and the call site reads like a sentence: "Validate. Build. Use."

All the imperative dedupe + strip logic lives inside `mergeBatchResumePayload` (Task 1.5). The `_run` resume entry only needs the two helper calls shown above.

- [ ] **Step 4: Run the test from Step 1**

Run: `pnpm test:run tests/agency-js/subprocess-batch-propagate 2>&1 | tee /tmp/task5-test-pass.log`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ipc.ts tests/agency-js/subprocess-batch-propagate
git commit -m "feat: parent surfaces batched propagation; resume merges auto-resolved siblings"
```

---

### Task 6: Integration test — mixed propagation (some auto-resolved, some propagating)

**Files:**
- Create: `tests/agency-js/subprocess-batch-mixed/agent.agency`
- Create: `tests/agency-js/subprocess-batch-mixed/test.js`
- Create: `tests/agency-js/subprocess-batch-mixed/fixture.json`

- [ ] **Step 1: Write the agent**

```agency
def confirmItem(item: string): string {
  return interrupt("Confirm: ${item}", { item, action: classify(item) })
}

def classify(item: string): string {
  if (item == "auto") {
    return "auto-approve"
  }
  if (item == "deny") {
    return "auto-reject"
  }
  return "ask-user"
}

node main(items: string[]): string[] {
  return fork(items) as item {
    confirmItem(item)
  }
}
```

- [ ] **Step 2: Write the test**

```js
test("subprocess fork: mixed handler decisions", async () => {
  const compiled = await compile(/* ... */);
  const result = await runWithHandler(compiled, "main", { items: ["auto", "deny", "user"] }, (intr) => {
    if (intr.data.action === "auto-approve") return { type: "approve", value: "approved-by-handler" };
    if (intr.data.action === "auto-reject") return { type: "reject", value: "rejected-by-handler" };
    return undefined;  // propagate
  });

  // Only the "user" item should propagate. The others auto-resolved.
  expect(Array.isArray(result.data)).toBe(true);
  expect(result.data.length).toBe(1);
  expect(result.data[0].data.item).toBe("user");

  // Respond to the propagating interrupt
  const final = await respondToInterrupts(result.data, [
    { type: "approve", value: "approved-by-user" },
  ]);
  expect(final.data).toEqual([
    "approved-by-handler",
    /* reject becomes a Result.failure or surfaces an error per existing semantics; check what fork returns when a branch rejects */,
    "approved-by-user",
  ]);
});
```

**Before writing this assertion, resolve the exact reject semantic.** Run:

```bash
grep -rln "type: \"reject\"\|reject(" tests/agency/fork/handlers/ | head -5
```

Pick a representative test, read it to determine: when a fork branch's handler rejects, does the branch's slot in the fork's result array hold a `Result.failure`, a thrown error, an `undefined`, or something else? Encode that exact shape in the assertion below — do NOT ship a `/* check */` placeholder.

- [ ] **Step 3: Run the test**

Run: `pnpm test:run tests/agency-js/subprocess-batch-mixed 2>&1 | tee /tmp/task6-test.log`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/subprocess-batch-mixed
git commit -m "test: subprocess fork with mixed handler decisions (auto-resolved + propagating)"
```

---

### Task 7: Multi-cycle batched resume test

**Files:**
- Create: `tests/agency-js/subprocess-batch-multi-cycle/agent.agency`
- Create: `tests/agency-js/subprocess-batch-multi-cycle/test.js`
- Create: `tests/agency-js/subprocess-batch-multi-cycle/fixture.json`

- [ ] **Step 1: Write an agent whose fork branches interrupt twice**

```agency
def confirmTwice(item: string): string {
  let first = interrupt("Confirm-1: ${item}", { item, round: 1 })
  let second = interrupt("Confirm-2: ${item}", { item, round: 2, first: first })
  return "${first}-${second}"
}

node main(items: string[]): string[] {
  return fork(items) as item {
    confirmTwice(item)
  }
}
```

- [ ] **Step 2: Write the test**

```js
test("subprocess fork: multi-cycle batched resume", async () => {
  const compiled = await compile(/* ... */);
  let r = await run(compiled, "main", { items: ["a", "b"] });
  expect(r.data.length).toBe(2);
  expect(r.data.every((i) => i.data.round === 1)).toBe(true);

  r = await respondToInterrupts(r.data, [
    { type: "approve", value: "first-a" },
    { type: "approve", value: "first-b" },
  ]);
  expect(r.data.length).toBe(2);
  expect(r.data.every((i) => i.data.round === 2)).toBe(true);

  r = await respondToInterrupts(r.data, [
    { type: "approve", value: "second-a" },
    { type: "approve", value: "second-b" },
  ]);
  expect(r.data).toEqual(["first-a-second-a", "first-b-second-b"]);
});
```

- [ ] **Step 3: Add a cycle-2-mixed-batch sub-test**

Multi-cycle staleness will silently corrupt the response map if a cycle-1 sibling leaks into cycle-2's resume payload. Detect this by making cycle 2 *mixed*: 1 branch propagates, 1 auto-resolves via a parent handler that only fires on round 2. If cycle-1 siblings leaked, cycle 2's resume payload will have more than 2 entries; the resumed subprocess's `respondToInterrupts` will throw `expected 2 responses but got N`. Add this as a second test in the same fixture.

- [ ] **Step 4: Capture and assert the IPC log**

Child stderr is forwarded to parent stderr (per `ipc.ts:401` `attachStdoutForwarder` for `child.stderr`), and `ipcLog` writes to `process.stderr`. Two options to capture in the test:

(a) **Run the agency-js test in a child process via `child_process.spawn`** and read its `stderr`. Mirror an existing test that does this — grep `tests/agency-js/` for `spawn(` or `execSync` to find a template.

(b) **Monkey-patch `process.stderr.write` in the test's `beforeEach`**:
```ts
let stderrCaptured = "";
const origWrite = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  stderrCaptured = "";
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    stderrCaptured += chunk.toString();
    return origWrite(chunk, ...args);
  }) as any;
});
afterEach(() => { process.stderr.write = origWrite; });
```

Use option (a) if any agency-js test already does subprocess-spawning; otherwise (b). Set `AGENCY_IPC_DEBUG=1` via the test's env (option a) or `process.env.AGENCY_IPC_DEBUG = "1"` in beforeAll (option b).

Then assert:
```js
expect(stderrCaptured).toMatch(/send interrupt-batch n=2$/m);
```

This catches any staleness even if the response-map error is suppressed.

- [ ] **Step 5: Run the test**

Run: `pnpm test:run tests/agency-js/subprocess-batch-multi-cycle 2>&1 | tee /tmp/task7-test.log`
Expected: PASS. If FAIL: most likely the shared checkpoint's `branches` map isn't carrying through cycles, OR cycle-1 siblings leaked into cycle-2's resume payload. Debug with `AGENCY_IPC_DEBUG=1` and check the message sequence.

- [ ] **Step 6: Commit**

```bash
git add tests/agency-js/subprocess-batch-multi-cycle
git commit -m "test: subprocess fork batched multi-cycle resume with mixed-cycle staleness check"
```

---

### Task 7.5: Integration test — batched cycle 1, single-interrupt cycle 2

**Why:** Keeping the single-interrupt fast path (block-on-decision) alongside the batched path means a subprocess can interrupt once with a batch and then, after resume, interrupt again with a single non-fork leaf. The two paths use different machinery (no `sharedCheckpoint` in the single path; `_batchSiblings` only on batched-surfaced interrupts). Catch transition bugs early.

**Files:**
- Create: `tests/agency-js/subprocess-batch-then-single/agent.agency`
- Create: `tests/agency-js/subprocess-batch-then-single/test.js`
- Create: `tests/agency-js/subprocess-batch-then-single/fixture.json`

- [ ] **Step 1: Write the agent**

```agency
def confirmA(item: string): boolean {
  return interrupt("A: ${item}", { item, round: "fork" })
}

def confirmB(): boolean {
  return interrupt("B: final", { round: "single" })
}

node main(items: string[]): boolean {
  let forkResults = fork(items) as item {
    confirmA(item)
  }
  // After fork resolves, do a single non-fork interrupt
  return confirmB()
}
```

- [ ] **Step 2: Test the cycle transition**

Run, get the batched cycle-1 interrupts, respond, get the single-interrupt cycle-2 surface, respond, assert final result. The cycle-2 interrupt should NOT carry `_batchSiblings` (it came through the single-interrupt fast path on the respawn).

- [ ] **Step 3: Commit**

```bash
git add tests/agency-js/subprocess-batch-then-single
git commit -m "test: subprocess interrupt cycle transition between batched and single-interrupt paths"
```

---

### Task 8: Integration test — subprocess parallel LLM tool calls

**Files:**
- Create: `tests/agency-js/subprocess-batch-llm-tools/agent.agency`
- Create: `tests/agency-js/subprocess-batch-llm-tools/test.js`
- Create: `tests/agency-js/subprocess-batch-llm-tools/fixture.json`

- [ ] **Step 1: Write an agent where an LLM call produces multiple parallel tool invocations inside a subprocess body**

```agency
def confirmFile(path: string): boolean {
  return interrupt("Delete ${path}?", { path })
}

node main(): string {
  return llm("Confirm and delete /tmp/a.txt and /tmp/b.txt", {
    tools: [confirmFile]
  })
}
```

(If the existing test suite already has a fixture for "LLM calls multiple tools in one response," use the same shape.)

- [ ] **Step 2: Write the test**

```js
test("subprocess parallel LLM tool calls: batched interrupts", async () => {
  const compiled = await compile(/* ... */);
  // Need a fixture for the LLM response: forces it to call confirmFile twice
  // in a single round, both interrupts surface as a batch.
  const r = await run(compiled, "main", {});
  expect(r.data.length).toBe(2);
  expect(r.data.every((i) => i.kind === "user")).toBe(true);
  // Respond to both
  const final = await respondToInterrupts(r.data, [
    { type: "approve", value: true },
    { type: "approve", value: true },
  ]);
  expect(typeof final.data).toBe("string");
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm test:run tests/agency-js/subprocess-batch-llm-tools 2>&1 | tee /tmp/task8-test.log`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/subprocess-batch-llm-tools
git commit -m "test: subprocess parallel LLM tool calls produce batched interrupts"
```

---

### Task 9: Convert the prior plan's fork-guard test to a positive regression test

**Files:**
- Modify: `tests/agency-js/subprocess-fork-guard/` (whichever filename the prior plan created)

- [ ] **Step 1: Locate the existing fork-guard test**

Run: `ls tests/agency-js/subprocess-fork-guard/`

- [ ] **Step 2: Invert its expectations**

The old test expected the error message "Subprocess-side fork/race/LLM-tool/multi-callback propagation is not yet supported." Now the same agent should succeed via the batched path. Update the expected output accordingly. Rename the directory to `tests/agency-js/subprocess-batch-fork-positive/` to reflect its new role.

- [ ] **Step 3: Run**

Run: `pnpm test:run tests/agency-js/subprocess-batch-fork-positive 2>&1 | tee /tmp/task9-test.log`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/subprocess-batch-fork-positive
git rm -r tests/agency-js/subprocess-fork-guard
git commit -m "test: convert fork-guard test into batched-fork positive regression"
```

---

### Task 10: Full regression sweep

- [ ] **Step 1: Run all unit tests**

Run: `pnpm test:run 2>&1 | tee /tmp/task10-unit.log`
Expected: PASS.

- [ ] **Step 2: Run all subprocess tests**

Run: `pnpm run a test tests/agency/subprocess 2>&1 | tee /tmp/task10-sub.log`
Expected: PASS.

- [ ] **Step 3: Run all subprocess agency-js tests**

Run: `pnpm test:run tests/agency-js/subprocess* 2>&1 | tee /tmp/task10-subjs.log`
Expected: PASS.

- [ ] **Step 4: Run all fork tests (no subprocess)**

Run: `pnpm run a test tests/agency/fork 2>&1 | tee /tmp/task10-fork.log`
Expected: PASS — this plan changes IPC-mode behavior only; non-IPC fork must be untouched.

- [ ] **Step 5: Run all LLM-tool tests**

Run: `pnpm run a test tests/agency/fork/llm-tools 2>&1 | tee /tmp/task10-llmtools.log`
Expected: PASS.

- [ ] **Step 6: Commit (no code changes; just confirms green sweep)**

If any test failed, fix the underlying cause and re-run. Do NOT commit a green sweep with a `// TODO` workaround.

```bash
git commit --allow-empty -m "chore: regression sweep green after batched-interrupt landing"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/dev/subprocess-ipc.md`
- Modify: `docs/dev/concurrent-interrupts.md` (cross-link the now-implemented subprocess section)
- Modify: `docs/dev/runBatch.md` (update the "Subprocess-shape (future)" comment to reflect that it's now implemented)

- [ ] **Step 1: Update `subprocess-ipc.md`**

Add/update sections:

1. **The unified IPC interrupt model.** Two paths:
   - **Single-interrupt fast path** (non-runBatch leaf, `localStack === ctx.stateStack`): subprocess blocks on `sendInterruptToParent`; parent decides; subprocess continues inline. Unchanged from the prior plan.
   - **Batched path** (runBatch child, `localStack !== ctx.stateStack`): leaf returns `[interruptObj]`; runBatch collects and stamps shared checkpoint; subprocess bootstrap sends `interrupt-batch` and exits; parent decides each, then either respawns with all decisions baked in (fast path) or surfaces propagating subset to user (slow path).

2. **The `interrupt-batch` message protocol.** Wire schema, `_batchSiblings` / `_batchSiblingResponses` side-channel on surfaced interrupts, response-map merging in `_run` resume.

3. **Mixed propagation semantics.** Only propagating interrupts surface; auto-resolved siblings ride along as hidden state and are merged back into the resume payload.

4. **Multi-cycle.** Each cycle is a fresh subprocess restored from the shared checkpoint; the second cycle's batch is a fresh `interrupt-batch` message with a new shared checkpoint stamped by the resumed subprocess.

5. **Remove** the section that says "subprocess-side fork+propagation is not yet supported." Note in a changelog blurb that the prior plan's Task 6 Step 5 guard was removed.

- [ ] **Step 2: Update `concurrent-interrupts.md`**

Find the "Known limitations" section and remove the "subprocess-side fork+propagation" item (or convert it into a "previously a limitation, now supported via the batched IPC path; see `docs/dev/subprocess-ipc.md`" note).

- [ ] **Step 3: Update `runBatch.md`**

Find the "Subprocess-shape (future)" comment at the top of `lib/runtime/runBatch.ts` and the corresponding section in `runBatch.md`. Update both: the future direction is now implemented; no changes to `runBatch.ts` itself were needed; the implementation lives entirely in `interruptWithHandlers` (return instead of block) + `subprocess-bootstrap` (detect batch + send message) + `ipc.ts` (parent handler).

- [ ] **Step 4: Commit**

```bash
git add docs/dev/subprocess-ipc.md docs/dev/concurrent-interrupts.md docs/dev/runBatch.md lib/runtime/runBatch.ts
git commit -m "docs: subprocess batched-interrupt protocol; remove obsolete limitations"
```

---

## Effort estimate

For an engineer familiar with the runtime (the prior plan landed, they know `runBatch`, subprocess IPC, checkpoints):

| Task | Estimated effort | Risk |
|---|---|---|
| 1. Wire types | 30 min | low |
| 1.5. Declarative helpers + BatchResumeContext + unit tests | 3-4 hr | low — pure TS, fully unit-testable in isolation |
| 2. Bootstrap detects Interrupt[] + sends batch | 1-2 hr | low — uses Task 1.5 helpers, smaller now |
| 3. interruptWithHandlers gates IPC branch, tags _subprocessPropagated, removes fork-guard | 2-3 hr | medium — shared-checkpoint helper extraction is the risk |
| 3.5. Extract spawnSubprocess helper | 1-2 hr | low — pure refactor |
| 4. Parent fast path (auto-resolve respawn) using decideAll + buildAutoResumePayload | 2-3 hr | medium — SIGKILL-vs-close race handling |
| 5. Parent slow path (propagation) using buildBatchSiblings / buildSurfacedInterrupts + resume merge | 2-3 hr | medium — main risk shifted into Task 1.5 helpers |
| 6. Mixed-propagation test | 2-3 hr | low (+ time to resolve the reject semantic) |
| 7. Multi-cycle test + AGENCY_IPC_DEBUG assertion | 3-4 hr | medium — exposes any state-leak between cycles |
| 7.5. Batched + single-interrupt cycle transition test | 2 hr | low |
| 8. Parallel LLM-tools test | 3-4 hr | medium — needs LLM fixture for two tool calls in one response |
| 9. Convert fork-guard test | 30 min | low |
| 10. Regression sweep | 1-2 hr | low |
| 11. Docs | 2 hr | low |
| **Total** | **~26-34 hr (3-4 working days)** | risk redistributed via Task 1.5 |

**Suggested PR shape:** ship as ONE PR — Tasks 4-5 are intertwined and Task 9 depends on both. If reviewer bandwidth demands splitting: "Stage 1: Tasks 1-4 + Task 9 (fast path only, fork-guard still relevant for slow path)" + "Stage 2: Tasks 5-8, 10-11 (slow path, integration, docs)." Stage 1 alone is shippable: subprocesses with always-resolving parent handlers work; the guard error remains for the slow path until Stage 2.

**Risk multipliers:**
- Task 3's refactor of `interruptWithHandlers` must share the checkpoint-creation block with the single-interrupt fast path. If the two paths drift, you'll get subtle "fork resumes from a different checkpoint than the leaf expected" bugs that only surface in multi-cycle tests. Code-review focus on this.
- Task 5's `_batchSiblings`-on-each-surfaced-interrupt replication should be tested with N≥2 propagating interrupts (each surfaced one carries the same siblings) — verify the dedupe in `_run`'s resume merge actually dedupes by `interruptId`.
- Task 7's multi-cycle test is where state-leak between cycles will surface. Run `AGENCY_IPC_DEBUG=1` for the first failing run.
- The IPC payload size budget can grow significantly with replicated `_batchSiblings`. If a future workload has 100+ batch members, this becomes a real cost. Out of scope here; flag in docs.
