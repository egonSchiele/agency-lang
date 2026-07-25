# The fragment type-check entry point

Status: design, awaiting review
Date: 2026-07-24

## Background

### The promise this closes

Template Agency's fill-time type checking is deliberately weak, and says so in its own doc comment (`lib/runtime/template/fill.ts`, `assertFillerType`):

> Fill-time type VALIDATION — deliberately not a compile-time guarantee. Rejects only when both sides are certainly-known primitives that differ. [...] Checking fragments against the completed program's module scope needs a checker entry point that does not exist yet; when it does, this narrows.

Concretely, today:

```ts
const tpl = [|
  const wordCount: number = #count
|]
fill(tpl, { count: "fifty" })         // rejected at fill time (primitive vs primitive) ✓
fill(tpl, { count: parseExpr("n * 2").value })   // passes fill — checked only at runCode ✗
```

The second fill grafts an expression whose type the fill machinery cannot judge: `n * 2` might be a number, `n` might not exist at all. Both problems surface only when the completed program compiles inside `runCode` — in a subprocess, after the model that made the mistake has moved on, with diagnostics pointing at printed source the caller never wrote. The original spec ranked this as the honest place to land for v1 ("it catches the errors people actually make, but it is validation rather than a guarantee"), and marked the upgrade as a follow-up. This spec is that follow-up.

Three other recorded limitations trace to the same missing capability, and all three narrow when it lands:

1. **AG8002 recognizes one position.** An expr hole must get its type from an inline annotation or from an annotated-assignment parent — `checkTemplateHoles` (`lib/typeChecker/templateHoles.ts`) literally pattern-matches `parent.type === "assignment"`. A hole in a call argument (`guard(time: #minutes)`), a return position, or a typed array element has a perfectly determinable expected type that nothing computes.
2. **`holesOf` under-reports types for the same reason.** `positionInferredTypes` (`lib/utils/holes.ts`) is the same annotated-assignment special case; a model asking "what does this hole take?" gets `type: null` for most positions that in fact constrain the fill.
3. **Fill-error attribution stops at the hole.** `loc.origin` tells a caller *which graft* a bad hole arrived through, but a type error inside a fragment ("`n` is not defined") has no fill-time existence at all — it is a subprocess compile error with no origin story.

### Why the entry point "does not exist"

The checker's only public entry is source-string-in: `typeCheckSource` → `runCheckerPipeline` (`lib/compiler/typecheck.ts`), which parses the string itself (prelude template applied, lowering on), writes the source to a synthetic temp file so `SymbolTable.build` can crawl imports, resolves re-exports and imports, builds the compilation unit, and runs `typeCheck` over the *lowered* tree. Every stage assumes it began from text.

A fragment at fill time is none of that. It is an unlowered AST (`Code`) with no file, no prelude import, possibly no complete program around it — and, crucially, its meaning depends on **where it is going**: `n * 2` is well-typed exactly when the scope at the hole binds `n: number`. Checking a fragment in isolation is not the feature; checking it *against the scope and expected type of the hole it fills* is.

### What already exists to build on (verified)

- **The pipeline is more modular than its entry point.** `typeCheck(program, config, info)` takes an AST directly; the test harness in `lib/typeChecker/holes.test.ts` already drives parse → `SymbolTable.build` → `buildCompilationUnit` → `typeCheck` by hand. `SymbolTable.build(entrypoint, config, overrides)` accepts an **overrides map** (absolute path → source text) — the in-memory hook the LSP uses for unsaved buffers — and `withSourcePath` provides the synthetic-temp-file dance when a real path is needed.
- **The checker tolerates holes.** Templates flow through `typeCheckSource` today without refusal (AG8001 is a *builder* pre-pass); the synthesizer types a hole as its annotation or `any`; definite-returns exempts statements-hole bodies.
- **Expected types already flow to the right places.** The checker is organized around exactly the sites that constrain holes: assignment hints (`checkAssignmentsInScope`), call-argument slots (`checkSingleFunctionCall` resolves each arg to a `ParamSlot` with a type), and declared returns. What is missing is not the information — it is that nobody *records* it when the checked expression is a hole.
- **Fill knows its fragments.** At fill time, `fillHoles` holds the template AST, every filler, and each hole's identity. Attribution ("this error is in the fill for `#count`") is free at that boundary in a way it can never be downstream.

