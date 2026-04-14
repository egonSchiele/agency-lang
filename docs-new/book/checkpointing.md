# Checkpointing

One of Agency's standout features is its ability to pause and serialize execution state at any point. This ability is used for:
- [resuming from interrupts](./interrupts)
- [adding a checkpoint to failures](./error-handling)
- [creating parallel threads with isolated state in the fork primitive](./fork)
- [the time-travel debugger](./debugger)
- [traces](./traces-and-bundles)

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

## Example usage

Retry loop with 3 attempts:

```ts
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