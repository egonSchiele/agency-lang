# Closures and Lambdas: Why They're Hard in Agency

## Background

Agency supports first-class functions and blocks, but not lambdas. A lambda here means an anonymous function that captures variables from its enclosing scope and can be stored in a variable. This document explains why adding lambda support is fundamentally difficult given Agency's execution model, even though blocks work fine.

Agency does have an inline block syntax that looks like a lambda: `map(names, \name -> "Hi, ${name}!")`. That is still a block argument to the call, not a standalone value, so everything below about blocks applies to it. See `docs/site/guide/blocks.md`.

The core problem is **deserialization**. Agency can serialize its entire execution state through the StateStack and resume later. That is how interrupts, checkpoints, and the debugger work. Lambdas with closures are very hard to restore correctly during deserialization.

## How Deserialization Works

When an interrupt fires, Agency captures a Checkpoint containing the full StateStack (all call frames) and the GlobalStore. When the user responds, Agency restores this state and **replays execution from the top**, using step counters to skip past already-completed steps.

For a call chain like `node main => foo => bar` where bar interrupts, the StateStack has three frames: `[main_frame, foo_frame, bar_frame]`. On resume:

1. Enter main → `getNewState()` returns the saved `main_frame` (with all its locals/args restored)
2. main's step counter shows the step that called foo didn't complete → re-executes that step
3. Enter foo → `getNewState()` returns the saved `foo_frame`
4. foo's step counter shows the step that called bar didn't complete → re-executes
5. Enter bar → `getNewState()` returns `bar_frame`, `deserializeStackLength` hits 0, mode switches to serialize
6. bar's step counter skips to where we left off → new execution begins

The key property: **each function call is re-entered, and its saved frame is consumed from the queue in order.** The step counter skips steps that already completed. Steps that didn't complete (because the interrupt was nested inside them) are re-executed.

## Why Blocks Work

Blocks are compiled as inline arrow functions at the call site. The syntax `map(items) as item { ... }` compiles to a single expression, where the block is an argument to the function call. A block is always in the same Runner step as the call it belongs to.

When a block (or something inside it) throws an interrupt, the step containing the function call **didn't complete**. On resume, that step re-executes, which:

1. **Re-creates the block inline** with fresh JS closures over the current `__stack`
2. Passes the fresh block to the function as an argument
3. The function's generated code does `__stack.args["block"] = block`, overwriting the deserialized (stale) value with the fresh block

This chain propagates: if the block was passed through multiple function calls, every step along the path didn't complete, so they all re-execute, and the fresh block propagates through parameter assignment.

