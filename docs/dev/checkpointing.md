# Checkpointing — Codebase Review

## Overview

Checkpointing allows an Agency program to snapshot its execution state, continue running, and later restore back to that snapshot. This enables retry loops, rollback on failure, and eventually external persistence of execution state.

The core API has three functions:
- `checkpoint()` — snapshot current state, returns a numeric ID
- `getCheckpoint(id)` — retrieve the full checkpoint object for a given ID (for serialization/persistence)
- `restore(idOrCheckpoint, options)` — roll back to a checkpoint (accepts either a numeric ID or a Checkpoint object)

---

## How are checkpoints implemented?

### Core types

**`Checkpoint`** (`lib/runtime/state/checkpointStore.ts`):
```typescript
type Checkpoint = {
  id: number;            // incrementing numeric ID
  stack: StateStackJSON; // serialized call stack (frames, locals, step counters, threads)
  globals: GlobalStoreJSON; // serialized global variables per module
  nodeId: string;        // which graph node was active when checkpoint was taken
};
```

A checkpoint is a deep clone of the `StateStack` and `GlobalStore` at the moment it was created. Deep cloning is done via `JSON.parse(JSON.stringify(...))`, so checkpoint data is always JSON-serializable.

### CheckpointStore

`CheckpointStore` (`lib/runtime/state/checkpointStore.ts`) manages all checkpoints for an execution context.

Key behavior:
- **ID generation**: Simple incrementing counter (0, 1, 2, ...). Counter is preserved across serialization so resumed executions continue from the correct next ID.
- **Infinite loop protection**: Tracks how many times each checkpoint has been restored. Throws `CheckpointError` if a checkpoint exceeds `maxRestores` (default: 100, configurable via `agency.json`).
- **Invalidation**: When restoring to checkpoint N, all checkpoints with ID > N are deleted. This prevents restoring to a "future" checkpoint after rolling back.
- **Serialization**: `toJSON()` / `fromJSON()` support for interrupt persistence.

Each execution context (created by `RuntimeContext.createExecutionContext()`) gets its own `CheckpointStore`, so concurrent calls don't share checkpoint state.

### Runtime functions

All three functions live in `lib/runtime/checkpoint.ts`.

**`checkpoint(__state)`**:
1. Awaits all pending async promises (ensures consistent state)
2. Calls `ctx.checkpoints.create(ctx)` which deep-clones StateStack + GlobalStore
3. Returns the numeric ID

**`getCheckpoint(checkpointId, __state)`**:
1. Looks up the checkpoint by ID in the store
2. Returns the `Checkpoint` object (for external serialization/persistence)
3. Throws `CheckpointError` if the ID doesn't exist

**`restore(checkpointIdOrCheckpoint, options, __state)`**:
1. Accepts either a numeric ID (looked up from store) or a `Checkpoint` object directly
2. Calls `trackRestore()` for infinite loop protection
3. Calls `invalidateAfter()` to delete later checkpoints
4. Clears pending promises (discards in-flight async work)
5. Throws `RestoreSignal` — never returns

### How restore works end-to-end

`restore()` throws a `RestoreSignal` exception. This propagates up through the generated code and is caught by the node runner loop in `runNode()` (`lib/runtime/node.ts`):

```
restore() → throws RestoreSignal
  → caught in runNode() retry loop
  → calls ctx.restoreState(checkpoint)
  → re-enters the checkpointed node with deserialized state
  → step counters skip past already-executed statements
```

`RuntimeContext.restoreState()` (`lib/runtime/state/context.ts`):
1. Saves current token stats (accounting data should not roll back)
2. Deserializes `StateStack` from checkpoint and enters deserialize mode
3. Deserializes `GlobalStore` from checkpoint
4. Restores token stats onto the new GlobalStore
5. Clears pending promises

The step counter mechanism (the `if (__step <= N)` guards in generated code) ensures that on restore, execution resumes at the exact statement where the checkpoint was taken.

### RestoreOptions

`restore()` accepts an optional `options` parameter:
```typescript
type RestoreOptions = {
  messages?: MessageJSON[];
};
```

This allows injecting messages into the restored state, useful for providing context about why a restore happened.

