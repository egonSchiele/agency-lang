# Rewind

Rewind replays an Agency execution from a saved checkpoint, optionally with
different values for the local variables in the checkpoint's top stack frame.
It is how the debugger's "rewind" command works, and it is available to any
TypeScript caller of a compiled Agency module.

Checkpoints themselves are the subject of
[checkpointing.md](checkpointing.md). This note covers only the rewind path.

## Quick start

```ts
import { main, rewindFrom } from "./agent.js";

// The agency program calls checkpoint() and returns getCheckpoint(cid),
// so the run hands its checkpoint back to JS.
const { data: checkpoint } = await main();

// Replay from that checkpoint, overriding a local.
const fixed = await rewindFrom(checkpoint, { mood: "happy" });
```

`tests/agency-js/imported-module-callback-rewind/` is a working end-to-end
example of exactly this shape.

## Where checkpoints come from

There is no automatic checkpoint after every LLM call, and no `onCheckpoint`
callback. A checkpoint reaches you one of three ways:

- Agency code calls the `checkpoint()` builtin, which returns a numeric id.
  `getCheckpoint(id)` turns that id back into a `Checkpoint` value the program
  can return. Both live in `lib/runtime/checkpoint.ts`.
- The debugger takes rolling checkpoints. `debugStep`
  (`lib/runtime/debugger.ts`) builds one with `Checkpoint.fromContext` on every
  step, writes it to the trace writer, and hands it to
  `DebuggerState.createRollingCheckpoint`. A compiled module exposes the whole
  store as `__getCheckpoints()`.
- An interrupt carries the checkpoint it was raised at.

`debugStep` skips both the trace write and the debugger entirely when
`ctx._skipNextCheckpoint` is set, which is what stops a rewind from
immediately re-recording the checkpoint it just restored.

## `rewindFrom(checkpoint, overrides, opts?)`

Every compiled Agency module exports it. The generated wrapper lives in
`lib/templates/backends/typescriptGenerator/imports.mustache` and binds the
module's `__globalCtx`:

```ts
export const rewindFrom = (
  checkpoint: Checkpoint,
  overrides: Record<string, unknown>,
  opts?: { metadata?: Record<string, any> },
) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });
```

`opts.metadata.callbacks` is merged onto the rewound execution's callbacks, and
`opts.metadata.debugger` becomes its `DebuggerState`. The debugger passes both
(`lib/debugger/driver.ts`).

The implementation is `rewindFrom` in `lib/runtime/rewind.ts`. It:

1. deep-clones the checkpoint, so the caller's copy is never mutated;
2. applies the overrides;
3. mints a fresh run id and a fresh execution context, so a replay shows up as
   a distinct run in traces;
4. registers top-level callbacks inside a bootstrap ALS frame, then calls
   `restoreState(checkpoint)` and sets `_skipNextCheckpoint`;
5. runs the checkpoint's node to completion, looping on `RestoreSignal` so a
   `restore()` inside the replay is honored;
6. returns `createReturnObject({ result, globals })`, the same
   `{ messages, data, tokens }` shape a direct call returns.

## Overriding values

`applyOverrides(checkpoint, overrides)` writes each entry into
`StateStack.lastFrameJSON(checkpoint.stack).locals`. So:

- you can override any local variable in the checkpoint's top frame;
- you cannot override arguments, which live in `frame.args`, not `frame.locals`;
- you cannot override locals in outer frames;
- you cannot override globals or shared variables this way.

```ts
const fixed = await rewindFrom(checkpoint, {
  mood: "happy",
  confidence: "high",
  retryCount: 0,
});
```

Overriding a variable does not rewrite thread message history. The message
thread is restored from the checkpoint as it was, so a later LLM call sees the
original conversation but the new variable value in its prompt.

## Handlers

Rewind works with `handle` blocks, including nested handlers across function
calls. Restoring the checkpoint replays the call chain through the state stack,
which re-registers every handler along the way. Handlers are never serialized,
so this replay is the only thing that puts them back.

## Key files

| File | Role |
|------|------|
| `lib/runtime/rewind.ts` | `rewindFrom`, `applyOverrides` |
| `lib/runtime/checkpoint.ts` | `checkpoint()`, `getCheckpoint()`, `restore()` |
| `lib/runtime/state/checkpointStore.ts` | `Checkpoint`, `CheckpointStore` |
| `lib/runtime/debugger.ts` | `debugStep` — trace write plus rolling checkpoints |
| `lib/runtime/state/context.ts` | `_skipNextCheckpoint` flag |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | the exported `rewindFrom` / `__getCheckpoints` wrappers |
| `lib/debugger/driver.ts` | the debugger's rewind command |
| `tests/agency-js/imported-module-callback-rewind/` | end-to-end test |
