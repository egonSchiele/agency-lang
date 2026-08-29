# Checkpointing — Codebase Review

## Overview

Checkpointing lets an Agency program snapshot its execution state, keep running, and later restore back to that snapshot. That is what makes retry loops, rollback on failure, and external persistence of execution state possible.

The core API has three functions:
- `checkpoint()` — snapshot the current state and return a numeric ID
- `getCheckpoint(id)` — retrieve the full checkpoint object for an ID, ready to serialize
- `restore(idOrCheckpoint, options)` — roll back to a checkpoint. It accepts either a numeric ID or a `Checkpoint` object.

---

## How are checkpoints implemented?

### Core types

**`Checkpoint`** is a class in `lib/runtime/state/checkpointStore.ts`:

```typescript
class Checkpoint {
  id: number;               // incrementing numeric ID
  stack: StateStackJSON;    // serialized call stack (frames, locals, step counters, threads)
  globals: GlobalStoreJSON; // serialized global variables per module
  nodeId: string;           // which graph node was active when the checkpoint was taken
  moduleId: string;         // source location, three parts
  scopeName: string;
  stepPath: string;
  label: string | null;     // a human-readable tag, used by pinned checkpoints
  pinned: boolean;          // pinned checkpoints survive rolling eviction and dedup
}
```

A checkpoint is a deep clone of the `StateStack` and `GlobalStore` at the moment it was created, so checkpoint data is always JSON-serializable.

The three source-location fields identify where in the program the checkpoint was taken. `getLocation()` renders them as `moduleId:scopeName#stepPath`, which is the key the per-location restore cap uses.

### CheckpointStore

`CheckpointStore` (`lib/runtime/state/checkpointStore.ts`) manages all checkpoints for an execution context.

Key behavior:
- **ID generation**: a module-level `globalCheckpointCounter` hands out 0, 1, 2, and so on. The counter is preserved across serialization, so a resumed execution continues from the correct next ID. Note that the counter is module-global, not per-store, so ids stay unique across stores in one process.
- **Infinite loop protection**: `trackRestore(id)` counts how many times each checkpoint has been restored, and throws `CheckpointError` past `maxRestores` (default 100, configurable in `agency.json`). `runNode()` enforces a second, whole-run cap with the same limit. `trackLocationRestore` counts restores per source location, which backs the `maxRestores` option on `restore()`.
- **Invalidation**: `deleteAfterCheckpoint(id)` removes every checkpoint newer than the one being restored. This prevents restoring to a "future" checkpoint after rolling back.
- **Rolling checkpoints**: `createRolling` replaces the unpinned checkpoint at the same location, strips `__dbg_` locals, and evicts down to `maxSize`. `createPinned` opts out of both.
- **Serialization**: `toJSON()` / `fromJSON()` support for interrupt persistence.

Each execution context, built by `RuntimeContext.createExecutionContext()`, gets its own `CheckpointStore`, so concurrent calls do not share checkpoint state.

### Runtime functions

All three functions live in `lib/runtime/checkpoint.ts`. None of them take a `__state` parameter. Each reads the ambient frame with `getRuntimeContext()`, the `agencyStore` AsyncLocalStorage seam described in [`async-context.md`](./async-context.md).

**`checkpoint()`**:
1. Awaits all pending async promises, so the snapshot is consistent
2. Calls `ctx.checkpoints.create(ctx.stateStack, ctx, location)`, which deep-clones StateStack and GlobalStore
3. Returns the numeric ID

The location comes from the active frame's `callsite` slot, which `Runner.runInScope` seeds for every step body. A call made outside a runner step, such as from bootstrap scope, falls back to the empty `""::""::""` location.

**`getCheckpoint(checkpointId)`**:
1. Looks up the checkpoint by ID in the store
2. Returns the `Checkpoint` object, ready for external serialization
3. Throws `CheckpointError` if the ID does not exist

