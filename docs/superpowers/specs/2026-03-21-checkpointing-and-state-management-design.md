# Checkpointing and State Management Design

## Overview

This design extends Agency's state serialization/deserialization system with:

1. **Programmatic checkpointing** — `checkpoint()` and `restore()` built-in functions that let Agency programs save execution state and roll back to a previous point
2. **Interrupt unification** — reimplementing interrupts as a special case of checkpointing
3. **Per-thread StateStacks** — giving each concurrent async call its own StateStack for execution correctness

## Motivation

Agency's current state serialization exists solely to support interrupts — pause execution, return to the TypeScript caller, and resume later. This design generalizes that mechanism into a more powerful primitive.

**Retry patterns:** LLM calls are non-deterministic. If a call in a chain goes wrong, you want to roll back and try again, potentially with additional context injected into the message threads:

```agency
node main() {
  cp = checkpoint()
  result = llm(prompt)
  if (resultIsBad(result)) {
    restore(cp, { messages: [{ role: "user", content: "Previous response was wrong: " + result }] })
  }
  return result
}
```

**State inspection and debugging:** Save state at key points and restore to explore different execution paths.

**Interrupt simplification:** Interrupts are currently a bespoke mechanism. Reimplementing them on top of checkpoints simplifies the conceptual model: an interrupt is "take a checkpoint, return control to caller, restore on response."

**Per-thread correctness:** Concurrent async calls share a single StateStack, causing frame misalignment. Per-thread stacks fix this.

## Approach

**Approach 1 (chosen): CheckpointStore + RestoreSignal.** Extends existing step-counter + deserialize-mode patterns. `checkpoint()` deep-clones state, `restore()` throws a `RestoreSignal` caught by the node runner. See "Alternatives Considered" for other approaches.

## Design

### 1. CheckpointStore

A new class in `lib/runtime/state/checkpointStore.ts` that stores named snapshots. Lives on `RuntimeContext` alongside `stateStack` and `globals`.

```typescript
type Checkpoint = {
  id: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string;  // which node was active when checkpoint was taken
};

type CheckpointStoreJSON = {
  checkpoints: Record<number, Checkpoint>;
  counter: number;
};

class CheckpointStore {
  private checkpoints: Record<number, Checkpoint> = {};
  private counter = 0;
  private restoreCounts: Record<number, number> = {};
  private maxRestores: number;

  constructor(maxRestores = 100) {
    this.maxRestores = maxRestores;
  }

  create(ctx: RuntimeContext): number {
    const id = this.counter++;
    this.checkpoints[id] = {
      id,
      stack: ctx.stateStack.toJSON(),
      globals: ctx.globals.toJSON(),
      nodeId: ctx.stateStack.currentNodeId(),
    };
    return id;
  }

  get(id: number): Checkpoint | undefined {
    return this.checkpoints[id];
  }

  delete(id: number): void {
    delete this.checkpoints[id];
  }

  // Invalidate all checkpoints with id > the given id
  invalidateAfter(id: number): void {
    for (const key of Object.keys(this.checkpoints)) {
      if (Number(key) > id) {
        delete this.checkpoints[Number(key)];
      }
    }
  }

  trackRestore(id: number): void {
    this.restoreCounts[id] = (this.restoreCounts[id] || 0) + 1;
    if (this.restoreCounts[id] > this.maxRestores) {
      throw new CheckpointError(
        `Checkpoint ${id} has been restored ${this.maxRestores} times. Possible infinite loop.`
      );
    }
  }

  toJSON(): CheckpointStoreJSON {
    return {
      checkpoints: deepClone(this.checkpoints),
      counter: this.counter,
    };
  }

  static fromJSON(json: CheckpointStoreJSON, maxRestores = 100): CheckpointStore {
    const store = new CheckpointStore(maxRestores);
    store.checkpoints = json.checkpoints;
    store.counter = json.counter;
    return store;
  }
}
```

`maxRestores` is configurable via `AgencyConfig` (the `agency.json` configuration file) under a new `checkpoints.maxRestores` key. If not set, defaults to 100.

