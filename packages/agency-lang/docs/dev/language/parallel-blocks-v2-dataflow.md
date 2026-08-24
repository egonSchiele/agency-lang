# Parallel Blocks v2: Dataflow Auto-Grouping

Status: concrete spec, not yet implemented. v2 follows the v1 release of `parallel`/`seq`.

v1 reference: `parallel-blocks.md`.

## Summary

In v1, the user must wrap any data-dependent chain in `seq { }` because cross-arm references are a compile error. v2 lifts that restriction by adding a compile-time **dataflow analyzer** that infers arm grouping from variable references. Statements with no inter-dependencies run in their own arms; chains collapse into a single sequential arm. Cross-arm references no longer error — they merge statements into the same arm.

```agency
// v1 — must wrap dependent chain in seq
parallel {
  seq {
    let posts = fetchPosts(id)
    let summary = summarize(posts)
  }
  let user = fetchUser(id)
}

// v2 — compiler auto-groups posts and summary into one arm
parallel {
  let posts = fetchPosts(id)
  let summary = summarize(posts)
  let user = fetchUser(id)
}
```

## Backwards compatibility

v2 is a **strict relaxation** of v1. Any program that compiled under v1 compiles under v2 and behaves identically. v2 only allows additional programs (those with cross-arm references that v1 rejects).

## Decisions (settled before implementation)

These are recorded so reviewers can see what was deliberate vs incidental.

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | "No concurrency in this parallel block" → **warning, not error** | Lets users use `parallel` for scoping or intent-marking. Suppress for single-statement blocks (already allowed in v1). |
| 2 | Bare side-effecting calls without var deps → **independent arms** (footgun) | Consistent rule: deps come from var references only. Document as a footgun; users wanting ordering wrap in `seq`. |
| 3 | Field-precise dataflow (`obj.x` vs `obj`) → **skipped** | Object-level granularity is sufficient. Refactor for finer. |
| 4 | Conditional bindings (let inside if) → **conservative**: any binding on any path counts | Matches scope rules; avoids flow-sensitive analysis. |
| 5 | `seq { }` outside `parallel` → **same as v1** (no-op block, body inlined) | No reason to change. |
| 6 | Strict-mode opt-out (back to v1) → **skipped** | v2 is strictly more permissive; `seq` already gives the same expressiveness for users who want explicit grouping. |
| 7 | Diagnostic CLI output → **Mermaid + JSON**, with reason annotations on edges | Mermaid is renderable everywhere (GitHub, VS Code, Markdown viewers); reason annotations help "why isn't this parallel?" debugging. |
| 8 | Algorithm → undirected dep graph + union-find; preserve source order within each arm | See "Algorithm" below for details. |
| 9 | Lowering → **unchanged from v1** (same fork-based desugar) | Only arm computation changes; runtime path is identical. |

## Algorithm

The dataflow analyzer runs as part of the preprocessor pass for every `parallelBlock` AST node. It replaces v1's "cross-arm reference check" with arm-grouping computation.

### Inputs

- `pb: ParallelBlock` — a parallel block AST node, with `pb.body` being the array of top-level statements (the candidate arms before grouping).

### Outputs

- A list of arms, where each arm is an ordered subset of the original `pb.body`.
- A list of dep-graph edges (with reasons) for diagnostic output.

### Step-by-step

