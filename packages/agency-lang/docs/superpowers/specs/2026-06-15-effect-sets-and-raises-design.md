# Effect Sets and `raises` Declarations — Design (Phase 1)

**Date:** 2026-06-15
**Status:** Design / awaiting implementation plan
**Scope:** Phase 1 of a larger effort to make Agency's interrupt model
statically checkable.

## Motivation

LLMs write a large fraction of Agency code. The best lever for getting
*good* Agency code out of an LLM is fast, precise **compile-time**
feedback. Agency already has strong *runtime* support for interrupts:
handlers catch and respond to them, and the "every handler in the chain
runs" rule makes them a safety primitive. But today there is no way to
state, at compile time, **what interrupts a function may raise** or to
have the typechecker verify that claim.

Without that, an LLM (or a human) can write a function, believe it is
correct, and only discover at runtime that it raises an interrupt the
caller never intended to allow — or uses functionality the caller wanted
to forbid. Every error the typechecker can catch *before* running the
program is a unit of feedback that makes the next generation of code
better.

This phase adds the foundational layer: a way to **declare the set of
interrupt effects a function may raise**, and a typechecker pass that
**verifies the declaration is not exceeded** by the function's actual
(transitively inferred) behavior.

## Terminology

- **effect** — a labeled capability requested by an interrupt, e.g.
  `std::read`, `std::write`, `myapp::deploy`. This is the `effect` field
  on `InterruptStatement` (`lib/types/interruptStatement.ts`), renamed
  from `kind` in prior work.
- **effect set** — a set of effect labels, e.g. `<std::read, std::write>`.
- **`raises` clause** — a function-signature clause declaring the effect
  set a function may raise.
- **`raise` statement** — a statement that raises an interrupt (see
  "The `raise` statement").

These mirror the algebraic-effects literature (Koka, Eff, Frank), where
the equivalent concepts are "effect" and "effect row/set." Using the
standard vocabulary helps any LLM whose training data covers that area.

### Why `raise` / `raises` and not `throw` / `throws`

Agency already has a `throw(...)` builtin that lowers to `throw new
Error(...)` — it raises a **JavaScript exception** (see
`typescriptBuilder.ts`, `node.functionName === "throw"`). That is a
different concept from raising an interrupt. To avoid overloading one
keyword with two unrelated meanings, the interrupt vocabulary uses
`raise` (the statement) and `raises` (the declaration). The existing
`throw(...)` JS-error builtin is left untouched.

## Goals

1. Let users declare, per function, the effect set it may raise.
2. Let users name and reuse effect sets, including across module
   boundaries (export/import).
3. Verify at compile time that a function's inferred effect set does not
   exceed its declared `raises` clause.
4. Produce effect-aware diagnostics suitable as LLM feedback.
5. Achieve the above with **minimal new compiler machinery** by lowering
   effect sets onto the existing union-type infrastructure.

## Non-goals (deferred to later phases)

- Typed interrupt declarations with payload schemas
  (`interrupt std::read { dir: string }`).
- Handler-side coverage analysis (which effects a handler decides vs.
  lets fall through). Fallthrough remains silent.
- Row polymorphism (`raises *R`). This is blocked on function generics,
  which Agency does not yet have. Higher-order functions in Phase 1 treat
  opaque function values as `raises <*>`.
- A first-class capability vocabulary. Capabilities are simply named
  `effectSet`s; no new language concept is introduced.
- Making `raises` clauses *required* at any boundary. In Phase 1 they are
  optional everywhere; when present, they are verified.

## Decisions carried in from brainstorming

- **`raises` semantics (option A):** a function's effect set includes
  *every* effect raised anywhere in its body, including effects it
  handles locally. Rationale: under "every handler in the chain runs," an
  ancestor handler still observes a locally-handled interrupt, so it is
  part of the function's observable behavior.
- **Annotations are optional; when present, act as an upper bound.** The
  typechecker always infers the real set. A declared clause is verified
  as `inferred ⊆ declared`. There is no boundary requirement in Phase 1.
- **External contract:** a function's externally-visible effect set is its
  declared clause if present, else `<*>` (opaque / "any").
- **`raises <>` means "raises nothing"** and is enforced (inferred must be
  empty). Omitting the clause is *not* the same as `<>`.