**`restore(checkpointIdOrCheckpoint, options)`**:
1. Accepts either a numeric ID, looked up in the store, or a `Checkpoint` object directly
2. Returns silently, without restoring, when `options.maxRestores` is set and this checkpoint's source location has already hit that many restores
3. Calls `trackRestore()` for infinite-loop protection, and `trackLocationRestore()` when `options.maxRestores` is set
4. Calls `deleteAfterCheckpoint()` to delete later checkpoints
5. Clears pending promises, discarding in-flight async work
6. Throws `RestoreSignal`, so it never returns

### How restore works end-to-end

`restore()` throws a `RestoreSignal` exception. This propagates up through the generated code and is caught by the node runner loop in `runNode()` (`lib/runtime/node.ts`):

```
restore() → throws RestoreSignal
  → caught in runNode() retry loop
  → bumps execCtx._restoreCount, throws CheckpointError past execCtx.maxRestores
  → emits a checkpointRestored statelog event
  → calls ctx.restoreState(checkpoint)
  → applies options.args and options.globals overrides
  → re-enters the checkpointed node with deserialized state
  → step counters skip past already-executed statements
```

`RuntimeContext.restoreState()` (`lib/runtime/state/context.ts`):
1. Saves current token stats, because accounting data should not roll back
2. Revives the checkpoint's stack and globals JSON, then deserializes `StateStack` and enters deserialize mode
3. Deserializes `GlobalStore` from the checkpoint
4. Restores token stats onto the new GlobalStore
5. Clears pending promises

`options.globals` is applied afterwards by `runNode()`, and only against the checkpoint's own `moduleId`. Globals from other imported files come back from the checkpoint unchanged.

The step counter mechanism (the `if (__step <= N)` guards in generated code) ensures that on restore, execution resumes at the exact statement where the checkpoint was taken.

### RestoreOptions

`restore()` takes an `options` parameter, defined in `lib/runtime/errors.ts`:

```typescript
type RestoreOptions = {
  messages?: MessageJSON[];
  args?: Record<string, any>;
  globals?: Record<string, any>;
  maxRestores?: number;
};
```

`messages` injects messages into the restored state, which is useful for explaining why the restore happened. `args` overrides the restored node's arguments. `globals` overrides globals defined in the checkpoint's own module. `maxRestores` caps how many times this source location may be restored; past the cap `restore()` returns instead of throwing, so the program falls through rather than failing.

---

## What gets rolled back vs preserved?

| State | Rolled back? | Why |
|-------|-------------|-----|
| StateStack (locals, args, step counters) | Yes | Core of the rollback mechanism |
| GlobalStore (module-scoped globals) | Yes | Full state rollback |
| Message threads | Yes | Stored in StateStack frames |
| `static` values | **No** | Initialized once per process, outside the checkpointed globals |
| State held in imported JS modules | **No** | Never serialized, so it lives outside the rollback |
| Token stats | **No** | Accounting data should accumulate, not reset |
| Later checkpoints (ID > restored) | Deleted | Prevents inconsistent timeline |
| Pending promises | Cleared | In-flight async work is discarded |

Something has to survive the rollback for a retry loop to terminate. That is why the loop counter usually lives outside the GlobalStore, either as a `static` value or in a plain JS module the program imports.

A checkpoint whose thread has since been repaired is stale. See "Reopen repair"
in [`threads.md`](./threads.md). `restoreThreadForResume` (in
`lib/runtime/threadRepair.ts`) throws rather than letting the old snapshot
overwrite the repaired thread. `MessageThread.repairs` is the generation number
both sides compare, and `markRepaired()` is its only writer.

---

## Configuration

In `agency.json`:
```json
{
  "checkpoints": {
    "maxRestores": 100
  }
}
```

`maxRestores` limits how many times any single checkpoint can be restored before throwing `CheckpointError`. This prevents infinite restore loops.

---

## Code generation

The imports template (`lib/templates/backends/typescriptGenerator/imports.mustache`) imports the three implementations and wraps each one in an `__AgencyFunction`, so generated code calls them exactly like any other Agency function. There is no injected `__state` argument; each implementation reads the ambient frame itself.

Generated code for `const cp = checkpoint()`:
```typescript
__stack.locals.cp = await __call(checkpoint, {
  type: "positional",
  args: []
});
```

