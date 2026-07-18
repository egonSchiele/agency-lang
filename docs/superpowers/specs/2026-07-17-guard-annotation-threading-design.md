# Spec: guard annotation threading — `Result<T>` reaches block codegen

**Status:** brainstormed with the owner 2026-07-17 (issue #580);
decisions settled. Builds on #578 (partials ergonomics: the saveDraft
tool and its `draftSchema` threading) and #574 (the guard construct).
Ships after #578 merges.

---

## Part 1: Background

### The hole

Type information declared ON a guard assignment never reaches codegen
INSIDE the guard block. Two features degrade because of it.

The saveDraft tool's value schema (#578) keys on the enclosing
FUNCTION's declared return type. But the draft files on the guard
BLOCK's slot, and the block can yield a different type than the
function returns:

```ts
def makeReport(topic: string): Report {
  const notes: Result<string> = guard(cost: $0.50) {
    // The slot is a STRING. The model is told to save a Report.
    return llm("Research " + topic, tools: [saveDraft])
  }
  ...
}
```

`responseFormat` has the same hole, documented in llm.md: a
`return llm(...)` inside any block defaults to string structured
output, because `ScopeManager.returnType()` answers `undefined` for
block scopes.

In both cases the user may have ALREADY written the missing type. The
guard construct types as `Result<T>`, so `const notes: Result<string>`
names the block's yield exactly. The builder just cannot see the
annotation from inside the block body: the annotation lives on the
assignment node, and the block compiles deep inside processing that
assignment's value, in a scope that carries no type information.

### What this spec does

Move the annotation from where the user wrote it to where the block
compiles. The saveDraft schema unwraps `T` from `Result<T>` and uses
it as the tool's value schema.

### Decisions from the brainstorm and reviews (owner, 2026-07-17)

1. **draftSchema only — responseFormat is DESCOPED** (plan review
   T1, overturning the original "both consumers" decision on
   empirical grounds). The plan review verified that no natural
   type-correct program exists where a responseFormat stamp changes
   behavior: a structured annotation with `return llm(...)` fails
   AG2001 (the checker infers `string` with no expected type pushed
   inward), and the shape that does compile (an annotated local
   holding the llm result) already gets its responseFormat from the
   assignment hint. The one reachable shape — an annotation WIDER
   than the inferred llm type (`Result<string | number>` +
   `return llm()`) — is exactly the case where structured output
   would produce runtime values the checker statically typed away.
   So `ScopeManager.returnType()` is NOT touched; only the
   draftSchema lookup changes. The responseFormat fix is blocked on
   checker expected-type propagation, tracked in #582; the codegen
   plumbing this spec ships (the stamp on the block scope) is the
   same plumbing #582 will consume, so re-adding responseFormat
   later is a two-line change.
2. **Two annotation forms**: the annotated assignment
   (`const r: Result<T> = guard(...) { }`, `let` alike) and the
   return-position guard (`return guard(...) { }` inside a def
   declared `: Result<T>`). Both are places the user wrote
   `Result<T>` adjacent to the guard. A `let r: Result<T>` declared
   on one line and assigned later is OUT: the reassignment site
   carries no annotation, so codegen would need the checker's
   knowledge — the same handoff problem that keeps inferred types
   out.

---

## Part 2: Mechanism

### Approach: stamp the AST during guard desugar

