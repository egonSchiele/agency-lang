# Parallel and Sequential Blocks (v1)

Status: design draft, not yet implemented.

## Summary

Two new block constructs:

- `parallel { ... }` — top-level statements run concurrently.
- `seq { ... }` — top-level statements run sequentially. Used inside `parallel` to carve out a dependent chain. Outside `parallel`, it's a no-op.

```agency
parallel {
  let user = fetchUser(id)
  let posts = fetchPosts(id)
  seq {
    let raw = fetchProfile(id)
    let parsed = parse(raw)
    store(parsed)
  }
}
```

This block runs three arms concurrently: fetching the user, fetching the posts, and the three-step profile chain. After the block, `user`, `posts`, `raw`, `parsed` are all in scope.

## Goals

- Heterogeneous, fixed-N parallel function calls — the common case for "do these specific things at the same time."
- Reuse `fork` wholesale. `parallel` and `seq` are pure compile-time sugar that desugars to `fork` in the preprocessor; no new runtime helpers, no new branching primitives.
- Surface syntax that makes parallelism predictable: a reader can tell what runs concurrently from a single read of the source.

## Non-goals (v1)

- **Dataflow auto-grouping** — v1 requires explicit `seq` for data dependencies between sibling statements. See `parallel-blocks-v2-dataflow.md` for the planned relaxation.
- **Dynamic N** — for parallelism over a runtime list, use `fork(items) as item { ... }`.
- **First-class concurrent values** — `parallel` is a compile-time block, not a runtime value. You can't store, pass, or compose it. (Same constraint as `fork`; rooted in checkpoint serialization.)
- **Auto-cancellation on failure** — failures are values. A failing arm does not cancel siblings. (`race` is the only construct that cancels.)

## Surface syntax

### parallel block

```
parallel { <stmt>* }
```

Each top-level statement is one **arm**. Arms run concurrently.

### seq block

```
seq { <stmt>* }
```

Inside a `parallel` block: one arm whose body runs sequentially. Used to express data dependencies between calls that would otherwise be siblings.

Outside a `parallel` block: a normal block. The `seq` keyword has no runtime effect; it only serves as documentation and as a way to write code that's portable into a `parallel` context.

## Statement allowlist (top level of `parallel { }`)

The grammar of statements *directly* inside a `parallel` block is restricted to keep compile-time analysis simple and the runtime semantics obvious.

**Allowed:**

- `let X = <expr>` — binding form.
- `<expr>` — bare expression statement (typically a function call).
- `seq { ... }` — sequential block.
- `parallel { ... }` — nested parallel block.

**Banned at the top level:**

- Control flow: `if`, `for`, `while`. Wrap in `seq`.
- Reassignment to outer-scope variables (`x = expr`). Wrap in `seq`.
- `return`, `break`, `continue`, `throw`.
- Function or type declarations.

The `seq` block has **no** grammar restrictions — it accepts the full Agency statement grammar. So users who want control flow inside a parallel block just put it inside `seq`:

```agency
// ❌ Error: `if` not allowed at top level of parallel block.
parallel {
  if (cond) { fetchA() }
  fetchB()
}

// ✅ OK
parallel {
  seq {
    if (cond) { fetchA() }
  }
  fetchB()
}
```

## Compile-time checks

Two checks run during the preprocessor pass:

1. **Allowlist enforcement.** Walk the direct children of each `parallel` block. Reject any statement type not in the allowlist with a clear error pointing to the offending line and suggesting `seq { }`.

2. **Cross-arm reference check.** For each direct child of a `parallel` block, compute the pair `(binds, frees)`:
   - `binds`: the set of names this statement introduces into the parallel-block scope.
   - `frees`: the set of names this statement references that are not bound within itself.

   For every pair of children `(i, j)` with `i ≠ j`: error if `frees(j) ∩ binds(i) ≠ ∅`.

   Error message format:
   > Parallel arm at `foo.agency:13` references `posts`, which is declared by sibling arm at `foo.agency:12`. Wrap both arms in a single `seq { }` block to make the dependency explicit, or move them into the same existing `seq` block.

   `seq { }` blocks are treated as a single child for this check; the bindings declared inside a `seq` block are NOT visible to sibling arms (they're scoped to the `seq`'s arm).

   References to names declared *outside* the parallel block (enclosing function scope, globals, imports) are always fine.

## Runtime semantics

`parallel` and `seq` are pure compile-time constructs. They have no dedicated runtime helper. The preprocessor desugars `parallel { ... }` into a `fork` over an array of compile-time arm name strings, with a control-flow dispatch in the body that runs the matching arm's statements. Each arm therefore becomes one branch in the existing `BranchState` machinery, indexed by its position in the desugared item list.

