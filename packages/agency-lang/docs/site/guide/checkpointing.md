---
name: Checkpointing
description: Explains Agency's ability to snapshot and restore execution state via `checkpoint`, `getCheckpoint`, and `restore`, which underpins interrupts, error recovery, forks, and the time-travel debugger.
---

# Checkpointing

## Creating checkpoints

Agency can pause and serialize its execution state at any point. The core API has three functions:
- `checkpoint()` — snapshot current state, returns a numeric ID
- `getCheckpoint(id)` — retrieve the full checkpoint object for a given ID (eg to save to disk)
- `restore(idOrCheckpoint, options)` — roll back to a checkpoint (accepts either a numeric ID or a Checkpoint object)

This lets you roll back to a previous point in execution. Here's a simple example:

```ts
node main() {
  const cp = checkpoint()
  const result:number = llm("Generate a random integer between 1 and 6")

  if (result < 3) {
    print("Bad roll, rolling back...")
    restore(cp)
  }
  print("Good roll:", result)
}
```

Note that this is not like a while loop that keeps retrying. This is actually restoring to a previous execution state. For example, suppose we want to count how many times we have rolled back. We try inserting a counter:

```ts
node main() {
  let counter = 1
  const cp = checkpoint()
  const result:number = llm("Generate a random integer between 1 and 6")

  if (result < 3) {
    print("Bad roll, rolling back...")
    counter++
    restore(cp)
  }
  print("Good roll:", result, "after", counter, "rolls")
}
```

This will always print "...after one rolls", because if it's a bad roll, we increment the counter but then immediately roll back, which restores the counter back to one:

```ts
counter++
restore(cp)
```

You can take this one step further by getting the checkpoint and saving it to a file, which lets you restore back to that state at any point in the future, as long as the code hasn't changed.

```ts
const id = checkpoint()
const cp = getCheckpoint(id)
saveToDisk(cp, "checkpoint.json")
```

This is kind of like saving your progress in a video game and coming back to it later.

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

You can also limit the number of times you restore a checkpoint using `maxRestores`. This is useful if you are retrying flaky LLM calls but don't want to retry too many times.


```ts
restore(result.checkpoint, { maxRestores: 3 })
```

## Inspecting checkpoints

You can inspect a checkpoint saved to disk using the debugger, like so:

```
agency debugger foo.agency --checkpoint <checkpoint-file>
```

Note that you have to additionally give the source file.