Blocks can also close over variables from their enclosing scope. This works because `__stack` (the enclosing function's State frame) was restored by `getNewState()`, and the re-created block captures it via JS closure. So `__stack.locals.x` inside the block resolves to the correct deserialized value.

## Why Lambdas Are Different

With lambdas, **creation and use are in different steps**:

```typescript
// Step 0: create the lambda (captures x from enclosing scope)
await runner.step(0, async () => {
  __stack.locals.myLambda = AgencyFunction.create({
    fn: async () => { return __stack.locals.x * 2; },
  });
});

// Step 1: pass lambda to bar (interrupt happens inside bar)
await runner.step(1, async () => {
  await bar.invoke({ args: [__stack.locals.myLambda] }, ...);
});
```

Step 0 completes (the counter advances to 1). Step 1 interrupts. On resume:

1. The enclosing function's frame is restored with `step = 1`
2. **Step 0 is skipped** (counter 1 > 0) — the lambda is NOT re-created
3. Step 1 re-executes, reads `__stack.locals.myLambda` — but this is the **deserialized** version

The deserialized lambda is a function reference looked up by name in `__toolRegistry`. It is the function definition, but it **has no JS closure over the enclosing `__stack`**. When called, it would try to read `__stack.locals.x`, but `__stack` is not in its scope. Serialization lost the closure.

## The Core Problem

The StateStack stores all variable state on State objects, under `args` and `locals`. Regular functions work because their entire state is on their own frame. They capture nothing from an enclosing scope. `FunctionRefReviver` (`lib/runtime/revivers/functionRefReviver.ts`) serializes them as `{name, module}` and looks them up in `__toolRegistry` on deserialization. This works because top-level functions are stateless from a closure perspective.

A closure's state is **split across frames**. Its own execution state is on its own frame, which is fine. Its captured state lives on the *creating function's* frame. Deserialization restores each frame independently, and nothing re-links a deserialized lambda back to the frame it captured from.

## Comparison Table

| Property | Top-level functions | Blocks | Lambdas |
|----------|-------------------|--------|---------|
| Captures enclosing scope? | No | Yes (via JS closure on `__stack`) | Yes |
| Created in same step as use? | N/A | Yes (always inline) | No (separate steps) |
| Re-created on resume? | N/A | Yes (step re-executes) | No (creation step skipped) |
| Serialization | `{name, module}` → registry lookup | Not independently serialized | Would need closure state |
| Works across interrupts? | Yes | Yes | Broken |

## Specific Scenarios

### Lambda in a loop

```
foo creates lambda at step 0
foo loops at step 1: iteration 0 → calls lambda, iteration 1 → calls lambda (interrupt)
```

On resume, step 0 is skipped so the lambda is not re-created. The loop replays from iteration 1 and calls the deserialized lambda, which has no closure. Broken.

### Lambda passed to another function

```
foo creates lambda at step 0
foo calls bar(lambda) at step 1
bar calls lambda at its step 0 (interrupt inside lambda)
```

On resume, foo's step 0 is skipped so the lambda is not re-created. Step 1 re-enters bar, which calls the deserialized lambda from `__stack.args`. It has no closure. Broken.

### Lambda called within the same step it's created

```
foo creates lambda AND calls bar(lambda) in step 0
```

This would **work**, just like blocks. Step 0 did not complete, so it re-executes and re-creates the lambda with fresh closures. But that constrains lambda usage to be essentially the same as blocks.

## Possible Approaches

### Capture by value (snapshot at creation time)

At lambda creation, snapshot the captured variables into the AgencyFunction's metadata:

```typescript
__stack.locals.myLambda = AgencyFunction.create({
  closureBindings: { x: __stack.locals.x },  // serialized alongside
  fn: async (__closure) => { return __closure.x * 2; },
});
```

On deserialization, `closureBindings` survives as plain data. The lambda works, but mutations to `x` after lambda creation aren't visible to the lambda. This is different from how JS closures work (which capture by reference), but it's serialization-safe.

### Always re-execute lambda creation steps

Don't skip the step that creates a lambda during deserialization — always re-execute it so the closure is re-established over the restored `__stack`. But this changes step counter semantics and could cause side effects if the step does other work besides creating the lambda.

### Store captured frame reference

Have the lambda look up its creator's frame from the StateStack at call time, rather than capturing via JS closure. Identifying the right frame is the hard part. Frame indices shift during deserialization, so the creator's frame might be at a different position.

## Relationship to Blocks

There is one edge case where blocks have a similar problem. If a function copies a block parameter to a local variable and calls the copy in a later step:

```
def foo(block: () => any) {
  let saved = block       // step 0 — completes
  doSomething()           // step 1 — completes
  let result = saved()    // step 2 — interrupts
}
```

On resume, `__stack.args.block` gets the fresh block (from parameter overwrite), but `__stack.locals.saved` is the deserialized version from step 0 (which was skipped). This is the same class of problem — creation and use in different steps.

This is documented as a user-facing limitation in `docs/site/guide/blocks.md`, alongside a second rule: do not return a block from a function. Both demonstrate that the problem is not specific to lambdas. It affects any callable value that captures state and is used in a step after the one where it was created.

Note the limitation only bites when an interrupt actually fires inside the copied block. Without an interrupt there is no replay, and the copy works.

## Summary

The fundamental issue is the interaction between two features:

1. **Closures capture state from an enclosing scope** (via JS closure over `__stack`)
2. **Deserialization skips already-completed steps** (via step counters)

When the step that creates a closure is skipped, the closure isn't re-created, and the deserialized version has no link to the enclosing scope's state. Top-level functions avoid this because they don't capture anything. Blocks avoid this because they're always created inline in the same step as the function call. Lambdas can't avoid it because they're standalone values that can be created in one step and used in another.
