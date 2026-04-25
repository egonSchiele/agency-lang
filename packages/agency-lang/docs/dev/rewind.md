# Rewind (LLM Checkpoints)

Rewind lets you retrospectively override the result of an LLM call and replay execution from that point. Every sync LLM call in an Agency program automatically emits a checkpoint. You can collect these checkpoints, inspect them, and rewind to any of them with different values.

## Quick start

```ts
import { main, rewindFrom } from "./agent.js";

// 1. Run the agent, collecting checkpoints
const checkpoints = [];
const result = await main("I feel fine", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    },
  },
});

// The LLM categorized mood as "sad" — wrong!
console.log(result.data.mood); // "sad"

// 2. Rewind from the mood checkpoint, overriding the value
const fixed = await rewindFrom(checkpoints[0], { mood: "happy" });

// Execution replayed from after the mood LLM call, using "happy" instead
console.log(fixed.data.mood); // "happy"
console.log(fixed.data.response); // a response appropriate for "happy"
```

## How it works

The compiler inserts a **checkpoint sentinel** after every sync LLM call. This sentinel is a separate step in the generated code that:

1. Creates a snapshot of the full execution state (call stack, locals, globals, thread history)
2. Sends it to the `onCheckpoint` callback along with metadata about the LLM call
3. Deletes the internal snapshot (the caller owns the data)

Because the sentinel is its own step, the checkpoint captures the state *after* the LLM call's step has incremented. When `rewindFrom` restores this checkpoint, the LLM call's step is already past — it gets skipped naturally without any step counter manipulation.

## API

### `onCheckpoint` callback

Register via the `callbacks` option when calling an agent:

```ts
const checkpoints = [];
await main("hello", {
  callbacks: {
    onCheckpoint(cp) {
      // cp is a RewindCheckpoint
      checkpoints.push(cp);
    },
  },
});
```

### `RewindCheckpoint` type

```ts
type RewindCheckpoint = {
  checkpoint: Checkpoint;  // serialized execution state
  llmCall: {
    step: number;          // step counter at checkpoint time
    targetVariable: string; // variable name (e.g. "mood")
    prompt: string;         // the prompt sent to the LLM
    response: unknown;      // the LLM's response
    model: string;          // which model was used
  };
};
```

The `llmCall` field is informational — it tells you what happened at this checkpoint so you can display it in a UI, log it, or decide which value to override.

### `rewindFrom(checkpoint, overrides, opts?)`

Exported from every compiled Agency module.

```ts
const result = await rewindFrom(checkpoint, overrides, opts?);
```

**Parameters:**

- `checkpoint: RewindCheckpoint` — the checkpoint to rewind to
- `overrides: Record<string, unknown>` — values to inject into the execution state
- `opts?.metadata.callbacks` — lifecycle callbacks for the rewound execution

**Returns:** the same result shape as calling the agent directly (`{ data, globals }`).

## Overriding values

The `overrides` parameter is a `Record<string, unknown>`. It sets values in the checkpoint's local variables before resuming. You can override:

### The LLM call result

The most common use case — correct what the LLM got wrong:

```ts
// The LLM said mood was "sad", override it to "happy"
const fixed = await rewindFrom(checkpoints[0], { mood: "happy" });
```

### Any local variable in scope

Overrides aren't limited to the LLM call's target variable. You can override any local variable that exists at the checkpoint:

```ts
// Override multiple variables
const fixed = await rewindFrom(checkpoint, {
  mood: "happy",
  confidence: "high",
  retryCount: 0,
});
```

### What you can't override

- **Arguments** — node/function parameters are stored separately from locals
- **Global variables** — use the `globals` field on the result to inspect these
- **Shared variables** — these are never serialized
- **Thread message history** — the message thread is restored from the checkpoint as-is; overriding a variable doesn't retroactively change what the LLM "said" in the thread history

## Chained rewinds

You can collect new checkpoints during a rewind and rewind again from those:

```ts
// First run
const checkpoints1 = [];
await main("hello", {
  callbacks: { onCheckpoint(cp) { checkpoints1.push(cp); } },
});

// First rewind — override mood, collect new checkpoints
const checkpoints2 = [];
await rewindFrom(checkpoints1[0], { mood: "happy" }, {
  metadata: {
    callbacks: { onCheckpoint(cp) { checkpoints2.push(cp); } },
  },
});

// Second rewind — override confidence from the new execution
const final = await rewindFrom(checkpoints2[0], { confidence: "high" });
```

## Threads

Rewind works inside `thread { }` blocks. The checkpoint captures the thread's message history and substep position. When rewinding:

- The LLM call that produced the checkpoint is skipped
- The overridden value is used in subsequent LLM calls within the thread
- The thread's message history from *before* the override point is preserved — subsequent LLM calls see the original conversation history but use the overridden variable value in their prompts

## Handlers

Rewind works correctly with `handle` blocks, including nested handlers across function calls. When execution resumes from a checkpoint, the entire call chain replays through the state stack, re-registering all handlers along the way.

## Limitations

- **Async LLM calls** do not emit checkpoints. Async calls haven't resolved at the point where checkpoint code runs, so there's nothing meaningful to checkpoint. Rewind and async threads cannot be used together.
- **Thread message history is not rewritten.** Overriding `mood = "happy"` changes the variable value used in subsequent prompts, but the assistant's original response (e.g. "sad") remains in the thread history.

## Key files

| File | Role |
|------|------|
| `lib/runtime/rewind.ts` | `RewindCheckpoint` type, `applyOverrides`, `rewindFrom` |
| `lib/runtime/hooks.ts` | `onCheckpoint` in `CallbackMap` |
| `lib/runtime/state/context.ts` | `_skipNextCheckpoint` flag |
| `lib/preprocessors/typescriptPreprocessor.ts` | `insertCheckpointSentinels` — inserts sentinels after LLM calls |
| `lib/types/sentinel.ts` | `Sentinel` AST node type |
| `lib/backends/typescriptBuilder.ts` | `processSentinel` — renders checkpoint code |
| `lib/templates/backends/typescriptGenerator/rewindCheckpoint.mustache` | Checkpoint emission template |
| `tests/agency-js/rewind*/` | Integration tests |