All arms run concurrently via the existing `fork` execution path (`runForkAll`), which already uses `Promise.all` to drive branches in parallel.

### Bindings

Names bound inside a parallel arm are visible *after* the parallel block in the enclosing scope. The compiler hoists them out and assigns them from the runtime result map after the block completes.

```agency
parallel {
  let user = fetchUser(id)
  let posts = fetchPosts(id)
}
log(user.name)   // user and posts are in scope here
log(posts.length)
```

### Failures

Failures are values. An arm returning a failure object behaves exactly like a normal return — the arm completes with a failure value, the binding receives the failure, and sibling arms continue running. The parallel block as a whole completes when all arms complete (or are interrupted).

This matches Agency's existing failure-as-values model: every function body is wrapped in try/catch and uncaught exceptions are converted to failure objects, so there is no separate "exception" path that would justify cross-arm cancellation.

### Interrupts

Each arm has its own substack. Interrupts work via the existing concurrent-interrupts machinery:

- A single arm interrupting → `Interrupt` propagates out of the parallel block → caller sees one `Interrupt` to respond to.
- Multiple arms interrupting concurrently → aggregated into `Interrupt[]` via `hasInterrupts()`. Caller responds to all via `respondToInterrupts(interrupts, responses)`, matched by `interruptId`.
- On resume: completed arms read their cached `BranchState.result` (no re-execution); only still-interrupted arms re-execute from their checkpoint slice.

### Cancellation

`parallel` never auto-cancels arms. Each arm receives an `AbortSignal` composed with the enclosing scope's signal via `AbortSignal.any`, so cancellation initiated *outside* the parallel block (e.g., a `race` loser branch containing a parallel) propagates in. But the parallel block itself does not initiate cancellation under any condition.

## Lowering

`parallel { ... }` desugars at the preprocessor level into a `fork` over compile-time arm name strings, with an `if`-chain in the body that dispatches each branch to its arm's statements. There is **no new runtime helper**: the existing `fork` machinery (branch state, slice-only checkpoints, interrupt aggregation, abort signals, resume protocol) handles everything.

For:

```agency
parallel {
  let a = foo()
  let b = bar()
  seq {
    let raw = fetchRaw()
    let p = parse(raw)
  }
}
```

The desugared AST (still in Agency, before TypeScript codegen):

```agency
let __arms = fork(["arm_0", "arm_1", "arm_2"]) as __arm {
  if (__arm == "arm_0") {
    let a = foo()
    return { a }
  }
  if (__arm == "arm_1") {
    let b = bar()
    return { b }
  }
  if (__arm == "arm_2") {
    let raw = fetchRaw()
    let p = parse(raw)
    return { raw, p }
  }
}
let a = __arms[0].a
let b = __arms[1].b
let raw = __arms[2].raw
let p = __arms[2].p
```

The compiler:

1. Assigns arm names: `arm_0`, `arm_1`, `arm_2` in source order.
2. Hoists every binding (`a`, `b`, `raw`, `p`) out to the parallel-block scope.
3. Generates the `fork(items) as __arm { if-chain }` desugaring above.
4. Emits a destructuring sequence after the fork to assign the hoisted names from each arm's returned object.

From there the standard pipeline runs: the desugared `fork` flows through the existing builder, IR, and templates that already produce TypeScript for `fork` blocks. No new templates or lowering code paths.

### `seq` lowering

Inside `parallel`: a `seq { ... }` block at the parallel top level is treated as a single arm during desugaring — its body becomes the body of one `if (__arm == "arm_X")` branch in the generated `fork`. The `seq` keyword has no runtime representation.

Outside `parallel`: emit as a regular block. The braces scope variables; otherwise no special code.

### What this assumes about `fork`

This desugaring relies on `fork` correctly handling bodies that take different control-flow paths per branch. Specifically:

- Each branch's checkpoint slice must capture only the statements that actually executed in that branch (the matched `if`-arm), not all the unmatched ones.
- On resume, the same dispatch must reproduce — branch `i` re-evaluates `if (__arm == "arm_i")`, follows the same path, and resumes inside it.

This should already be true of the current `fork` substep / checkpoint logic — branch state is per-branch and captures the executed code path — but it's worth verifying with a targeted test before relying on it across the parallel test suite. See "Implementation order" below.

## Examples

### Two independent calls

```agency
parallel {
  let user = fetchUser(id)
  let posts = fetchPosts(id)
}
```

Two arms. Both run concurrently. After the block, `user` and `posts` are in scope.