- **Handler fallthrough is silent** — no diagnostic in this phase.
- **Declaration keyword is `raises`**; the set form is `effectSet`; the
  raise statement is `raise`.

## Syntax

### Effect-set declarations

```
effectSet FsKinds   = <std::read, std::write>
effectSet NetKinds  = <std::http, std::tcp>
effectSet AllUnsafe = <FsKinds, std::shell, NetKinds>   // compose by spread
```

Effects are **not** required to be namespaced. `std::read`, `myapp::deploy`,
and bare `deploy` are all valid effect labels — at a `raise`/`interrupt`
site and inside a `<...>` set.

Inside `<...>`, an item is one of:
- a **namespaced label** (contains `::`), e.g. `std::read` — unambiguously a
  literal effect; stored as a `StringLiteralType`;
- a **bare identifier**, e.g. `FsKinds` or `deploy` — *ambiguous at parse
  time* (could be a reference to a named effect set, or a literal bare
  effect). Stored as a `TypeAliasVariable` and **disambiguated during
  resolution**: if it names a known `effectSet`, it is **spread**;
  otherwise it is treated as a literal effect label.

So `<FsKinds, std::shell>` denotes `<std::read, std::write, std::shell>`
when `FsKinds` is a declared effect set, and `<deploy>` denotes the single
literal effect `deploy` when `deploy` is not.

**Trade-off:** because a bare name is resolved against the effect-set
registry, a *typo'd* set reference (`<FsKindz>`) silently degrades to a
literal effect label rather than erroring. Namespaced labels (`::`) and
references to known sets are unaffected. This is the accepted cost of not
requiring namespaces.

`effectSet` declarations may be exported and imported exactly like `type`
aliases (see Representation — this is why).

### `raises` clauses on functions and nodes

`raises` clauses are supported on both `def` functions **and** `node`
entry points. The existing interrupt analysis already covers both `def`
and `node` scopes (`ctx.nodeDefs` in `interruptAnalysis.ts`), so the
declaration and verification apply uniformly.

```
def readFile(path: string): string raises <std::read> { ... }
def writeFile(p: string, c: string) raises <std::write> { ... }  // no return type
def pure(x: number): number { ... }                              // omitted = <*>
def safe(): number raises <> { ... }                            // raises nothing
def doStuff(): number raises FsKinds { ... }                    // reference a set
def loud(): number raises <*> { ... }                           // explicit "any"

node main() raises <std::read, std::write> { ... }              // nodes too
```

**Omitting the clause means "may raise any effect"** (`<*>`). A function
or node with no `raises` clause is unconstrained — the typechecker imposes
no upper bound. This is deliberately distinct from `raises <>`, which
asserts the function raises *nothing*.

The `raises` clause appears after the return type, or in the return-type
position when there is no return type. The set may be:
- an inline `<...>` literal,
- a reference to a named `effectSet`,
- `<*>` (any),
- `<>` (none).

### `raises` clauses in function types

```
type Callback = (string) -> string raises <std::read>
type Pure     = (string) -> string                       // no clause
type Spread   = (string) -> string raises FsKinds
```

Angle brackets disambiguate this from the parser ambiguity that a bare
comma list would create in function-type position
(`(x) -> y raises a, b` would be ambiguous; `(x) -> y raises <a, b>` is
not).

## The `raise` statement

Today, an interrupt is raised either as an expression (`const x =
interrupt(...)`, capturing the approval value) or via the idiom `return
interrupt(...)`, which raises the interrupt where the value isn't needed.
The `return` there is a misnomer: on **reject** the function bails with a
failure, but on **approve** execution *continues* past it (e.g. in the
guide's `deleteEmail`, the `print` after `return interrupt(...)` still
runs on approval).

`raise` is the honest spelling of that idiom and pairs with the `raises`
declaration:

```
raise std::write("Are you sure?", { filename })   // structured: effect + message + data
raise("Are you sure?")                            // unstructured (effect = "unknown")
```

### Semantics

`raise` is a **statement** (control flow), not an expression. It raises
the interrupt and then:

- on **reject** → the enclosing function returns a `failure` Result
  (bails), exactly like `return interrupt(...)`;
- on **approve** → execution **continues** to the next statement
  (continue-on-approve, matching `return interrupt(...)`).

To capture an approval *value*, use the existing expression form `const x
= interrupt(...)`. `raise` is for the raise-and-continue / bail-on-reject
case. The `return interrupt(...)` idiom remains valid for back-compat;
`raise` is the preferred, clearer spelling going forward.