Rejected alternatives, for the record. A pending field on the builder
("processAssignment stashes the yield type; the next
processBlockArgument consumes it") is timing-coupled mutable state —
a nested guard mis-stamps silently; that is the order-dependent-state
anti-pattern. A real typechecker-to-codegen handoff would also fix
the UNANNOTATED case (inferred yields), but it is the missing
infrastructure this project has kept out of scope twice; it remains
the eventual subsumer of this spec, recorded in Part 4.

The chosen mechanism is pure data flow — the type rides the AST node:

1. **`guardDesugar` stamps.** An honesty note first (owner review
   round 2): the desugar does NOT currently see any surrounding
   context. Its walk (`desugarNode`) follows registered body slots
   and a generic `holder.value` field with no parent-awareness and
   threads nothing downward. Making it context-aware is real
   structural work this spec is adding, and the plan owns it:

   - **A walk context parameter.** `desugarGuardsInBody` /
     `desugarNode` gain a context argument carrying one value: the
     **current return target** — the type a `return` statement at
     this point in the tree yields to.
   - **Def-return capture on body entry.** When the walk enters a
     `function` or `graphNode` body, the context's return target
     becomes that def's declared `returnType` (or absent when
     undeclared).
   - **Parent-awareness at the value-follow.** The generic
     `holder.value` follow splits by holder: an `assignment` holder
     stamps its guard from the assignment's own `typeHint`; a
     `returnStatement` holder stamps from the context's current
     return target. Other holders stamp nothing.

   **The return target resets at every return-retargeting boundary**
   — this is the round-2 gap fix, widened by plan-review finding 1.
   A `return` inside a block argument yields to the BLOCK, not to the
   def — and the same is true inside an inline handler body (its own
   arrow function) and a finalize body (the `__finalize` closure). So
   `bodySlots`, the declared single source of truth for body shapes,
   gains a per-slot `retargetsReturn` marker, set on the functionCall
   block slot, the inline-handler slot, and the finalizeBlock slot.
   When the walk enters a retargeting slot, the target resets to that
   slot's own yield type: the stamp the block just received for a
   guard block, absent for everything else. Without this reset, a
   return-position guard inside a fork branch, a handler, or a
   finalize would mis-stamp with the def's return type — silently,
   since the stamp only feeds best-effort schemas. Keying the rule on
   the `bodySlots` marker (not on node types) means the next
   return-retargeting construct gets handled by whoever adds its
   `bodySlots` case instead of silently regressing this feature. With
   the reset, stamping composes: in `const r: Result<Result<string>>
   = guard(...) { return guard(...) { ... } }` the outer stamp
   (`Result<string>`) becomes the return target inside the outer
   block, so the inner guard stamps `string`.

   In every stamping position, the rule is the same: if the source
   type is a `resultType`, stamp its `successType` onto the
   `BlockArgument` the desugar creates; otherwise stamp nothing.
2. **`BlockArgument` gains the field.**
   `declaredYieldType?: VariableType` — optional, absent everywhere
   except stamped guard blocks. (The stamp is on the BLOCK ARGUMENT
   of the desugared `_guard` call, not on the guardBlock node, which
   the desugar replaces.)
3. **`processBlockArgument` copies the stamp onto the scope.** The
   `BlockScope` entry it pushes gains the same optional field:
   `{ type: "block", blockName, declaredYieldType }`.
4. **The draftSchema lookup answers block-first.**
   `enclosingDeclaredReturnType()` (the draftSchema source) walks
   innermost-first and returns the FIRST answer: a stamped block's
   yield, else onward to the enclosing function/node's declared
   return, else `undefined` (string fallback downstream, as today).
   `ScopeManager.returnType()` — the responseFormat source — is
   deliberately NOT changed (decision 1; #582 will consume the same
   stamp when the checker work lands).

Note the desugar runs twice (typescriptPreprocessor and the
TypeChecker constructor) and mutates in place; stamping is
idempotent, so the double run is harmless. One subtlety (plan review
finding 3): on the SECOND run the guard blocks are already stamped,
so the reset rule's read of the block's yield is no longer always
undefined — the two runs walk with genuinely different contexts, and
there is nothing left to stamp, so the run-1 stamps survive
unchanged. A double-run stability test pins this.

### The walk rule for nested guards

Innermost-first, first answer wins. A stamped block answers its
stamp. An UNSTAMPED block defers outward — to an outer stamped
block, then to the function/node declared return, then to the
fallback. An outer hint for an inner slot is no more wrong than
today's function-type hint (both are outer-scope guesses), and the
rule stays one sentence. Example:

```ts
def f(): Report {
  const outer: Result<string> = guard(cost: $1) {
    const inner = guard(cost: $0.10) {
      // inner is unannotated: the walk passes its block, finds
      // outer's stamp -> the saveDraft schema says string, not
      // Report. Better than today, still a hint (the inner slot's
      // true type is inferred, out of scope).
      return llm("...", tools: [saveDraft])
    }
    ...
  }
  ...
}
```

### What the consumer sees

