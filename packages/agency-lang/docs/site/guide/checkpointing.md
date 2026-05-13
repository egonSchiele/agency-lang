# Checkpointing

One of Agency's standout features is its ability to pause and serialize execution state at any point. This ability is used for:
- [resuming from interrupts](./interrupts)
- [adding a checkpoint to failures](./error-handling)
- [creating parallel threads with isolated state in the fork primitive](./concurrency)
- [the time-travel debugger](/cli/debug)
- [traces](/cli/trace-and-bundle)

You can also manually create checkpoints and restore from them yourself.

The core API has three functions:
- `checkpoint()` — snapshot current state, returns a numeric ID
- `getCheckpoint(id)` — retrieve the full checkpoint object for a given ID (eg to save to disk)
- `restore(idOrCheckpoint, options)` — roll back to a checkpoint (accepts either a numeric ID or a Checkpoint object)

## restore options

When you restore, you can optionally provide overrides for any of the variables in that checkpoint. This allows you to retry a section of code with different inputs.

You can override function arguments:

```ts
restore(result.checkpoint, { args: { input: "good" } })
```

Global variables:

```ts
restore(result.checkpoint, { globals: { attempts: 8 } })
```

Or local variables:

```ts
restore(result.checkpoint, { locals: { x: 8 } })
```

Max restores:

```ts
restore(result.checkpoint, { maxRestores: 3 })
```

Limit the number of times you restore a checkpoint. This is useful if you are retrying flaky LLM calls but don't want to retry too many times.

## Example usage

Retry loop with up to 3 restores:

```ts
node main() {
  const cp = checkpoint()
  // do some work...
  restore(cp, { maxRestores: 3 })
}
```

## Inspecting checkpoints

You can inspect a checkpoint saved to disk using the debugger, like so:

```
agency debugger foo.agency --checkpoint <checkpoint-file>
```

Note that you have to additionally give the source file.