## What we are building

One new checker capability and three consumers of it:

**Hole-context capture** — running the ordinary type check over a template additionally records, per hole occurrence, (a) the **expected type** flowing into that position from checking mode, and (b) a **scope snapshot** of the bindings visible there. Then **fragment checking** validates a `Code` filler against a captured context: expression fragments check against the expected type in the snapshot scope; statements and program fragments check statement-by-statement with locals threading through. `fill` gains an opt-in checked mode that runs this per filler and reports errors *at fill time, attributed to their fill*. AG8002 and `holesOf` re-read their answers from the same capture instead of their private position special-cases.

The worked example, end to end:

```ts
const tpl = [|
  def summarize(text: string): string {
    const wordCount: number = #count
    return llm("Summarize in ${wordCount} words: ${text}")
  }
|]

// Capture (implicitly, inside checked fill): at #count —
//   expected: number            (assignment hint)
//   scope:    text: string, wordCount: (being declared), summarize: def(...)
//             + module scope + prelude

fill(tpl, { count: parseExpr("n * 2").value }, check: true)
// → failure: "`n` is not defined (in the fill for `#count`)"

fill(tpl, { count: parseExpr("text").value }, check: true)
// → failure: "`string` is not assignable to `number` (in the fill for `#count`)"

fill(tpl, { count: parseExpr("text.length").value }, check: true)
// → success — checked against the REAL scope, where text: string
```

Note what the second and third cases demonstrate: the fragment is checked against the template's actual bindings, not against an empty room. That is the difference between this and "run `typecheck` on the printed result later" — same-scope checking, at the moment the mistake is made, attributed to the fill that made it.

## Design

### Part 1: hole-context capture

A new module, `lib/typeChecker/holeContexts.ts`, and a small hook surface inside the checker.

```ts
export type HoleContext = {
  /** Hole name plus occurrence index — "count" / "count#1" for repeats.
   *  First occurrence also registers under the bare name (the existing
   *  first-occurrence-wins convention from positionInferredTypes). */
  key: string;
  sort: HoleSort;
  /** The type checking mode supplied at this position, or null when the
   *  position constrains nothing (which is AG8002's firing condition). */
  expected: VariableType | null;
  /** Bindings visible at the hole: locals and params of the enclosing
   *  scope chain, module-level defs/nodes/consts, prelude names —
   *  name → type as the checker knew them. */
  scope: Record<string, VariableType>;
  /** Shared, not per-hole: the template's type aliases and function
   *  signatures, needed to check calls inside fragments. */
  unit: CapturedUnit;
};