```
algorithm groupArms(pb):
  // 1. Filter out comments/newlines for arm-numbering purposes; they
  //    don't participate in the analysis but are preserved in the
  //    final arm bodies in source-order.
  candidates = pb.body.filter(not is_comment_or_newline)

  // 2. For each candidate, compute the set of names it BINDS (every
  //    let/const declaration anywhere in the subtree, including nested
  //    seq/parallel/control-flow) and the set of names it REFERENCES
  //    that are not bound within itself.
  //
  //    The recursion crosses into all nested scopes EXCEPT function /
  //    graphNode definitions (those have their own scopes). For
  //    conditional bindings (let inside an `if` branch), conservatively
  //    treat the name as bound if any path could bind it.
  //
  //    These helpers are reused from v1's parallelDesugar.ts:
  //      collectBindings(node) → Set<string>
  //      collectReferences(node) → Set<string>
  for i in 0..len(candidates):
    binds[i] = collectBindings(candidates[i])
    refs[i]  = collectReferences(candidates[i])
    frees[i] = refs[i] − binds[i]

  // 3. Build an undirected dependency graph. An edge between i and j
  //    exists if either's frees intersect the other's binds. (Symmetric
  //    by construction since references can only point backward in
  //    source order, but treating edges as undirected simplifies the
  //    union-find and matches the partitioning intent: "are these two
  //    statements connected by any data dep?")
  edges = []
  for each pair (i, j) where i < j:
    shared = (frees[j] ∩ binds[i]) ∪ (frees[i] ∩ binds[j])
    if shared is non-empty:
      edges.append({ from: i, to: j, names: shared })

  // 4. Union-find over the candidates using the edges. Connected
  //    components become arms.
  uf = UnionFind(len(candidates))
  for edge in edges:
    uf.union(edge.from, edge.to)

  // 5. Group candidates by their root in the union-find. Within each
  //    group, preserve original source order. Source order is already
  //    a valid topological order because var references can only point
  //    to earlier-declared names in this scope.
  arms = []
  for root in uf.roots():
    arm = [candidates[i] for i in 0..len(candidates) if uf.find(i) == root]
    arms.append(sorted(arm, by=source_position))

  return arms, edges
```

### Worked examples

**Example A: independent — two arms**
```agency
parallel {
  let user = fetchUser(id)
  let posts = fetchPosts(id)
}
```
- candidates: `[user_stmt, posts_stmt]`
- binds: `[{user}, {posts}]`, frees: `[∅, ∅]` (id is from outer scope)
- edges: none
- arms: `[{user_stmt}, {posts_stmt}]` — two arms, runs concurrently.

**Example B: linear chain — collapses, warning**
```agency
parallel {
  let posts = fetchPosts(id)
  let summary = summarize(posts)
}
```
- binds: `[{posts}, {summary}]`, frees: `[∅, {posts}]`
- shared(0,1) = `{posts}`, edge `0—1`
- arms: `[{posts_stmt, summary_stmt}]` — one arm.
- **Warning emitted**: "parallel block has no concurrency; consider removing or restructuring."

**Example C: fan-in — collapses, warning**
```agency
parallel {
  let a = foo()
  let b = bar()
  let c = baz(a, b)
}
```
- frees: `[∅, ∅, {a, b}]`
- edges: `0—2` (via a), `1—2` (via b)
- union-find merges all three. arms: `[{a, b, c}]`. Warning.

**Example D: multiple chains — multiple arms**
```agency
parallel {
  let user = fetchUser(id)
  let bio = formatBio(user)
  let posts = fetchPosts(id)
  let count = countPosts(posts)
}
```
- edges: `0—1` (user), `2—3` (posts)
- arms: `[{user, bio}, {posts, count}]` — two parallel chains.

**Example E: bare side-effecting calls — independent arms (footgun)**
```agency
parallel {
  logStart()
  let user = fetchUser(id)
  logEnd()
}
```
- frees: `[∅, ∅, ∅]`, binds: `[∅, {user}, ∅]`
- edges: none
- arms: `[{logStart}, {user_stmt}, {logEnd}]` — three independent arms. **Order is non-deterministic.** If the user wanted ordering, they should have written `seq { logStart() }` or assigned results.

## Edge cases

