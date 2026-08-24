# Parallel and Sequential Blocks (v1)

Status: **implemented.** This is the design the code follows today. The
implementation lives in `lib/preprocessors/parallelDesugar.ts`, the parser in
`lib/parsers/parsers.ts` (`parallelBlockParser`), and the AST types in
`lib/types/parallelBlock.ts`. Execution fixtures live under
`tests/agency/parallel/`.

The v2 dataflow relaxation in `parallel-blocks-v2-dataflow.md` is NOT
implemented. A cross-arm reference is still a compile error.

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
- Reuse `fork` wholesale. `parallel` and `seq` are pure compile-time sugar that the preprocessor desugars to `fork`. There are no new runtime helpers and no new branching primitives.
- Surface syntax that makes parallelism predictable: a reader can tell what runs concurrently from a single read of the source.

## Non-goals (v1)

- **Dataflow auto-grouping** — v1 requires explicit `seq` for data dependencies between sibling statements. See `parallel-blocks-v2-dataflow.md` for the planned relaxation.
- **Dynamic N** — for parallelism over a runtime list, use `fork(items) as item { ... }`.
- **First-class concurrent values** — `parallel` is a compile-time block, not a runtime value. You can't store, pass, or compose it. `fork` has the same constraint, and both are rooted in checkpoint serialization.
- **Auto-cancellation on failure** — failures are values, so a failing arm does not cancel its siblings. `race` is the only construct that cancels.

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

**Allowed** (`ALLOWED_ARM_TYPES` in `parallelDesugar.ts`):

- `let X = <expr>` / `const X = <expr>` — binding form.
- `<expr>` — bare expression statement, either a `functionCall` or a
  `valueAccess` such as a method call.
- `seq { ... }` — sequential block.
- `parallel { ... }` — nested parallel block.
- Comments and blank lines. These are skipped, not counted as arms.

**Banned at the top level:**

- Control flow: `if`, `for`, `while`. Wrap in `seq`.
- Reassignment to outer-scope variables (`x = expr`). Wrap in `seq`.
- `return`, `break`, `continue`, `throw`.
- Function or type declarations.
- A `destructive { ... }` region anywhere in the subtree. Each arm runs in its
  own fork branch, so the region's `__destructiveRan` flip would land on the
  branch frame instead of the calling tool's activation, and the tool could
  never be removed on failure. `validateParallelBlock` refuses it up front
  rather than accept broken commit semantics.

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

1. **Allowlist enforcement.** Walk the direct children of each `parallel` block. Reject any statement type not in the allowlist, and suggest `seq { }`. The error names the statement type; it does not carry a source location today.

2. **Cross-arm reference check.** For each direct child of a `parallel` block, compute the pair `(binds, frees)`:
   - `binds`: the set of names this statement introduces into the parallel-block scope.
   - `frees`: the set of names this statement references that are not bound within itself.

   For every pair of children `(i, j)` with `i ≠ j`: error if `frees(j) ∩ binds(i) ≠ ∅`.

   Error message:
   > Parallel arm references `posts`, which is declared by a sibling arm. Wrap both arms in a single `seq { ... }` block to make the dependency explicit.

   `binds` is a deep walk (`collectBindings`): every `let`/`const` at any depth
   inside the arm counts, including ones inside a nested `seq`, `if`, or loop.
   It stops at nested `def`/`node` definitions, which have their own scope. A
   called function's name counts as a reference, so
   `let foo = ...` in one arm and `foo()` in another is an error.

   A `seq { }` block is one child for this check, so a sibling arm that
   references a name the `seq` declares is an error.

   References to names declared *outside* the parallel block (enclosing function scope, globals, imports) are always fine.

## Runtime semantics

`parallel` and `seq` are pure compile-time constructs. They have no dedicated runtime helper. The preprocessor desugars `parallel { ... }` into a `fork` over an array of compile-time arm name strings, with a control-flow dispatch in the body that runs the matching arm's statements. Each arm therefore becomes one branch in the existing `BranchState` machinery, indexed by its position in the desugared item list.

All arms run concurrently via the existing `fork` execution path. `Runner.runForkAll` is a thin adapter over `runBatch` (`lib/runtime/runBatch.ts`) in `"all"` mode, which drives the branches with `Promise.allSettled`.

### Bindings

Names bound inside a parallel arm are visible *after* the parallel block, in the enclosing scope. Each arm returns an object holding its own bindings, and the compiler emits one `let X = __arms_<n>[i].X` per binding after the fork.

```agency
parallel {
  let user = fetchUser(id)
  let posts = fetchPosts(id)
}
log(user.name)   // user and posts are in scope here
log(posts.length)
```

### Failures

Failures are values. An arm that returns a failure object behaves exactly like a normal return. The arm completes with a failure value, the binding receives that failure, and sibling arms keep running. The parallel block as a whole completes when all arms complete (or are interrupted).

This matches Agency's failure-as-values model. Every function body sits inside a try/catch that converts an uncaught exception into a failure object, so there is no separate "exception" path that would justify cross-arm cancellation.

### Interrupts