export function captureHoleContexts(
  template: Code,
  opts?: { sourcePath?: string },
): Record<string, HoleContext>;
```

`captureHoleContexts` runs the standard pipeline over the template — print via the canonical generator, `withSourcePath` for the symbol table, resolve, lower, `typeCheck` — with one addition: a capture sink on the checker context. The hook sites are precisely the three places expected types exist plus the hole cases themselves:

- the synthesizer's `case "hole"` (records the scope snapshot; expected stays null unless a checking site supplies one);
- `checkAssignmentsInScope`, where a hole on the RHS of a hinted assignment records the hint;
- `checkSingleFunctionCall`, where a hole argument records its resolved `ParamSlot` type — this is the case that makes `guard(time: #minutes)` finally carry `number`;
- return-position checking against the declared return type.

Two implementation facts that make this tractable rather than invasive. First, holes **survive lowering** — pattern lowering and comprehension desugar never touch them — so the capture pass sees every hole the template author wrote, in the lowered tree the checker already runs on. Second, hole identity across the print→re-parse at the pipeline's front is by **name + occurrence order**, not node identity: the pipeline re-parses, so the captured tree is not the caller's tree, and name+order is the same convention `positionInferredTypes` already relies on (first occurrence wins; a second occurrence of the same name at a different type is a documented run-time-only check today — capture keeps per-occurrence entries, which is strictly more information).

The scope snapshot is a **materialization, not a live reference**: names to `VariableType`s, harvested from the checker's scope object at the hole site. It must not hold the checker's mutable scope structures (the check ends; the snapshot outlives it), and per the standing rule it is never stored on `Hole` nodes (anything on a hole dies at print — `formatHole` prints sigil, name, annotation only). Contexts are recomputed per capture call; caching is the caller's concern (see fill integration).

### Part 2: fragment checking

```ts
export function checkFragment(
  fragment: Code,
  context: HoleContext,
): TypeCheckError[];
```

Semantics by fragment kind:

- **expr**: synthesize the single expression in a scope seeded from `context.scope`; if `context.expected` is non-null, check assignability (the same `isAssignable` call sites use). An unresolvable name inside the fragment is an error *here* — this is the "checked against the real scope" half of the feature.
- **statements**: check statement-by-statement, threading locally-declared binders through the seeded scope exactly as body checking does. The fragment's own `const x = ...` declarations are visible to its later statements and invisible outside — matching the runtime reality that a grafted const shares the enclosing scope, and matching the template-side rule that template code cannot reference filler-introduced names ("bindings are local to the hole" is already a checking rule).
- **program**: check each declaration with the fragment's own defs visible to each other plus the template's module scope. This is the decl-hole case (`#helpers`), where the grafted defs may call template-module functions and vice versa is already rejected at template-check time.

Implementation is a reuse exercise, not new type theory: `synthType` and the checking helpers already operate against a `Scope` and a compilation-unit context — the work is a constructor that builds those two from a `HoleContext` instead of from a parsed file, and a driver loop for the statements/program kinds. Diagnostics come back as ordinary `TypeCheckError`s whose locs are *fragment-relative*; the caller (fill) wraps the message with attribution.

**What fragment checking still is not** — stated so the spec cannot overclaim, in the tradition of the original's level-4 honesty: it is per-fragment, so it cannot see interactions that only exist in the completed whole (two program-kind fragments grafted into different holes that declare the same def; a statements fragment whose declared name the *next* fill's fragment references). The completed program's full check at `runCode` remains the final authority, unchanged. What moves earlier is the entire class of single-fragment mistakes — unknown names, wrong types against the hole's expectation, bad calls against template signatures — which is the class models actually produce.

### Part 3: the consumers

**`fill(..., check: true)`.** The Agency-level `fill` gains an optional named argument (default `false` — fill's cost profile is unchanged unless asked):

```ts
export idempotent def fill(
  template: Code,
  values: Record<string, Json | Code>,
  check: boolean = false,
): Result<Code>
```

When set: capture contexts once for the template, then for each `Code` filler run `checkFragment` against its hole's context; for each *plain* filler, check the lifted literal's type against `expected` — which **subsumes and retires `certainTypeOf`'s primitive dance** (a lifted literal's type is always certainly known, and now the expected side is too, in every position rather than two). Any error fails the fill with the attributed message: `` `n` is not defined (in the fill for `#count`) ``. The `origin` machinery composes: if the erring hole itself arrived via a graft, the existing `originSuffix` appends its story too.

Capture cost is one checker run over the template per checked fill. For the composition workflow (fill in a loop), callers hold the same template `Code` value; a keyed cache is deliberately **not** specified for v1 — template values are mutable (fill returns new trees but callers can hand-build Code), and a wrong cache here corrupts silently. Measure first; the opt-in flag means nobody pays who didn't ask.

**AG8002, broadened.** `checkTemplateHoles` currently fires for an unannotated expr hole whose parent is an unhinted assignment — a shape check. It becomes: *an expr hole whose captured `expected` is null and which has no inline annotation*. Same diagnostic, same code, now firing wherever the position genuinely fails to constrain the fill and — the other half — **no longer firing** where it does: `f(count: #n)` against a typed signature stops being invisible, and a hole that IS constrained by a call slot stops needing a redundant annotation. The existing AG8002 tests keep passing (the assignment shape is a subset); new tests pin the call-argument and return positions both ways.

**`holesOf`, enriched.** `HoleInfo.type` today comes from the annotation or the assignment special case. With capture available, `holesOf` *can* report the captured expected type for every constrained position — the model-facing payoff ("this hole takes a `number`") for exactly the callers composing templates. But `holesOf` is called casually and often; running a checker pass inside it changes its cost class. Decision: `holesOf` stays cheap and unchanged; a new sibling reports the richer view —

