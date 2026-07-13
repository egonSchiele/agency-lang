# Plan review: destructive marker authoritative — implementation plan

Reviewer: Claude
Date: 2026-07-12
Target: `docs/superpowers/plans/2026-07-12-destructive-marker-authoritative-plan.md`
Prior rounds: spec reviews `-review.md`, `-review-2.md`
Branch/worktree: `feat/destructive-marker-authoritative`

## Verdict

**Do not execute as written.** The plan is well-structured, TDD-ordered, and its
runtime/codegen core (Tasks 5–6) is correct and carries the fail-open guard from
the spec review through faithfully. But verification against the code finds three
must-fix defects and one altitude question, all rooted in the same place: the plan
under-estimates what wiring a **new transparent AST node** costs in this codebase.
The Global Constraints, Tasks 5, 6, 8, 9, 10, 12–15 are sound. Tasks 2, 3, 4, 7
need correction before a worker starts, or they will hit silent, hard-to-debug
failures (bare identifiers, skipped lowering, a formatter crash, and a broken
`destructive def`).

## Blocking 1 — Task 2 parser will hard-fail `destructive def`

The prescribed parser commits at the wrong point. `parseError(...)` is a
**committing (cut)** combinator — once reached, a failure inside it throws instead
of backtracking. This is exactly documented on the sibling at
`parsers.ts:4205–4210` (handleBlock):

> Require a word boundary so an identifier like `handler(...)` isn't matched as the
> `handle` keyword. Without this, the committing `parseError` below throws
> "expected `{`" instead of letting the statement parser backtrack.

`handle`/`handler` disambiguate because the next char after `handle` is `r` (a
`varNameChar`), so `not(varNameChar)` fails *before* the commit. **`destructive`
does not have this property**: both `destructive {` and `destructive def` have a
**space** after the keyword, so `not(varNameChar)` succeeds for *both*, the parser
commits, then `char("{")` (the first parser inside `parseError`) fails on the `d`
of `def` → **throws "expected `{`", no backtrack → `destructive def` fails to
parse.** The plan's stated rationale ("the `not(varNameChar)` word boundary is
what lets `destructive def` backtrack cleanly") is therefore wrong.

Fix: move the commit point to *after* the `{` is seen — make `char("{")` a soft
gate outside `parseError`:

```typescript
seqC(
  set("type", "destructiveBlock"),
  str("destructive"),
  not(varNameChar),
  optionalSpaces,
  char("{"),                       // SOFT gate: fails on `destructive def` → backtracks
  captureCaptures(parseError(
    "unterminated destructive block",
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
  )),
)
```

Now `destructive def` fails softly at `char("{")` and the statement `or(...)`
moves on. Keep Step 6 (regression on `destructive def`) — it is the right guard,
and with the current plan text it would fail.

## Blocking 2 — a new transparent block touches ~8 dispatch sites; the plan wires ~2

`walkNodes` does **not** descend into arbitrary `.body` generically. Statement-body
descent is driven by one table — `lib/utils/bodySlots.ts` — which the plan never
mentions. Its own header warns: a missing case "silently skipped lowering." The
plan's Task 4 Step 1 ("Confirm the generic walker descends into `.body`
generically") will mislead the worker into thinking descent is free; it is not —
you must add `case "destructiveBlock": return [bodyField(node)]` to `bodySlots.ts`.
That one registration feeds both `walkNodes` (→ `SymbolTable.build`, which walks
via `walkNodes` at `symbolTable.ts:170/203/401/466`) and `mapBodies`.

But `bodySlots` is not the only enumerator. Grepping every site that handles the
transparent siblings `seqBlock`/`parallelBlock` shows a new transparent block must
be added to **all** of these — the plan covers only scopes (vaguely):

| Site | Purpose | In plan? |
|---|---|---|
| `lib/utils/bodySlots.ts:137` | walkNodes + mapBodies master table | **No** — critical |
| `lib/typeChecker/flowBuilder.ts:272` | flow-sensitive narrowing (Result safety) | **No** |
| `lib/typeChecker/scopes.ts:493` | scope walk (transparent) | Vague (Task 4) |
| `lib/preprocessors/typescriptPreprocessor.ts:72` | main preprocessor `walkBody` (hand-enumerated, no fallthrough) | **No** |
| `lib/preprocessors/injectSchemaArgs.ts:148` | schema-arg injection (hand-enumerated) | **No** |
| `lib/preprocessors/liftCallbacks.ts:202` | callback lifting (hand-enumerated) | **No** |
| `lib/backends/agencyGenerator.ts:532` | **the formatter** (`default: throw`) | **Wrong file** (see Blocking 3) |
| `lib/lowering/patternLowering.ts:633/671`, `parallelDesugar.ts` | pattern/parallel desugar | confirm N/A |