- **Conditional bindings**: `parallel { seq { if (cond) { let x = foo() } let y = x }` — `x` is conservatively counted as bound by the seq arm regardless of whether the if-branch fires at runtime.
- **Empty parallel block**: zero arms. No fork generated. (Same as v1's edge case handling.)
- **Single-statement parallel block**: one arm. Warning suppressed. (Same as v1.)
- **Nested parallel inside arm**: nested parallel block recursively desugars; its bindings are hoisted into the outer arm's scope and counted in the outer arm's binds for sibling arm comparisons.
- **Reads from outer scope**: don't create dep edges to siblings (only sibling-bindings count).
- **Type errors in arm-internal sequencing**: a normal type error inside the arm — no v2-specific concern.

## Diagnostic CLI: `agency plan`

```
$ pnpm run agency plan foo.agency
```

For each `parallel` block in the file, print a Mermaid graph plus a textual summary. Mermaid is the primary output format because it renders inline in GitHub PRs, VS Code, and most Markdown viewers — useful for "why isn't this parallel?" debugging.

### Output: human-readable + Mermaid

```
foo.agency:12 — parallel block (2 arms)

  arm_0:
    line 13: let user = fetchUser(id)
    line 14: let bio = formatBio(user)
  arm_1:
    line 15: let posts = fetchPosts(id)
    line 16: let count = countPosts(posts)

  Dataflow:
    line 14 → line 13 (references `user`)
    line 16 → line 15 (references `posts`)

  Mermaid:

  ```mermaid
  graph TB
    subgraph arm_0
      s13["line 13: let user = fetchUser(id)"]
      s14["line 14: let bio = formatBio(user)"]
    end
    subgraph arm_1
      s15["line 15: let posts = fetchPosts(id)"]
      s16["line 16: let count = countPosts(posts)"]
    end
    s13 -->|"refs user"| s14
    s15 -->|"refs posts"| s16
  ```
```

The Mermaid block is enclosed in triple-backtick fence so users can copy-paste into a `.md` file or use the GitHub PR viewer's auto-rendering.

### Output: --json

For editor integration, `agency plan --json foo.agency` emits a structured form:

```json
{
  "file": "foo.agency",
  "blocks": [
    {
      "line": 12,
      "arms": [
        {
          "name": "arm_0",
          "statements": [
            { "line": 13, "source": "let user = fetchUser(id)" },
            { "line": 14, "source": "let bio = formatBio(user)" }
          ]
        },
        {
          "name": "arm_1",
          "statements": [
            { "line": 15, "source": "let posts = fetchPosts(id)" },
            { "line": 16, "source": "let count = countPosts(posts)" }
          ]
        }
      ],
      "edges": [
        { "from": 14, "to": 13, "names": ["user"] },
        { "from": 16, "to": 15, "names": ["posts"] }
      ],
      "warnings": []
    }
  ]
}
```

### Reason annotations

The "Dataflow" section and Mermaid edge labels show **why** each grouping happened — the variable name(s) that created the dep. This is the most common debugging question ("why are these merged?") and the analyzer already has the data. Cheap to surface.

### Implementation note

The CLI command:
1. Parses the source file (skip if parse error — print error and continue).
2. Runs the preprocessor up to and including the parallel desugar pass, but with grouping diagnostics retained (the desugar would normally discard the edge metadata).
3. For each `parallelBlock` that was processed, emit the human-readable + Mermaid block.
4. With `--json`, emit the structured form to stdout instead.

## Warnings

Emitted via the existing diagnostic system (or printed to stderr if no system exists; check at impl time).

- **No concurrency**: `parallel block at foo.agency:12 has only one arm after dataflow grouping; no concurrency. Consider removing or restructuring.`
  - Suppressed when the original `pb.body` had ≤ 1 candidate statement (single-stmt parallel is allowed without warning per v1).

No other v2-specific warnings.

## Lowering

Unchanged from v1. After dataflow grouping produces N arms, lower exactly as v1 does:

```agency
parallel {
  let posts = fetchPosts(id)
  let summary = summarize(posts)
  let user = fetchUser(id)
}
```

becomes:

```agency
let __arms_0 = fork(["arm_0", "arm_1"]) as __arm_0 {
  if (__arm_0 == "arm_0") {
    let posts = fetchPosts(id)
    let summary = summarize(posts)
    return { posts, summary }
  }
  if (__arm_0 == "arm_1") {
    let user = fetchUser(id)
    return { user }
  }
}
let posts = __arms_0[0].posts
let summary = __arms_0[0].summary
let user = __arms_0[1].user
```

The lowering doesn't care whether arm composition came from v1's "one arm per stmt" rule or v2's dataflow grouping — both produce a list of arms, each containing an ordered sub-sequence of the original statements. The fork-with-if-chain shape is identical.

## Implementation order

1. **Add the dataflow analyzer.** New module `lib/preprocessors/parallelDataflow.ts` exposing `groupArms(pb): { arms, edges, warnings }`. Reuses `collectBindings` and `collectReferences` from v1's `parallelDesugar.ts`. Includes a small union-find utility (or pulls from a tiny dep).

2. **Replace v1's per-statement-arm rule with v2's grouping.** In `parallelDesugar.ts`, change the arm computation in `desugarOneParallel` to call `groupArms(pb)` instead of treating each child as its own arm. The lowering code below this point is unchanged.

3. **Replace v1's cross-arm-reference check** with the no-op (no longer an error). Allowlist enforcement and the seq-inlining behavior stay.

4. **Emit the no-concurrency warning** when grouping yields ≤ 1 arm and the original block had > 1 candidate.

5. **Add the `agency plan` CLI command** (new file in `lib/cli/`, wired into `scripts/agency.ts`). Reuses the analyzer; renders Mermaid and JSON.

6. **Migrate v1 fixtures.** The fixtures that asserted cross-arm errors must be updated:
   - `parallelDesugar.test.ts` "rejects cross-arm references" test → replace with a "merges into one arm" test asserting the new grouping output.
   - All v1 runtime fixtures continue to pass unchanged (strict relaxation guarantee).

7. **Add v2-specific fixtures** under `tests/agency/parallel/dataflow/`:
   - `linear-chain.{agency,test.json}` — verifies one-arm collapse + the new ability to write a chain without `seq`.
   - `fan-in.{agency,test.json}` — multi-source dependency collapses.
   - `multiple-chains.{agency,test.json}` — two independent chains run in parallel.
   - `bare-side-effects.{agency,test.json}` — confirms the footgun behavior is documented and tested.
   - `nested-conditional-bindings.{agency,test.json}` — conservative bindings cross arm boundaries.

8. **Add unit tests for the analyzer** in `parallelDataflow.test.ts`: table-driven over input snippets, asserting the produced (arms, edges) shape.

9. **Add a snapshot test for `agency plan`** output (Mermaid + JSON) for a representative input.

Estimated work: 1-2 days. The analyzer + grouping is the only genuinely new logic; everything else is wiring, CLI plumbing, and test churn.

## Testing plan

- **Analyzer unit tests**: table-driven across the worked examples (A through E) plus edge cases (empty block, single stmt, conditional bindings, nested parallel).
- **Migration**: the v1 fixture suite must continue to pass unchanged. (CI guarantee for the strict-relaxation claim.)
- **New runtime fixtures**: see implementation order #7.
- **CLI snapshot**: a small `tests/cli/parallel-plan/` fixture that runs `agency plan` on a representative file and snapshots the Mermaid + JSON output.

## Future work (post-v2)

- Reorder statements within an arm for better parallelism (currently we preserve source order). Probably never worth it — predictability matters more than micro-scheduling.
- Field-precise dep tracking (`.x` vs `.y` of an object). Would require type info; unclear if the win is worth the complexity. Skip indefinitely unless real demand surfaces.
- Editor extension that consumes the `--json` output to overlay arm-grouping in the source view. Out of scope for the language; could be a separate VS Code extension project.