### Mixed: two parallel arms, one of them a chain

```agency
parallel {
  let posts = fetchPosts(id)
  seq {
    let raw = fetchProfile(id)
    let parsed = parse(raw)
    store(parsed)
  }
}
```

Two arms. Arm 0 fetches posts. Arm 1 runs the three-step profile chain. They run concurrently.

### Cross-arm reference is a compile error

```agency
parallel {
  let posts = fetchPosts(id)
  let summary = summarize(posts)   // ❌ references `posts` from sibling arm
}

// Fix: use seq.
parallel {
  seq {
    let posts = fetchPosts(id)
    let summary = summarize(posts)
  }
}
```

(In v2 this will compile and auto-group; in v1 it errors.)

### Bare side-effecting calls

```agency
parallel {
  notifySlack("starting")
  let result = doWork()
  notifyMetrics("started")
}
```

Three arms run concurrently. **Note:** there is no implicit ordering between bare side-effecting calls — `notifySlack` and `notifyMetrics` may run in any order, and may overlap with `doWork`. If you need ordering, use `seq`.

### Nested parallel

```agency
parallel {
  let x = fetchX()
  parallel {
    let p = fetchP()
    let q = fetchQ()
  }
}
```

Outer block has two arms. The second arm is itself a parallel block with two sub-arms. After desugaring, this is `fork`-inside-`fork`, which already works.

### Reading from outer scope

```agency
def main() {
  let id = "user-123"
  parallel {
    let user = fetchUser(id)    // reading `id` from outer scope is fine
    let posts = fetchPosts(id)  // ditto
  }
}
```

`id` is bound *outside* the parallel block, so neither arm depends on the other. Two arms run in parallel.

### Single-arm (degenerate)

```agency
parallel {
  let x = foo()
}
```

Allowed. One arm. No actual parallelism. Avoids parser/preprocessor special cases for the empty/singleton edges; not worth a warning.

## Testing

Test fixtures live under `tests/agency/parallel/`, mirroring the `tests/agency/fork/` layout.

### Compile-time error tests (unit tests)

Per-snippet table-driven tests. Categories:

- Cross-arm reference: each combination of (binding form, free-ref form), confirm error.
- Banned statements at top level: `if`, `for`, `while`, reassignment, `return`, `break`, `continue`, `throw`.
- Confirm allowlist passes: `let`, bare expr, `seq`, nested `parallel`.

### Runtime tests (fixture tests under `tests/agency/parallel/`)

- `basic/` — two-arm, three-arm, single-arm, empty (if allowed).
- `with-seq/` — `seq` inside `parallel`, `seq` outside `parallel` (no-op behavior).
- `nested/` — parallel-in-parallel, parallel-in-seq, parallel-in-fork, fork-in-parallel.
- `interrupts/` — single arm interrupts; multiple arms interrupt simultaneously; resume completes only the still-interrupted arms; `Interrupt[]` aggregation.
- `failures/` — one arm returns failure, siblings continue; multiple arms fail; failures inside a `seq` arm.
- `outer-scope/` — reading outer scope; mutating outer scope (race caveat).
- `stress/` — N arms with mix of LLM tools, interrupts, failures (analog of `fork-stress`).

### Desugaring snapshots

A small fixture that runs only through the preprocessor and snapshots the desugared Agency AST (the `fork`-with-if-chain shape). Catches preprocessor regressions cheaply. Separately, a snapshot of the final generated TypeScript catches downstream regressions in the existing `fork` lowering path.

### Verifying the `fork`-with-dispatch assumption

Before building out the full parallel test suite, add one focused fixture that exercises a hand-written `fork(items) as item { if (item == "a") { ... } else if (item == "b") { ... } }` to confirm: per-branch checkpoint slicing, interrupt-on-one-branch-only, resume-only-the-interrupted-branch. If any of these don't behave correctly with branch-divergent bodies, fix `fork` first; the rest of parallel depends on it.

## Implementation order

1. Verify `fork` handles branch-divergent bodies correctly (focused fixture, no parser/preprocessor work).
2. Parser: add `parallel` and `seq` keywords + block parsers.
3. Preprocessor: allowlist check; cross-arm reference check; desugaring transform that rewrites `parallel { ... }` to `fork(["arm_0", ...]) as __arm { if-chain }` and emits the post-fork destructuring assignments.
4. Builder/codegen: nothing new — desugared output flows through the existing `fork` pipeline.
5. Tests: compile-time errors first, then fixture suite.

## Future work

See `parallel-blocks-v2-dataflow.md` for the planned dataflow auto-grouping relaxation.