Each arm has its own substack. Interrupts work via the existing concurrent-interrupts machinery:

- A single arm interrupting → `Interrupt` propagates out of the parallel block → caller sees one `Interrupt` to respond to.
- Multiple arms interrupting concurrently → aggregated into `Interrupt[]` via `hasInterrupts()`. Caller responds to all via `respondToInterrupts(interrupts, responses)`, matched by `interruptId`.
- On resume: completed arms read their cached `BranchState.result` (no re-execution); only still-interrupted arms re-execute from their checkpoint slice.

### Globals

By default each arm gets its own view of the module's globals, exactly like a
`fork` branch. Write `parallel(shared: true) { ... }` to opt out and share one
store across arms. `shared` is the only named argument the parser accepts, and
the desugaring forwards it onto the synthesized `fork` call. Fixtures:
`tests/agency/parallel/parallel-globals-isolated.agency` and
`parallel-shared-globals.agency`.

### Cancellation

`parallel` never auto-cancels arms. Each arm receives an `AbortSignal` composed with the enclosing scope's signal via `AbortSignal.any`, so cancellation started *outside* the parallel block propagates in. A losing `race` branch containing a parallel is the usual case. But the parallel block itself does not initiate cancellation under any condition.

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
let __arms_0 = fork(["arm_0", "arm_1", "arm_2"]) as __arm_0 {
  if (__arm_0 == "arm_0") {
    let a = foo()
    return { a }
  }
  if (__arm_0 == "arm_1") {
    let b = bar()
    return { b }
  }
  if (__arm_0 == "arm_2") {
    let raw = fetchRaw()
    let p = parse(raw)
    return { raw, p }
  }
}
let a = __arms_0[0].a
let b = __arms_0[1].b
let raw = __arms_0[2].raw
let p = __arms_0[2].p
```

The `_0` suffix comes from a module-level counter, so nested `parallel` blocks
never collide. `resetParallelCounter()` makes the output deterministic in tests.

The compiler:

1. Assigns arm names: `arm_0`, `arm_1`, `arm_2` in source order.
2. Hoists every binding (`a`, `b`, `raw`, `p`) out to the parallel-block scope.
3. Generates the `fork(items) as __arm_<n> { if-chain }` desugaring above.
4. Emits a destructuring sequence after the fork to assign the hoisted names from each arm's returned object.

From there the standard pipeline runs: the desugared `fork` flows through the existing builder, IR, and templates that already produce TypeScript for `fork` blocks. No new templates or lowering code paths.

### `seq` lowering

Inside `parallel`: a `seq { ... }` block at the parallel top level is one arm.
Its body becomes the body of one `if (__arm_<n> == "arm_X")` branch in the
generated `fork`. The `seq` keyword has no runtime representation.

Outside `parallel`: `desugarParallelInBody` inlines the body into the enclosing
statement list. The braces do NOT open a scope, so names declared inside a
top-level `seq` leak to the enclosing scope. That is what "no runtime effect
outside parallel" means in practice.

`destructive { ... }` parses as the same `seqBlock` node with `destructive:
true`. When it is inlined outside a `parallel`, the desugaring prepends a
`markDestructiveRan` node so the flip runs on the enclosing function's `__self`.
Inside a `parallel` it is refused, as described under the statement allowlist.

### What this assumes about `fork`

This desugaring relies on `fork` handling bodies that take a different
control-flow path per branch. Specifically:

- Each branch's checkpoint slice captures only the statements that actually ran
  in that branch, not the unmatched `if`-arms.
- On resume, the same dispatch reproduces. Branch `i` re-evaluates
  `if (__arm_<n> == "arm_i")`, follows the same path, and resumes inside it.

`tests/agency/parallel/multi-cycle/cached-arm-not-rerun.agency` and the fixtures
under `tests/agency/parallel/interrupts/` cover this.

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

(In v2 this would compile and auto-group. v2 is not implemented, so today this errors.)

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

- `basic/` — three-arm, single-arm, `seq` inside `parallel`, `seq` outside `parallel`.
- `nested/` — parallel-in-parallel, parallel-in-fork, fork-in-parallel.
- `interrupts/` — single arm interrupts, multiple arms interrupt simultaneously, a `seq` arm interrupts, and globals surviving an interrupt resume in both the isolated and shared modes.
- `multi-cycle/` — a completed arm is not re-run on the next cycle.
- `failures/` — one arm returns a failure and siblings continue.
- `outer-scope/` — reading outer scope.
- Top-level fixtures cover globals isolation, shared globals, and a stress case.

### Desugaring snapshots

A small fixture that runs only through the preprocessor and snapshots the desugared Agency AST (the `fork`-with-if-chain shape). Catches preprocessor regressions cheaply. Separately, a snapshot of the final generated TypeScript catches downstream regressions in the existing `fork` lowering path.

### Desugaring unit tests

`lib/preprocessors/parallelDesugar.test.ts` covers the allowlist, the cross-arm
reference check, and the shape of the desugared AST.

## Future work

See `parallel-blocks-v2-dataflow.md` for the planned dataflow auto-grouping relaxation.