The `currentNodeId()` helper is a new method on `StateStack` that encapsulates `this.nodesTraversed[this.nodesTraversed.length - 1]`, avoiding duplication of this logic across `CheckpointStore`, `respondToInterrupt`, etc.

### 2. RestoreSignal and CheckpointError

New error classes in `lib/runtime/errors.ts`:

```typescript
type RestoreOptions = {
  messages?: MessageJSON[];  // messages to inject into threads after restore
  // extensible — future options can be added here
};

class RestoreSignal extends Error {
  checkpoint: Checkpoint;
  options?: RestoreOptions;

  constructor(checkpoint: Checkpoint, options?: RestoreOptions) {
    super("RestoreSignal");
    this.name = "RestoreSignal";
    this.checkpoint = checkpoint;
    this.options = options;
  }
}

class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}
```

`CheckpointError` follows the same pattern as existing `ConcurrentInterruptError` and `ToolCallError` in `lib/runtime/errors.ts`.

### 3. RuntimeContext changes

Add `CheckpointStore` to `RuntimeContext` and a `restoreState()` method:

```typescript
class RuntimeContext<T> {
  stateStack: StateStack;
  globals: GlobalStore;
  checkpoints: CheckpointStore;  // NEW
  // ... existing fields ...

  restoreState(checkpoint: Checkpoint): void {
    // Preserve token stats before overwriting globals
    const currentTokenStats = this.globals.getTokenStats();
    this.stateStack = StateStack.fromJSON(checkpoint.stack);
    this.stateStack.deserializeMode();
    this.globals = GlobalStore.fromJSON(checkpoint.globals);
    // Token stats are an accounting concern, not execution state — preserve them
    this.globals.restoreTokenStats(currentTokenStats);
    // Clear pending promises — they belong to the discarded execution
    this.pendingPromises.clear();
  }

  createExecutionContext(): RuntimeContext<T> {
    // ... existing logic ...
    execCtx.checkpoints = new CheckpointStore();  // NEW
    return execCtx;
  }
}
```

Note: `restoreState()` also clears `pendingPromises` and preserves token stats. Token stats (`__tokenStats` in the `__internal` module of `GlobalStore`) are an accounting concern — they track cumulative token usage and cost. Rolling them back would cause inaccurate cost reporting. A new `restoreTokenStats()` method on `GlobalStore` copies the current token stats into the restored store.

### 4. checkpoint() runtime function

```typescript
// lib/runtime/checkpoint.ts
async function checkpoint(ctx: RuntimeContext): Promise<number> {
  await ctx.pendingPromises.awaitAll();  // ensure all state is fully resolved
  return ctx.checkpoints.create(ctx);
}
```

Async because it awaits pending promises before snapshotting. This ensures the checkpoint always contains fully resolved state — no promises, no partial values.

`checkpoint()` is valid inside both nodes and functions. When called deep inside a function call chain (e.g., 3 function calls deep inside a node), the checkpoint captures the full StateStack including all frames. On restore, execution re-enters at the node level and replays through the function calls via step counters and deserialize mode, restoring each frame from the checkpoint's StateStack — this is the same mechanism interrupts use today.

Note: we need a compile-time check to ensure a user never calls `checkpoint()` with `async`.

### 5. restore() runtime function

```typescript
// lib/runtime/checkpoint.ts
function restore(ctx: RuntimeContext, checkpointId: number, options?: RestoreOptions): never {
  const cp = ctx.checkpoints.get(checkpointId);
  if (!cp) {
    throw new CheckpointError(`Checkpoint ${checkpointId} does not exist or has been deleted`);
  }
  ctx.checkpoints.trackRestore(checkpointId);
  ctx.checkpoints.invalidateAfter(checkpointId);
  ctx.pendingPromises.clear();  // discard pending work from the discarded execution
  throw new RestoreSignal(cp, options);
}
```