```ts
export idempotent def holesOfChecked(template: Code): Result<HoleInfo[]>
```

— same shape, `type` filled from capture, documented as "runs the type checker." (Naming open — see questions.) `positionInferredTypes` remains as `holesOf`'s cheap path and as fill's fallback when `check` is off; its doc comment gains a pointer to the capture-based sibling.

### What this deliberately does not attempt

- **A full AST-in `typecheck` for arbitrary programs.** The pipeline's front (prelude template, re-parse, symbol table from text) stays as is; capture *uses* it via print-and-recheck rather than bypassing it. Compile-side `loc.origin` attribution for whole-program checks therefore remains impossible (print drops locs) — unchanged from the origin spec's recorded boundary. Fill-time attribution, which is where the caller who can act lives, is what Part 3 delivers.
- **Effect checking.** `getEffects(fragment) ⊆ declared bound` is a separate, smaller follow-up (all pieces exist per the original spec §skip-level-5); conflating it here would double the surface.
- **Cross-fragment whole-program checking at fill time.** Callers who want it have it today: `typecheck(toSource(filled.value))` — one line, full pipeline, documented in the guide as the belt-and-braces step before `runCode`.

## Testing strategy

All checker-level tests use the explicit-config harness (the `holes.test.ts` pattern — default severities hide checks, and this feature's tests must not pass vacuously).

- **Capture**: for a template exercising every constrained position (assignment hint, call slot via a template-local def, call slot via a prelude/stdlib signature, return position, typed array element) assert each hole's `expected` prints to the hand-written type; a deliberately unconstrained hole captures `expected: null`. Scope snapshots: a hole inside a def sees the def's params and locals-so-far, module defs, and a prelude name; a hole in a second def does NOT see the first def's locals. Repeated hole names capture per-occurrence.
- **Fragment checking**: unknown name fails with the name in the message; wrong-type expr against expected fails; correct fragment referencing a template *param* passes (the real-scope proof); statements fragment with internal declare-then-use passes while use-before-declare fails; program fragment calling a template-module def passes; fragment declaring a name the template also binds is NOT hygiene's business here (renaming happens in fill regardless — a test pins that checked fill still renames).
- **Fill integration**: `check: true` catches the worked example's three cases with attributed messages; `check: false` behavior is byte-identical to today (the full existing fill suite runs under both flags); a plain-value fill against a call-slot expected type is now caught (`fill(t, { minutes: "two" }, check: true)` where `#minutes` sits in `guard(time:)` — the case AG8002 v1 famously could not see).
- **AG8002 both ways**: fires for a genuinely unconstrained hole in a call to an untyped function; stops firing for `f(count: #n)` with a typed signature. Existing AG8002 tests unchanged.
- **Execution fixture**: a checked fill failing inside `tests/agency/templates/` proves the attributed error crosses the stdlib boundary as a `Result` failure, no LLM calls.
- **Honesty pins**: a cross-fragment duplicate-def error is NOT caught at checked fill time but IS caught by `typecheck(toSource(...))` — the boundary stated as a test, not a caveat.

## Open questions

1. **API shape for the enriched holes view**: `holesOfChecked` as specced, versus folding into `holesOf` behind an optional `check: boolean = false` argument (symmetry with `fill`). Recommendation: the optional argument, for one less name — but only if the default-off cost story is prominent in the docstring.
2. **Occurrence keying**: `"name"` + `"name#1"` string keys versus a structured `{ name, index }`. String keys match `positionInferredTypes`' record-shaped world and the house objects-not-maps rule; structured keys are cleaner if `holesOfChecked` ever exposes per-occurrence rows. Recommendation: string keys internally, and `holesOfChecked` keeps one row per name (first occurrence) exactly as `holesOf` does today.
3. **Should checked fill also run capture-based checking on identifier holes?** They are validated strings, not fragments; the only new check available is "does this name collide with a captured scope binding," which hygiene already handles by renaming. Recommendation: no — out of scope, one sentence in the doc.