---

## What gets rolled back vs preserved?

| State | Rolled back? | Why |
|-------|-------------|-----|
| StateStack (locals, args, step counters) | Yes | Core of the rollback mechanism |
| GlobalStore (module-scoped globals) | Yes | Full state rollback |
| Message threads | Yes | Stored in StateStack frames |
| Shared variables | **No** | Persistent by design — not serialized |
| Token stats | **No** | Accounting data should accumulate, not reset |
| Later checkpoints (ID > restored) | Deleted | Prevents inconsistent timeline |
| Pending promises | Cleared | In-flight async work is discarded |

The fact that shared variables persist across restores is what makes retry loops work — a shared counter can track how many times a checkpoint has been restored even though local variables reset.

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

`checkpoint`, `getCheckpoint`, and `restore` are listed in `RUNTIME_STATEFUL_FUNCTIONS` in the builder (`lib/backends/typescriptBuilder.ts`). This means the builder treats them like user-defined Agency functions — it injects the `__state` argument (containing `ctx`, `threads`, `interruptData`) as the last parameter.

Generated code for `cp = checkpoint()`:
```typescript
__stack.locals.cp = await checkpoint({
  ctx: __ctx,
  threads: new ThreadStore(),
  interruptData: __state?.interruptData
});
```

Generated code for `restore(cp, {})`:
```typescript
await restore(__stack.locals.cp, {}, {
  ctx: __ctx,
  threads: new ThreadStore(),
  interruptData: __state?.interruptData
});
```

The import is added by the imports template (`lib/templates/backends/typescriptGenerator/imports.mustache`).

---

## Error types

Both defined in `lib/runtime/errors.ts`:

- **`CheckpointError`** — thrown when a checkpoint operation fails (invalid ID, max restores exceeded)
- **`RestoreSignal`** — special error thrown by `restore()` to signal the node runner. Contains the `Checkpoint` and `RestoreOptions`. Caught by `runNode()`, not by user code.

---

## Relationship to interrupts

Interrupts now use checkpoints under the hood. When an interrupt is triggered (in `lib/runtime/prompt.ts`), a checkpoint is created and attached to the interrupt object. When responding to an interrupt, the checkpoint is used to restore state. This unified the two mechanisms — interrupts are effectively a checkpoint + pause + external response.

---

## Usage patterns

### Basic retry loop
```agency
shared attempts = 0

node main() {
  cp = checkpoint()
  attempts = attempts + 1
  if (attempts < 3) {
    restore(cp, {})
  }
  return attempts  // returns 3
}
```

### Shared vs local variables
```agency
shared sharedCounter = 0
counter = 0

node main() {
  cp = checkpoint()
  sharedCounter = sharedCounter + 1
  counter = counter + 1
  if (sharedCounter < 3) {
    restore(cp, {})
  }
  // sharedCounter = 3, counter = 1 (reset each restore)
  return { sharedCounter: sharedCounter, counter: counter }
}
```

### Checkpoint inside a function
```agency
shared attempts = 0

def retryUntil(maxAttempts: number) {
  cp = checkpoint()
  attempts = attempts + 1
  if (attempts < maxAttempts) {
    restore(cp, {})
  }
  return attempts
}

node main() {
  result = retryUntil(4)
  return result  // returns 4
}
```

### External persistence via getCheckpoint
```agency
node main() {
  cp = checkpoint()
  data = getCheckpoint(cp)
  // `data` is a Checkpoint object — JSON-serializable
  // Can be written to disk, database, etc. and passed to restore() later
  return data
}
```

---

## Test locations

- **Unit tests**: `lib/runtime/checkpoint.test.ts`, `lib/runtime/state/checkpointStore.test.ts`
- **Generator fixture**: `tests/typescriptGenerator/checkpoint-restore.agency` + `.mjs`
- **Integration tests**: `tests/agency-js/checkpoint-basic/`, `tests/agency-js/checkpoint-shared-vars/`, `tests/agency-js/checkpoint-in-function/`
- **Design spec**: `docs/superpowers/specs/2026-03-21-checkpointing-and-state-management-design.md`