Key behaviors:
- **Never returns** — always throws `RestoreSignal`
- **Invalidates later checkpoints** — checkpoints taken after this one are deleted (they belong to the discarded execution)
- **Discards pending promises** — pending async work from the discarded execution is cleared, not awaited. Note: the underlying Promises still run to completion in the JavaScript runtime (they can't be cancelled), but their results are ignored and they hold no references to the execution context. If those promises have side effects (API calls, database writes), those side effects will still occur. This is a known limitation.
- **Tracks restore count** — throws `CheckpointError` if max restores exceeded (infinite loop protection)

### 6. Node runner catches RestoreSignal

`RestoreSignal` is caught in `runNode()` (`lib/runtime/node.ts`), NOT in `SimpleMachine.run()`. SimpleMachine is a generic graph engine with no knowledge of Agency runtime types — adding restore logic there would violate its separation of concerns.

The `runNode` function wraps the `graph.run()` call in a retry loop:

```typescript
// lib/runtime/node.ts
export async function runNode({ ctx, nodeName, data, messages, callbacks, initializeGlobals }) {
  const execCtx = ctx.createExecutionContext();
  if (initializeGlobals) initializeGlobals(execCtx);
  execCtx.callbacks = callbacks || {};

  // ... existing onAgentStart hook ...

  let isResume = false;
  try {
    while (true) {
      try {
        const threadStore = new ThreadStore();
        const result = await execCtx.graph.run(nodeName, {
          messages: threadStore,
          data,
          ctx: execCtx,
          isResume,
        }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
        await execCtx.pendingPromises.awaitAll();

        // ... existing return logic ...
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);

          // Inject extra messages if provided
          if (e.options?.messages) {
            // Inject into the top frame's thread store in the restored state
          }

          // Update for re-entry: `continue` jumps back to the top of
          // the while loop, which calls graph.run() again with the
          // restored state and updated nodeName.
          nodeName = cp.nodeId;
          data = {};       // data is in the restored stack
          isResume = true;  // stack is in deserialize mode — step counters must skip ahead
          continue;
        }
        throw e;  // re-throw non-RestoreSignal errors
      }
    }
  } finally {
    execCtx.cleanup();
  }
}
```

The same pattern applies to `respondToInterrupt()` and `resumeFromState()` — both need to catch `RestoreSignal` and loop.

Note on `nodesTraversed`: After `restoreState()`, the restored `StateStack` has `nodesTraversed` from checkpoint time. Since `graph.run()` pushes new entries via `onNodeEnter`, the array can grow across restores. After extracting `cp.nodeId` for re-entry, the restored `nodesTraversed` should be truncated to avoid unbounded growth: `execCtx.stateStack.nodesTraversed = [cp.nodeId];`

### 7. RestoreSignal in generated try/catch blocks

Agency does not currently have try/catch as a language feature. However, the builder generates try/catch blocks internally (e.g., wrapping function bodies for cleanup). These generated catch blocks must re-throw `RestoreSignal` to prevent it from being swallowed:

```typescript
// In any builder-generated try/catch:
try {
  // generated code
} catch (__e) {
  if (__e instanceof RestoreSignal) throw __e;
  // existing catch logic
}
```

This is the same pattern used for interrupt propagation.

Specifically, the function-body try/catch generated in `typescriptBuilder.ts` (~lines 1020-1038) that handles `ToolCallError` retries must re-throw `RestoreSignal` before the `ToolCallError` check. Without this guard, a `RestoreSignal` thrown from inside a function body would be caught and wrapped in a `ToolCallError`, losing its identity.

If try/catch is ever added as an Agency language feature, the same re-throw guard must be applied to user-authored catch blocks.

### 8. Interrupt unification

Interrupts become a special case of checkpointing.

#### Updated Interrupt type

```typescript
// Before:
type Interrupt<T> = {
  type: "interrupt";
  data: T;
  interruptData?: InterruptData;
  state?: InterruptState;  // { stack, globals } embedded directly
};

// After:
type Interrupt<T> = {
  type: "interrupt";
  data: T;
  interruptData?: InterruptData;
  checkpointId: number;
  checkpoint?: Checkpoint;  // included when exported for cross-process resume
};
```

#### Interrupt triggering

There are two places where interrupts are triggered:

**1. Generated code (template-generated interrupt assignments/returns):**

```typescript
// Before:
const __interruptResult = interrupt(data);
__interruptResult.state = __ctx.stateToJSON();
return __interruptResult;

// After:
const __checkpointId = __ctx.checkpoints.create(__ctx);
const __interruptResult = interrupt(data);
__interruptResult.checkpointId = __checkpointId;
__interruptResult.checkpoint = __ctx.checkpoints.get(__checkpointId);  // for cross-process
return __interruptResult;
```

**2. Runtime prompt loop (`lib/runtime/prompt.ts`, ~line 475):**

The interrupt triggered inside the prompt loop (when a tool call is interrupted) also needs to use checkpoints:

```typescript
// Before (prompt.ts):
interrupt.state = ctx.stateToJSON();
return interrupt;

// After (prompt.ts):
const checkpointId = ctx.checkpoints.create(ctx);
interrupt.checkpointId = checkpointId;
interrupt.checkpoint = ctx.checkpoints.get(checkpointId);
return interrupt;
```

#### respondToInterrupt changes

```typescript
async function respondToInterrupt(args) {
  const { ctx, interrupt, interruptResponse } = args;

  // Get checkpoint from store or from exported data (cross-process)
  const checkpoint = ctx.checkpoints?.get(interrupt.checkpointId)
    ?? interrupt.checkpoint;

  if (!checkpoint) {
    throw new CheckpointError("No checkpoint found for interrupt. The interrupt may have been created with an older format.");
  }

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint);

  // ... existing interruptData setup (interruptResponse, modify handling) ...

  let nodeName = checkpoint.nodeId;
  // Wrap in RestoreSignal catch loop (same pattern as runNode)
  while (true) {
    try {
      const result = await execCtx.graph.run(nodeName, {
        ctx: execCtx,
        isResume: true,
        interruptData,
        messages: new ThreadStore(),
        data: {},
      }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
      await execCtx.pendingPromises.awaitAll();
      return createReturnObject({ result, globals: execCtx.globals });
    } catch (e) {
      if (e instanceof RestoreSignal) {
        execCtx.restoreState(e.checkpoint);
        nodeName = e.checkpoint.nodeId;
        continue;
      }
      throw e;
    }
  }
}
```

#### Migration

Since interrupts are transient (not stored long-term), the type change is not a breaking persistence concern. A compatibility shim detects the old `state` field format and converts:

```typescript
// In respondToInterrupt:
if (interrupt.state && !interrupt.checkpoint) {
  // Old format — convert inline. Read nodesTraversed directly from the JSON
  // rather than constructing a full StateStack object.
  const nodesTraversed = interrupt.state.stack.nodesTraversed || [];
  interrupt.checkpoint = {
    id: -1,
    stack: interrupt.state.stack,
    globals: interrupt.state.globals,
    nodeId: nodesTraversed[nodesTraversed.length - 1],
  };
}
```

#### Deprecation of `stateToJSON()`

After interrupt unification, the `stateToJSON()` method on `RuntimeContext` is no longer used by interrupts. It can be deprecated in favor of `checkpoints.create()` and deleted.


### 9. Per-thread StateStacks

Each async call gets its own StateStack instead of sharing the parent's.

#### RuntimeContext changes

```typescript
class RuntimeContext<T> {
  stateStack: StateStack;
  childStacks: StateStack[];  // NEW

  forkStack(): StateStack {
    const child = new StateStack();
    this.childStacks.push(child);
    return child;
  }
}
```

#### InternalFunctionState type change

Add an optional `stateStack` field to `InternalFunctionState` (`lib/runtime/types.ts`):

```typescript
type InternalFunctionState = {
  threads: ThreadStore;
  ctx: RuntimeContext<GraphState>;
  interruptData?: InterruptData;
  isToolCall?: boolean;
  stateStack?: StateStack;  // NEW — per-thread stack for async calls
};
```

#### Generated code changes

Only async function calls pass a forked stack. Synchronous calls continue using the parent's `ctx.stateStack` as they do today — they execute sequentially and don't have interleaving issues.

```typescript
// Synchronous call (unchanged):
__self.x = myFunc(arg, { ctx: __ctx, threads: __threads });

// Async call (NEW — gets its own stack):
const __childStack_x = __ctx.forkStack();
__self.x = myFunc(arg, { ctx: __ctx, stateStack: __childStack_x, threads: __threads });
```

The builder generates the `forkStack()` call for any function call marked as `async` in the preprocessor.

#### setupFunction changes

```typescript
function setupFunction(args) {
  const { state } = args;
  if (state === undefined) {
    // Called as a tool by the LLM — fresh stack
    const stateStack = new StateStack();
    const stack = stateStack.getNewState();
    return { stack, step: 0, self: stack.locals, threads: new ThreadStore() };
  }

  // Use the per-thread stack if provided, otherwise fall back to ctx.stateStack
  const stateStack = state.stateStack ?? state.ctx.stateStack;
  const stack = stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;
  const threads = state.threads || new ThreadStore();

  return { stack, step, self, threads };
}
```

#### Serialization scope (phase 1)

Per-thread stacks solve execution correctness (no frame misalignment), but serialization continues to use `awaitAll()` before any checkpoint/interrupt. This means:
- At checkpoint time, all child stacks are empty (all async work completed)
- Only the main stack is serialized
- No multi-thread restore complexity
- Per-thread checkpointing/interrupts are deferred to a future phase

### 10. Agency language surface

Two new built-in functions:

**`checkpoint(): number`** — saves current execution state, returns checkpoint ID

**`restore(checkpointId: number, options?: RestoreOptions): never`** — rolls back to checkpoint, never returns

```agency
type RestoreOptions = {
  messages?: Message[]  // messages to inject into threads after restore
}
```

#### Code generation

```typescript
// checkpoint() compiles to:
__self.cp = await __runtime.checkpoint(__ctx);

// restore(cp) compiles to:
__runtime.restore(__ctx, __self.cp);

// restore(cp, { messages: [...] }) compiles to:
__runtime.restore(__ctx, __self.cp, { messages: [...] });
```

#### Where these live

- **Runtime functions**: `lib/runtime/checkpoint.ts`
- **Built-in definitions**: Added to `lib/runtime/builtins.ts`
- **Builder**: Cases added to `processNode` in `typescriptBuilder.ts`
- **No parser changes needed** — these are regular function calls, not new syntax

### 11. Checkpoint lifecycle

When a checkpoint is **created**:
- All pending promises are awaited first
- StateStack + GlobalStore are deep-cloned and stored
- Shared variables are NOT included (they're persistent/cached, not rolled back)
- Checkpoint ID is returned

When a checkpoint is **restored**:
- All checkpoints with later IDs are invalidated/deleted
- Pending promises are discarded (not awaited — see known limitations in Section 5)
- StateStack and GlobalStore are restored from the snapshot
- Token stats are preserved (not rolled back — they're accounting data)
- The checkpoint itself remains valid for future restores
- Restore count is incremented (max-restore protection)
- `RestoreSignal` is thrown
- Node runner catches it, puts context in deserialize mode, re-enters from the checkpointed node
- Step counters skip past already-executed statements

When a checkpoint is **exported** (for cross-process resume):
- The full `Checkpoint` object is serialized as JSON
- This is what happens with interrupts — the checkpoint data is included in the `Interrupt` object returned to the TypeScript caller
- The `CheckpointStore` itself is not serialized cross-process; the receiver creates a fresh store. Checkpoint IDs restart from 0 on the new process.

## What gets rolled back vs preserved

| State | Rolled back on restore? | Notes |
|-------|------------------------|-------|
| StateStack (call stack, locals, step counters) | Yes | Core of the rollback |
| GlobalStore (global variables per module) | Yes | Full rollback to checkpoint state |
| Message threads | Yes | Part of StateStack frames |
| Token stats (`__tokenStats`) | No | Accounting data — preserved across restores |
| Shared variables | No | Persistent by design |
| CheckpointStore | Partially | Later checkpoints deleted, earlier ones kept |
| PendingPromiseStore | Cleared | Pending work from discarded execution is dropped |

## Audit logging

When execution is restored and replays through step counters, already-executed statements are skipped — their audit log entries are NOT re-emitted. However:
- The node re-entry itself produces a new audit entry (via `ctx.audit({ type: "nodeEntry" })`)
- Function re-setup produces new audit entries (via `onFunctionStart` hooks)
- A new `restore` audit entry type should be emitted when `RestoreSignal` is caught and processed

This means audit logs after a restore show: `restore → nodeEntry → (skipped steps) → resumed execution`. Users relying on audit logs for debugging should be aware that restored execution does not replay earlier audit entries.

## Error handling

| Scenario | Behavior |
|----------|----------|
| `restore()` with invalid checkpoint ID | Throws `CheckpointError` |
| `restore()` exceeds max restore count | Throws `CheckpointError` (infinite loop protection, configurable via `agency.json` `checkpoints.maxRestores`, default: 100) |
| `restore()` inside generated try/catch | `RestoreSignal` re-thrown past catch blocks |
| `restore()` with pending async work | Pending promises discarded (not awaited) |
| `checkpoint()` with pending async work | Awaits all pending promises first, then snapshots |

## Testing strategy

### Unit tests

- `CheckpointStore`: create, get, delete, invalidateAfter, trackRestore, toJSON/fromJSON
- `CheckpointError`: construction, message
- `RestoreSignal`: construction, properties
- `RuntimeContext.restoreState()`: deserialization, deserialize mode, token stats preserved
- `StateStack.currentNodeId()`: returns last element of nodesTraversed

### Integration tests (fixture pairs)

1. **Basic checkpoint/restore** — checkpoint, modify state, restore, verify state rolled back
2. **Checkpoint with message injection** — restore with extra messages, verify they appear in thread
3. **Multiple checkpoints** — create several, restore to an earlier one, verify later ones deleted
4. **Restore same checkpoint twice** — verify second restore works and state is correct
5. **Checkpoint + interrupt** — verify interrupt now uses checkpoint mechanism
6. **Interrupt resume backward compatibility** — verify old-format interrupt states still work (migration shim)
7. **Restore past generated try/catch** — verify RestoreSignal propagates through builder-generated catch blocks
8. **Max restore count** — verify CheckpointError after exceeding limit
9. **Checkpoint with async calls** — verify awaitAll before checkpoint
10. **Restore discards pending promises** — verify pending work is cleared
11. **Per-thread StateStacks** — verify concurrent async calls don't interfere with each other's frames
12. **Shared variables survive restore** — verify shared vars are not rolled back
13. **Token stats survive restore** — verify token usage accounting is not rolled back
14. **Checkpoint inside a function** — verify checkpoint/restore works when called from a `def`, not just from a node
15. **Audit logging on restore** — verify restore audit entry is emitted and skipped steps don't produce duplicate entries

### End-to-end tests

- Retry loop with LLM call (mock) — checkpoint, call LLM, check result, restore with feedback message, verify second attempt has the injected message

## Alternatives considered

### Approach 2: Caller-side checkpoints only

`checkpoint()` returns serialized state to the TypeScript caller. Restoration happens by the caller invoking `restoreFromCheckpoint()`. Simpler but prevents in-process retry loops within Agency code — the retry logic leaks into TypeScript.

### Approach 3: Copy-on-write execution contexts

Persistent data structures with structural sharing. Checkpoint creation is O(1) instead of O(state size). But requires Proxy wrapping on all state objects (per-operation overhead), and still needs RestoreSignal + step-counter replay for the restore mechanism. Doesn't justify the complexity given Agency's small state sizes and infrequent checkpoints relative to LLM call latency.

## Future work

- **Automatic checkpointing before LLM calls** — configurable option to `checkpoint()` before every LLM call, enabling automatic retry/rewind on failure
- **Per-thread checkpointing/interrupts** — allow individual async threads to checkpoint and interrupt independently, with response routing to the correct thread
- **Checkpoint persistence** — save checkpoints to disk for crash recovery, or expose via a callback for external storage
- **Checkpoint diffing** — compare two checkpoints to see what changed between them (useful for debugging)
- **Explicit checkpoint cleanup** — a `deleteCheckpoint(id)` built-in for programs that create many checkpoints and want to manage memory pressure
- **Language-level try/catch** — if Agency adds try/catch as a language feature, RestoreSignal must be re-thrown past user catch blocks (same guard already in place for generated catch blocks)