Generated code for `restore(cp, {})`:
```typescript
const __funcResult = await __call(restore, {
  type: "positional",
  args: [__stack.locals.cp, {}]
});
```

See `tests/typescriptGenerator/checkpoint-restore.mjs` for the full generated output.

---

## Error types

Both defined in `lib/runtime/errors.ts`:

- **`CheckpointError`** — thrown when a checkpoint operation fails (invalid ID, max restores exceeded)
- **`RestoreSignal`** — the error `restore()` throws to signal the node runner. It carries the `Checkpoint` and the `RestoreOptions`. `runNode()` catches it, and user code never does.

---

## Relationship to interrupts

Interrupts use checkpoints under the hood. When an interrupt is triggered, the runtime creates a checkpoint and attaches it to the interrupt object. Responding to the interrupt restores from that checkpoint. The two mechanisms are unified: an interrupt is a checkpoint, a pause, and an external response. See [`interrupts.md`](./interrupts.md) and [`promptRunner.md`](../agents/promptRunner.md) for the prompt-side path.

---

## Usage patterns

### Basic retry loop

The counter lives in an imported JS module, so it sits outside the checkpointed
globals and survives each rollback. This is
`tests/agency/static-survives-restore.agency`.

```agency
import { getMutable, setMutable } from "../helpers/mutableVar.js"

static const config = { name: "agency", version: 1 }

node main() {
  const cp = checkpoint()
  setMutable("runs", getMutable("runs", 0) + 1)
  if (getMutable("runs", 0) < 3) {
    restore(cp, {})
  }
  return { config: config, runs: getMutable("runs", 0) }
}
```

### Capping restores by source location

`maxRestores` on the options object ends the loop without an error, because
`restore()` returns instead of throwing once the cap is reached. This is
`tests/agency/maxRestores.agency`.

```agency
import { getMutable, setMutable } from "../helpers/mutableVar.js"

node main() {
  const cp = checkpoint()
  setMutable("attempts", getMutable("attempts", 0) + 1)
  restore(cp, { maxRestores: 3 })
  return getMutable("attempts", 0)
}
```

### External persistence via getCheckpoint

`restore()` accepts the parsed JSON directly; it revives it with
`Checkpoint.fromJSON`, which validates against the zod schemas in
`lib/runtime/state/schemas.ts`. zod strips any key a schema does not name, so
every field `MessageThread.toJSON` and `ThreadStore.toJSON` write must be
listed there. When a field is missing, a checkpoint read back from disk
silently loses it: thread labels and the `sessions` map were dropped this way,
so a resumed `thread(session: "main")` opened a fresh thread.

```agency
node main() {
  const cp = checkpoint()
  const data = getCheckpoint(cp)
  // `data` is a Checkpoint object, and it is JSON-serializable.
  // Write it to disk or a database, and pass it back to restore() later.
  return data
}
```

---


## Test locations

- **Unit tests**: `lib/runtime/checkpoint.test.ts`, `lib/runtime/state/checkpointStore.test.ts`
- **Generator fixture**: `tests/typescriptGenerator/checkpoint-restore.agency` + `.mjs`
- **Execution tests**: `tests/agency/maxRestores.agency`, `tests/agency/set-checkpoint.agency`, `tests/agency/static-survives-restore.agency`, `tests/agency/static-init-once.agency`

---

## Checkpoints and executing handlers (issue #616)

Not every checkpoint is a pause: guard scopes create pinned checkpoints
during normal execution, including inside handler functions. But the
interrupt-pause kind — where the run exits and hands a checkpoint to
the user — must never capture a stack with a handler mid-flight,
because handlers have no step address to resume into. The four
interrupt-pause creation sites each call
`StateStack.assertNoExecutingHandlers()` first: `raiseGuardTripsAtStep` in
`guardTripInterrupt.ts`, the TS-raise surface path in `agencyInterrupt.ts`, the
prompt-step bailout in `promptRunner.ts`, and the shared batch checkpoint in
`runBatch.ts`. The list it
checks is maintained by the interrupt dispatcher, is inherited by
branch stacks, and is deliberately never serialized: since no pause can
exist while it is non-empty, a deserialized stack correctly starts with
it empty.