Each of `typescriptPreprocessor`, `injectSchemaArgs`, `liftCallbacks` is a
hand-rolled `else if (node.type === "parallelBlock" || node.type === "seqBlock")`
with **no generic fallthrough** — so `destructive { }` bodies are silently skipped
by preprocessing, schema injection, and callback lifting unless a case is added.
The `flowBuilder` miss is the most dangerous of the silent ones: this codebase's
Result-safety rests on flow narrowing, and a block whose body the flow graph never
enters could mis-narrow or miss a safety diagnostic.

Fix: replace Task 4 with an explicit "wire the new node into every body-dispatch
site" task that names each file above, adds `destructiveBlock` alongside
`seqBlock`, and leads with `bodySlots.ts`. Add a test that a variable *referenced*
inside the block resolves to `__stack.locals.x` (not a bare identifier) — that is
the concrete symptom of a missed `bodySlots`/walk registration.

## Blocking 3 — Task 3 names the wrong formatter file

`lib/formatter.ts` (verified: 15 lines) only delegates to `generateAgency`. The
actual pretty-printer dispatch is `AgencyGenerator.processNode` in
`lib/backends/agencyGenerator.ts`, whose `switch` ends in
`default: throw new Error("Unhandled Agency node type: ...")` (`:534`). Adding the
case to `lib/formatter.ts` does nothing; without a case in `agencyGenerator.ts`,
`pnpm run fmt` and every AgencyGenerator roundtrip **throws** on a `destructive { }`.
Point Task 3 at `agencyGenerator.ts` (mirror `processSeqBlock`/`processParallelBlock`
at `:530–533`), and keep the roundtrip test.

## Altitude — reuse `seqBlock` instead of cloning it into a fraction of its sites

`seqBlock` already *is* a transparent, stepped, no-new-scope block that is
registered in every dispatch table above and treated transparently by typecheck
(`scopes.ts:493`), flow (`flowBuilder.ts:272`), preprocessing, and lowering. The
plan reconstructs that machinery from scratch as `destructiveBlock` (notably the
Task 6 inline-splice) but only wires a fraction of the sites — which is the root
of Blocking 2.

Strongly consider desugaring `destructive { body }` to a **marked `seqBlock`** (a
`seqBlock` carrying a `destructive: true` flag) in an early preprocessor, so every
downstream pass sees a `seqBlock` it already handles and only the parser,
`bodySlots`, the formatter, and one codegen branch (emit the entry flip when the
flag is set) need to know the construct exists. Open question to resolve first:
does `seqBlock`'s **runtime** codegen keep locals on the function activation
(`__self`), or give the block its own frame? If it is frame-transparent at runtime,
it is the ideal base and Task 6's from-scratch splice is redundant. If it takes a
frame, the plan's bespoke inline-splice is justified — but Blocking 2's site-wiring
is still required either way. Either resolve this or state explicitly why a
distinct node beats a marked `seqBlock`.

## Moderate — Task 6 entry-flip alignment

Task 6 pushes `blockEntryFlip()` into the *active* `currentPart` without a
preceding `flushPart()`. If a plain (non-flushing) statement immediately precedes
the block, the flip merges into that statement's step and runs one step "early."
In the migrated stdlib pattern this is benign (the gate is an interrupt, which is
compound and flushes, so `currentPart` is null at the block). But for the general
construct, consider `flushPart()` before pushing the flip so it aligns to the
block's own first step — matches the "entry" semantics and avoids a flip sharing a
checkpoint step with a pre-region statement. Low risk (the flip is idempotent and
serialization-preserved), but worth a line and a test with a plain statement
before the block.

## Minor

- **Task 7 misses the `:225` `registerMarkers` call site.** `compilationUnit.ts`
  calls `registerMarkers` at `:211`, `:225`, and `:307` (plan names `:211`/`:307`).
  `:225` passes an explicit `{ destructive: true }` so it is harmless, but the task
  says "call sites at :211/:307" — note `:225` exists so the worker doesn't assume
  two.
- **Task 5 `init()` signature change** — confirm the only callers are
  `typescriptBuilder.ts:2132` and the unit test (grep before changing; the plan
  updates both, which is correct if that is the full set).
- **Task 10 Step 3 (decl-visibility) is a good transparency guard** — keep it, and
  note it also exercises Blocking 2 (a missed `bodySlots`/scope registration makes
  `y` unresolved). Consider asserting a *referenced* variable inside the block
  resolves too, per Blocking 2.
- **Task 11 nested-`destructive {}`-in-`destructive def`** — good, but assert the
  compiled output emits the redundant `__destructiveRan = true` harmlessly (the
  spec's "harmless no-op" claim), not just "parses."

## Coverage assessment

Spec → task mapping is otherwise complete: function-entry commit (Task 5),
inline-splice/fail-open guard (Task 6, correct), derived metadata without mutating
`node.markers` (Task 7, verified against `:2266`/`:2340`), dead-heuristic removal
(Task 8), region-model tests + the four review mandates (Tasks 9–11), stdlib
migration enumerated per function (Tasks 12–15), docs (Task 16). The gaps are not
in *what* the plan set out to cover but in the *mechanism* for the new node —
Blockings 1–3 and the altitude question. Fix those four and the plan is
executable.
