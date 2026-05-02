# Parallel Blocks v2: Dataflow Auto-Grouping

Status: planned fast-follow to v1 (`parallel-blocks.md`). Not yet designed in detail; this doc captures the intent and key questions.

## Motivation

v1 requires explicit `seq { }` for any data dependency between sibling statements in a `parallel` block:

```agency
// v1 — must wrap dependent chain in seq
parallel {
  seq {
    let posts = fetchPosts(id)
    let summary = summarize(posts)
  }
  let user = fetchUser(id)
}
```

For obvious linear chains, this is verbose. v2 lets the compiler infer arm grouping from data dependencies, so users write:

```agency
// v2 — compiler auto-groups posts and summary into one arm
parallel {
  let posts = fetchPosts(id)
  let summary = summarize(posts)
  let user = fetchUser(id)
}
```

The compiler analyzes free-variable references between sibling statements, builds a dep graph, and partitions statements into arms via union-find. Statements with no inter-dependencies run in their own arm; chains collapse into a single sequential arm.

## Backwards compatibility

v2 is a **strict relaxation** of v1. Any program that compiled under v1 compiles under v2 and behaves identically. v2 only allows additional programs (those with cross-arm references that v1 rejects).

## Behavior

For each direct child of a `parallel` block:

1. Compute `(binds, frees)` per child.
2. Build dep graph: edge from `S2` to `S1` if `frees(S2) ∩ binds(S1) ≠ ∅`.
3. Union-find to partition children into connected components. Each component becomes an arm.
4. Within each arm, preserve original textual order (already a topological order since deps go backwards).
5. Lower each arm to a single closure containing its statements, exactly like v1's `seq` arm lowering.

Cross-arm references no longer error; instead, they merge statements into the same arm.

`seq { }` blocks remain a single child for the analysis: bindings inside a `seq` are scoped to that arm and not visible to siblings. `seq` is still useful for forcing a sequential chain when the dataflow rule wouldn't have grouped (e.g., bare side-effecting calls with no var deps).

## Examples

These mirror the cases discussed during design. Same examples, different grouping outcomes vs v1.

### A. Independent — two parallel arms

```agency
parallel {
  let user = fetchUser(id)
  let posts = fetchPosts(id)
}
```

Arms: `[{user}, {posts}]`. Same as v1.

### B. Linear chain — collapses to one arm

```agency
parallel {
  let posts = fetchPosts(id)
  let summary = summarize(posts)
}
```

`summary` references `posts` → merged. Arms: `[{posts, summary}]`. **No actual parallelism.** Compiler should emit a warning: "parallel block has no concurrency; consider removing or restructuring."

### C. Fan-in — collapses to one arm

```agency
parallel {
  let a = foo()
  let b = bar()
  let c = baz(a, b)
}
```

`c` depends on both → all merged. Arms: `[{a, b, c}]`. Same warning as B.

### D. Multiple chains

```agency
parallel {
  let user = fetchUser(id)
  let bio = formatBio(user)
  let posts = fetchPosts(id)
  let count = countPosts(posts)
}
```

Two independent chains. Arms: `[{user, bio}, {posts, count}]`. Two arms run concurrently, each internally sequential.

### E. Outer-scope captures don't create deps

```agency
def main() {
  let id = "user-123"
  parallel {
    let user = fetchUser(id)
    let posts = fetchPosts(id)
  }
}
```

`id` is bound outside the parallel block, so neither arm depends on the other. Arms: `[{user}, {posts}]`.

### F. Bare side-effecting calls — each is its own arm

```agency
parallel {
  logStart()
  let user = fetchUser(id)
  let posts = fetchPosts(id)
  logEnd()
}
```

Arms: `[{logStart}, {user}, {posts}, {logEnd}]`. **Footgun:** `logStart` and `logEnd` may run in any order — there is no implicit textual-order ordering for statements without var deps. Users wanting ordering must wrap in `seq`. Document this prominently; consider lint warning.