This is distinct from the existing `throw(...)` builtin, which raises a
JavaScript exception (`throw new Error(...)`) and is unrelated to
interrupts.

### Parsing

`raise` is a statement keyword that introduces an interrupt raise,
mirroring the existing `interrupt` expression grammar (`interrupt
effect(...)` / `interrupt(...)`). Because the keyword leads, `raise
std::write(...)` is unambiguous and does not collide with a namespaced
function call — the same way `interrupt std::write(...)` already parses
today.

### Effect inference (no extra work)

A `raise effect(...)` contributes `effect` to the enclosing function's
inferred effect set, identically to `interrupt effect(...)`. The cleanest
implementation lowers `raise` to the same `interruptStatement` AST node
(carrying a marker that drives the bail-on-reject codegen), so the
existing inference pass (`analyzeInterruptsFromScopes`, which already
walks `interruptStatement` nodes) counts it with **no change to the
analysis**.

## Representation: lower effect sets onto union types

The central implementation decision is that **effect sets are
string-literal union types**, and **effect-set declarations are `type`
aliases**. This reuses existing infrastructure rather than introducing a
parallel system.

### Mapping

| Surface | Internal representation |
|---|---|
| `effectSet X = <a, b>` | `TypeAlias { aliasName: "X", aliasedType: UnionType([...]), isEffectSet: true }` |
| `<std::read, std::write>` | `UnionType([StringLiteralType("std::read"), StringLiteralType("std::write")])`, flagged |
| `<std::read>` | `UnionType([StringLiteralType("std::read")])`, flagged (one-member union — kept as a union for representational consistency) |
| `<>` | `UnionType([])` (empty), flagged |
| `<*>` | the `any` primitive (`PrimitiveType { value: "any" }`) |
| `raises` clause | a new optional `VariableType` slot (`raises?`) on the function-def AST, the graph-node AST, `BlockType`, and `FunctionRefType` |

The `isEffectSet` flag rides on the `UnionType` (and the `TypeAlias`). It
is **not used by any core type-checking** — it exists only for
(a) diagnostic wording, (b) formatter round-tripping `<...>`, and
(c) validating that a `raises` clause references an effect set rather than
an arbitrary string union. The keyword `effectSet` / the `<...>` syntax is
what sets the flag, so there is no ambiguity about user intent.

### Why this is correct and cheap

The relevant fact about `lib/typeChecker/assignability.ts`:

```ts
// Union as source: every member must be assignable to target
if (resolvedSource.type === "unionType")
  return resolvedSource.types.every((t) => isAssignable(t, resolvedTarget, ...));

// Union as target: source assignable to at least one member
if (resolvedTarget.type === "unionType")
  return resolvedTarget.types.some((t) => isAssignable(resolvedSource, t, ...));
```

Consequences obtained **for free**:

- **Subset check.** `inferred ⊆ declared` is exactly "inferred union is
  assignable to declared union" (union-as-source `.every`).
- **`<>` (raises nothing).** Empty union as source → `.every` over `[]` →
  `true` → empty ⊆ everything. Empty union as target → `.some` over `[]`
  → `false` → only the empty set is ⊆ `<>`. So "raises nothing" is
  enforced with no new logic. (Agency has no `never` type and does not
  need one here.)
- **`<*>` (any).** Mapped to the `any` primitive; `inferred ⊆ any` is
  trivially true → "no upper bound," matching the meaning of an omitted
  clause.
- **Composition / spread.** `<FsKinds, std::shell>` is a union containing
  a `TypeAliasVariable`; resolution recurses through `isAssignable`,
  flattening nested unions transitively. No explicit flatten pass needed
  for assignability.
- **`data.effect` narrowing in handlers.** Because effects are
  string-literal unions, narrowing on `data.effect == "std::read"` is
  ordinary discriminated-union narrowing — the union representation is
  *better* here than a bespoke node would be.

### Why import/export is free

Type aliases already flow through the pipeline:
`SymbolTable.build` collects them (`lib/symbolTable.ts`, `case
"typeAlias"`), `buildCompilationUnit` exposes them per scope
(`info.typeAliases`), and the typechecker reads them via
`ctx.getTypeAliases()`. Because an `effectSet` *is* a `TypeAlias` (its
parser produces a `typeAlias` AST node with `isEffectSet: true`), export,
import, re-export, local aliasing, and cross-module resolution all work
with **no new symbol-table or import plumbing**.