Given `const notes: Result<string> = guard(...) { return llm("...",
tools: [saveDraft]) }`: the llm call site emits
`draftSchema: z.string()` — `successType` unwrapped, rendered by the
same `zodSchemaFor` bridge, same `isAnyType` skip, same
post-prompt-args emission condition as #578. With a structured
annotation the schema is the object shape (`draftSchema:
z.object(...)` or the hoisted alias const). responseFormat is
unchanged everywhere (decision 1 / #582).

### Failure modes considered

- **The annotation and the block's return types differ (owner review
  round 1).** The stamp never looks at the block's returns, and no
  widening is computed — the annotation is the single source, taken
  verbatim. That is sufficient because only two cases exist. In a
  well-typed program the returns are NARROWER than the annotation
  (`return "done"` under `Result<string>`; `return "a"` under
  `Result<string | number>`): the user already did the widening by
  writing the annotation, and the declared contract is exactly the
  right schema for the model — wider than any one incidental return.
  If the returns are INCOMPATIBLE with the annotation
  (`return 42` under `Result<string>`), the checker already errors on
  that assignment — `synthGuardCall` types the guard as
  `Result<union of block returns>`, and assignability against the
  declared `Result<T>` fails — so the stamp is wrong only in a
  program that is already red, and even then the schema is advisory
  (a mismatched save is kept with a warning ack; #578's validation
  stance). Computing a union at desugar time is not possible anyway:
  the desugar has no synthesizer and no alias table. The division of
  labor is deliberate — the desugar CARRIES the user's words, the
  checker JUDGES them.
- **Annotation is not a `resultType`** (user wrote something else, or
  the checker is already erroring): no stamp, today's behavior. The
  desugar never validates — the checker owns diagnosing a bad
  annotation.
- **`Result<T, E>` with a failure type:** `successType` is still the
  slot; `failureType` plays no role in either consumer.
- **Aliased annotations** (`type R = Result<string>` then
  `const r: R = guard...`): v1 stamps only a syntactic `resultType`
  annotation. An alias resolving to Result is NOT chased at desugar
  time (the desugar has no alias table); recorded as a known
  limitation. If review finds the alias table is cheaply reachable
  there, fold it in; do not build new plumbing for it.

---

## Part 3: Testing

- Desugar unit tests: annotated assignment stamps (with the def's
  return type DIFFERENT from the annotation, so the test visibly
  discriminates its source); `let` form; non-Result annotation and
  statement position stamp nothing; return-position stamps in a def
  AND in a `node` (the graphNode capture branch); a return-position
  guard inside an `if` stamps (the inherit branch); inside a fork
  branch, an inline handler, and a finalize stamps NOTHING (the
  three retargeting boundaries); `Result<Result<string>>` composes;
  `Result<T, E>` unwraps only `successType`; a double run leaves
  stamps unchanged.
- ScopeManager unit tests (direct, on a pushed stack — the codegen
  string-match is two layers away): stamped block answers; unstamped
  block defers to a stamped outer block; unstamped block defers to
  the function; block under a `node`.
- Codegen: annotated assignment threads `draftSchema: z.string()`
  and beats the enclosing def's type; return-position guard in a
  `def f(): Result<string>` threads the unwrapped `z.string()` (not
  the Result shape); nested unannotated-inside-annotated pins the
  walk rule; a structured annotation threads
  `draftSchema: z.object(...)` (the one assertion the fixture
  provably cannot make); an unannotated guard keeps the #578
  fallbacks byte-identically.
- Byte-stability: unannotated programs compile byte-identically
  (`make fixtures`, zero churn outside deliberate cases).
- Fixture: a guard annotated `Result<{ title: string }>` whose mock
  saves a structured draft; reject; the guard salvages the object.
  This is the first e2e that exercises a NON-fallback saveDraft
  schema, closing the "every fixture runs the string fallback" gap
  from the #578 plan review at the fixture level.
- Runtime surface test (extend `intrinsicToolSchema.test.ts`
  pattern): none needed — the seam from `args.draftSchema` to the
  provider is already pinned; this change only improves what codegen
  puts INTO that seam, which the codegen tests cover.

## Part 4: Out of scope, recorded so they stay decisions

- Inferred yields (unannotated guards) — needs the
  typechecker-to-codegen handoff; that project would subsume this
  spec's stamping entirely.
- `let r: Result<T>` declared-then-assigned-later (no annotation at
  the assignment site).
- Non-guard blocks (`fork`, `map`, ...): their result types relate
  to block yields differently (arrays, races).
- Alias-typed annotations resolving to Result (see failure modes).
- `responseFormat` inside guard blocks — descoped by decision 1
  after the plan review proved it unreachable in natural type-correct
  programs; blocked on checker expected-type propagation (#582),
  which will consume this spec's stamp when it lands.
- llm.md's limitation note update — owner-authored file (note the
  responseFormat half of that note now stays true until #582).