### G. Explicit `seq` forces a chain

```agency
parallel {
  let user = fetchUser(id)
  seq {
    fireMetricStart()
    fireMetricEnd()
  }
  let summary = fetchSummary(id)
}
```

Three arms: `[{user}, {seq block}, {summary}]`. The `seq` block is one arm regardless of whether its internal statements have deps — it's how users force a sequential lane.

## Diagnostic CLI

v2 introduces a debugging command:

```
pnpm run agency plan <file>
```

For each `parallel` block in the file, print the inferred arm grouping:

```
foo.agency:12 — parallel block
  arm_0:
    line 13: let user = fetchUser(id)
    line 14: let bio = formatBio(user)
  arm_1:
    line 15: let posts = fetchPosts(id)
    line 16: let count = countPosts(posts)
```

This is essential because v2's grouping is implicit. Without it, users debugging "why isn't this running in parallel?" have no visibility into the compiler's analysis. Common diagnostic uses:

- "Why is this entire block one arm?" — usually a fan-in case the user didn't notice (example C).
- "Why are these two side-effecting calls reordered?" — they have no var deps so the analyzer treats them as independent (example F).

The output should be machine-readable (also support `--json`) so it can be consumed by an editor extension later.

## Edge cases and warnings

- **Linear chain (B) / fan-in (C) collapse to one arm**: warning. The user wrote `parallel` but got no parallelism. Probably a mistake.
- **Bare side-effecting calls without var deps (F)**: footgun. Document; consider lint.
- **Conditional binding inside `seq`**: a `seq` arm may bind a name conditionally (e.g., inside an `if`). For the cross-arm analysis, treat the `seq` block as binding the union of names it could bind.
- **Type errors in arm-internal sequencing**: if `summary = summarize(posts)` and `summarize` expects `Post[]` but `posts` is `Failure | Post[]`, that's a normal type error inside the arm — no v2-specific concern.

## Implementation sketch

1. Preprocessor: identify `parallel` blocks, walk children, compute `(binds, frees)` per child via a small AST visitor.
2. Build dep graph + union-find. Implementation cost: O(N²) over child count, fine for realistic parallel blocks (N is small).
3. Annotate the AST with arm-grouping metadata.
4. Builder consumes metadata; emits one `runParallel` arm per group, with the group's statements concatenated as the arm body (same shape as v1's `seq` arm lowering).
5. Add `agency plan` CLI command that runs the preprocessor and pretty-prints the grouping. Implementation: parse + preprocess only, don't build/run.
6. Warning emission: after grouping, if a parallel block has < 2 arms, emit a warning unless the user opts out (e.g., `// allow-no-concurrency` pragma comment, or just suppress when N == 1 since they may have intentionally degenerated).

## Testing

- Unit tests on the partitioning algorithm. Table-driven: input snippet, expected arm groups. Cover all the examples above plus edge cases.
- New fixtures under `tests/agency/parallel/dataflow/` exercising the same runtime behavior as v1 fixtures but written without explicit `seq`.
- Snapshot tests for the `agency plan` CLI output across a representative set of `parallel` blocks.
- Regression: re-run the v1 fixture suite as-is. All tests must continue to pass (since v2 is a strict relaxation).

## Open questions

- **Warning vs error for "no concurrency in parallel block"?** Lean: warning. Power users may want to use `parallel` for the scoping behavior even when there's no parallelism.
- **`seq` outside `parallel` in v2?** Same as v1: a no-op block. No reason to change.
- **Should the analyzer reorder statements within an arm?** No. Preserve textual order for predictability and to match user mental model. Even if `let a = foo(); let b = bar();` are independent within a single arm, run them in source order.
- **Type-system-level dataflow?** If a function returns `{user, posts}` and an arm destructures one field, does the rest count as "used"? For v2, treat any reference to the destructured object as a dep on the producing statement. Don't try to be field-precise.