## The one new check

A new diagnostic module under `lib/typeChecker/`, a sibling of the
existing interrupt diagnostics in `interruptAnalysis.ts`
(`checkUnhandledInterruptWarnings`, `checkHandlerBodyInterrupts`,
`checkCallbackBodyInterrupts`). It is wired in from `TypeChecker.check()`
after scopes are collected, following the documented "adding a new
diagnostic" recipe in `docs/dev/typechecker.md`.

Algorithm, per function/node with a `raises` clause:

1. **Inferred labels.** Reuse `analyzeInterruptsFromScopes`
   (`lib/typeChecker/interruptAnalysis.ts`), which already returns the
   transitively-closed set of effect labels per function as data
   (`Record<string, InterruptEffect[]>`). Take the labels as `string[]`.
2. **Declared labels.** Resolve the `raises` clause's union (flattening
   nested `effectSet` references) to `string[]`. `<*>` (the `any`
   primitive) short-circuits to "no upper bound" (skip the check). `<>`
   resolves to the empty set.
3. **Subset check** on the label arrays: every inferred label must be in
   the declared set.
4. On violation, emit a **bespoke, effect-aware** error — deliberately
   *not* routed through `isAssignable`, whose generic union-mismatch
   wording ("Type '"std::write"' is not assignable to '"std::read"'") is
   wrong for LLM feedback:

   > `Function 'foo' raises effect 'std::write', which exceeds its
   > declared 'raises <std::read>'. Add 'std::write' to the clause.`

   The message names the offending effect, the declared clause, and the
   fix, and is anchored at the function/node's `raises`-clause source
   location.

   **Important — local handling does not exempt declaration.** The fix is
   *only* to widen the `raises` clause; wrapping the interrupt in a local
   `handle` block does **not** remove the obligation to declare the
   effect. This follows directly from Agency's handler-chain semantics
   (https://agency-lang.com/guide/handlers.html): when an interrupt is
   triggered, **every handler in the stack runs**, not just the nearest
   one. So even an interrupt that a function catches and resolves locally
   is still observed by every ancestor handler, and is therefore part of
   the function's observable effect set (decision A). The diagnostic must
   *not* suggest "handle it inside the function" as a way to avoid the
   declaration — that advice is incorrect and would mislead the writer
   (human or LLM).

**Function-type `raises` is parsed and formatted in Phase 1 but its
compatibility is NOT yet checked.** `(string) -> string raises <std::read>`
is accepted syntax (so the contract can be written and round-tripped), but
Phase 1 does **not** verify that a callback argument passed to such a
parameter actually conforms to the declared callback `raises` set —
`isAssignable` does not inspect the new `raises` field on `BlockType`.
Structural checking of callback-raises compatibility is **deferred to a
later phase** (it pairs naturally with row polymorphism, also deferred).
Documenting this avoids a phantom feature: the subset diagnostic in this
phase only checks function/node **definitions** against their own inferred
sets.

A second, smaller validation: a `raises` clause must reference an
`effectSet` / inline `<...>` / `<*>` / `<>`, not an arbitrary `type` whose
body happens to be a string union. The `isEffectSet` flag drives this
diagnostic.

## Higher-order / first-class functions in Phase 1

The existing analysis already recovers function references passed as
arguments (`functionRefsInArgs` in `interruptAnalysis.ts`, via
`synthType` → `functionRefType`), so direct tool-passing patterns like
`llm(..., { tools: [deploy] })` already contribute call edges.

For genuinely opaque function values (e.g. a handler chosen at runtime, a
function read from a variable), Phase 1 inherits the **existing** behavior
of `analyzeInterruptsFromScopes`: it counts the effects of callees it can
statically resolve (including function refs recovered via `synthType`), and
simply does not see effects through values it cannot resolve. It does
**not** synthesize a `<*>` contribution for opaque calls — that would be a
new inference behavior, and is out of scope here. The practical consequence
is that the subset check is sound for what the analysis can see and may
under-report effects routed through fully dynamic dispatch. Precise
higher-order tracking (row polymorphism) is deferred until function
generics exist.

## Components and where they change

- **Parser** (`lib/parsers/parsers.ts`): `effectSet` declaration; `<...>`
  effect-set literal (including `<>` and `<*>`); `raises` clause on
  function defs, `node` defs, and function types; the `raise` statement.
  `<...>` lowers to a flagged `UnionType`; `effectSet` lowers to a
  `TypeAlias` with `isEffectSet: true`; `raise` lowers to an
  `interruptStatement` with a `viaRaise` marker.
- **AST types** (`lib/types/`): `isEffectSet?: boolean` on `UnionType` and
  `TypeAlias`; an optional `raises?: VariableType` slot on
  `FunctionDefinition`, `GraphNodeDefinition`, `BlockType`, and
  `FunctionRefType`; a `viaRaise?: boolean` marker on `InterruptStatement`.
  Note the maintenance comment in `lib/types/typeHints.ts` listing the
  exhaustive switches over `VariableType` variants — the `raises` slot is a
  field addition, not a new variant, so those switches are unaffected.
- **Symbol table / compilation unit:** no changes — `effectSet` is a
  `typeAlias` AST node and rides existing collection/export/import paths.
- **Typechecker:** new effect-set resolver helper; new diagnostic module
  for the subset check; small validation that `raises` references an effect
  set; `isAssignable` reused unchanged.
- **Formatter** (`agencyGenerator.ts`): print flagged unions as `<...>`,
  flagged type aliases as `effectSet`, `raises` clauses on defs/nodes, and
  the `raise` statement.
- **Codegen** (`typescriptBuilder.ts`): `raises` clauses and `effectSet`
  declarations are compile-time-only and erase in generated TypeScript
  (type aliases already erase; the `raises` slot is simply not read by the
  TS builder). The `raise` statement *does* generate runtime code — the
  same raise-and-continue / bail-on-reject lowering that `return
  interrupt(...)` produces today, reusing `buildInterruptReturnStructured`.

## Testing

Following `docs/misc/TESTING.md`:

- **Parser tests** (`lib/parsers/*.test.ts`): `effectSet` declarations;
  `<...>`, `<>`, `<*>`; `raises` clauses on defs, `node`s, and function
  types; the `raise` statement (structured and unstructured); round-trip
  through the formatter.
- **`raise` execution tests** (`tests/agency/`, no LLM calls): `raise`
  bails with a failure on reject and continues on approve; a `raise
  effect(...)` contributes `effect` to the enclosing function's inferred
  set and is checked against its `raises` clause.
- **Typechecker unit tests** (`lib/typeChecker/*.test.ts`, alongside the
  existing `interruptAnalysis.test.ts` / `interruptCallGraph.test.ts`):
  - inferred ⊆ declared passes;
  - inferred ⊋ declared fails with the bespoke message;
  - `raises <>` rejects any inferred effect, accepts none;
  - `raises <*>` and omission both impose no upper bound;
  - locally-handled effects still count toward the inferred set
    (decision A);
  - transitive effects through callees are counted;
  - effect-set composition / spread resolves correctly;
  - cross-module import of an `effectSet` resolves and checks;
  - `raises` referencing a non-effect-set `type` is rejected.
- **No new LLM calls** are required for any of these.

## Resolved implementation decisions

- **Single-element `<std::read>`** is kept as a one-member `UnionType`
  (not collapsed to a bare `StringLiteralType`) for representational
  consistency; assignability handles both, but uniform shape simplifies
  the resolver and formatter.
- **The `raises` slot** is a new optional field `raises?: VariableType` on
  `FunctionDefinition` and `GraphNodeDefinition` (confirmed against
  `lib/types/function.ts` and `lib/types/graphNode.ts`).
- **Diagnostic location** is anchored at the function/node's `raises`
  clause (the declaration), not at per-effect call sites. This is reliable
  and sufficient for Phase 1; threading per-effect call-site locations
  through the propagation pass is a future enhancement.
- **Diagnostic interaction.** The new subset diagnostic and the existing
  `checkHandlerBodyInterrupts` diagnostic are independent: the former
  checks a function's `raises` clause against its inferred set; the latter
  errors on handler *bodies* that raise interrupts. They operate on
  different constructs and do not double-report.

## Open questions for the implementation plan

- Whether the formatter should drop an explicit `raises <*>` / `raises <>`
  that is redundant, or preserve user intent verbatim. (Plan decision:
  preserve verbatim — round-trip fidelity over normalization.)
