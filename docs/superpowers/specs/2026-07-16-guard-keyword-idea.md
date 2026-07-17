# Idea: `guard` as a language-level construct (typed guards + static `std::guard` analysis)

**Status:** idea captured 2026-07-16, owner-endorsed direction. Deliberately
NOT a spec yet — this doc exists so the brainstorm can start from full
context later. Sequencing decision (owner): resumable-guards PRs 3 and 4
ship first; this follows as its own brainstorm → spec → plan loop.

**Where this came from:** the review discussion on PR #560 (cost trips as
resumable interrupts), thread on `lib/runtime/call.ts` — the owner asked
whether `std::guard` interrupts could get the same `raises` static-analysis
guarantees as every other effect, and then proposed this: make guards a
language feature instead of a stdlib function.

## The idea in one paragraph

Turn `guard(cost: $1, time: 5m) as { ... }` from a call to the stdlib
function `std::thread.guard` into a first-class language construct — its own
keyword, parser rule, AST node, typechecker treatment, and codegen lowering
(to the SAME runtime machinery that exists today). The surface syntax can
stay byte-identical; the only user-visible migration is deleting
`import { guard } from "std::thread"`, because keywords are not imported.

## Why: it makes `std::guard` statically analyzable, which I had concluded was impossible

Read this section carefully, future me — it reverses a conclusion you
argued for on the #560 thread.

**The problem.** The `raises` effect system
(docs/site/guide/effects-and-raises.html; enforcement shipped in #511)
gives static guarantees about which interrupts a function can raise.
Guard trips (`std::guard`) are invisible to it. The naive fix — track the
RAISE POINT — collapses: cost trips raise at `llm()` gates, but PR 3's
time trips raise at ANY step boundary of ANY function running under a
guard, and guards are installed dynamically by callers a callee never
sees. Tracking raise points marks every function in every program, which
is an annotation that tells the reader nothing. That collapse is why the
#560 thread recommended treating `std::guard` as an AMBIENT effect (like
cancellation, which no clause declares).

**The reversal.** A guard CONSTRUCT lets the checker attribute the effect
to the SOURCE instead of the raise point: *the `std::guard` interrupt is
raised by the guard construct*. Statically: a function that lexically
contains a `guard { ... }` block may raise `std::guard`; normal transitive
effect propagation through callers does the rest. Functions with no guard
anywhere under their call tree carry nothing. Precise, and no annotation
noise.

**Why that attribution is SOUND, not just convenient.** The
registration-site eligibility rule from PR 1 (#558): a handler registered
inside a guard's dynamic extent can never see that guard's trip —
eligibility requires registering before the guard installed
(`HandlerEntry.liveGuardIds`, the `eligible` filter in
`runHandlerChain`). Therefore every possible OBSERVER of a `std::guard`
interrupt — every eligible handler, out to the user endpoint — sits in
the transitive caller chain of the function containing the guard
construct. That is exactly the chain the effect analysis marks. The trip
physically firing three calls deeper, inside some helper's llm gate, is
unobservable from anywhere that helper's own `raises` clause governs.
The budget-scoping rule and the effect-attribution rule are the same
rule. This argument survives the hard cases:

- PR 3 time trips: attributed to the construct regardless of where the
  timer catches the branch.
- A tool defined outside any guard, executed by an `llm()` inside one:
  the guard construct containing that `llm()` call is in the marked
  chain.
- Fork/race clones: clones carry the parent's guardId; the construct is
  in the parent chain.

## What the construct buys beyond `raises`

1. **Aliasing-proof recognition.** The checker could pattern-match calls
   to `std::thread.guard` today, but that breaks under `const g = guard`,
   partial application, re-export, and guard-as-value. A keyword cannot
   be renamed away. Safety infrastructure should not be dodge-able —
   same reason `handle` and `finalize` are keywords.
2. **Precise result typing.** `const r = guard(cost: $1) as { ...T... }`
   can be natively typed `Result<T>` instead of what the generic stdlib
   signature manages.
3. **A home for guard-specific diagnostics** (nesting lints, label rules,
   guard-in-finalize interactions).
4. **The anchor #555 needs.** The construct is where the trip's typed
   data payload ({label, scopeIds, dimension, limit, spent, maxCost,
   maxTime, draftValue}) and the typed approve payload ({maxCost?,
   maxTime?, disarm?, message?}) attach. `std::guard` becomes the first
   BUILT-IN typed effect: handlers narrowing on `intr.effect` get checked
   field access instead of `any`, and effect-string typo detection falls
   out of the same registry.
5. **Runtime untouched.** Codegen lowers the construct to the existing
   `_pushGuard` / `GuardScope` / gate machinery from #558/#560. This is
   a front-end feature.

## Costs and decisions for the brainstorm

- **Parser + AST + walkers + checker + codegen + fixtures** — one focused
  PR. The direct precedent is the `finalize` keyword (#556): parser rule
  mirroring `handleBlockParser`, an AST node like
  `lib/types/finalizeBlock.ts`, one `bodySlots` case, checker pass,
  codegen lowering.
- **`guard` becomes a keyword**: `import { guard } from "std::thread"`
  stops parsing; migration is deleting the import line (breaking, small,
  consistent with the current posture). Variables named `guard` also
  break.
- **Surface syntax decisions**: keep `guard(args) as { ... }` verbatim
  (cheapest migration), or drop the `as` (note AG4006 declares
  reserved block keywords take no `as` "because there is nothing to
  bind" — a guard DOES bind its Result, so `as` arguably stays; thread
  and subthread are the no-`as` precedents,
  `lib/typeChecker/undefinedFunctionDiagnostic.ts:86`).
- **The annotated-code ripple**: once the analysis lands, a
  `raises`-annotated function containing a guard needs `std::guard` in
  its clause. Owner: "I don't think there are many of these right now,
  if any." Decide auto-admit-with-warning vs hard-require.
- **`agency.withCostGuard`** (TS-side guard install, `lib/runtime/agency.ts`)
  has no construct — decide: deprecate it, or document its trips as the
  one ambient residue. Root budgets never raise, so they are not an
  issue. `std::agency.run(maxCost:)`'s internal guard becomes a
  construct inside stdlib and gets marked normally (may-raise
  over-approximation is fine — its parent-side IPC trips still throw in
  v1, see the PR 2 execution notes).
- **Where the effect enters the analysis**: the construct contributes
  `std::guard` to `interruptEffectsByFunction` for its containing
  function; the transitive machinery is already there
  (`lib/analysis/interrupts.ts`, the raises checking from #511 —
  `checkFunctionTypeRaises`).

## File pointers for the future reader

- Runtime this lowers onto: `lib/runtime/guardScope.ts`,
  `lib/runtime/guardTripInterrupt.ts`, `lib/runtime/guard.ts`,
  `lib/stdlib/thread.ts` (`_pushGuard`, ~:263), the gate steps in
  `lib/runtime/prompt.ts` (`guardGate.*`), and the eligibility filter in
  `lib/runtime/interrupts.ts` (`runHandlerChain`) with
  `HandlerEntry.liveGuardIds` in `lib/runtime/types.ts`.
- The stdlib function being replaced: `stdlib/thread.agency` (`guard`,
  ~:219).
- Keyword-construct precedent to copy: the finalize keyword PR (#556) —
  parser rule in `lib/parsers/parsers.ts` (`finalizeBlockParser`,
  mirroring `handleBlockParser` ~:4208), AST node
  `lib/types/finalizeBlock.ts`, `lib/utils/bodySlots.ts` registration,
  codegen extraction pattern
  `lib/backends/typescriptBuilder/finalizeCodegen.ts`.
- Effect system: docs/site/guide/effects-and-raises.html,
  `lib/analysis/interrupts.ts`, raises enforcement from #511.
- Context threads: PR #560 (the `raises` discussion on
  `lib/runtime/call.ts`, comment 3599637753 and its reply laying out the
  ambient-vs-precise argument this doc reverses), issue #555 (typed
  payloads — the companion work), `docs/dev/interrupts.md` ("Guard trips
  as interrupts" section), and the resumable-guards plan
  `docs/superpowers/plans/2026-07-16-resumable-guards.md` (decision 3 =
  the eligibility rule; Part 5b = PR 2 execution notes).

## Sequencing (owner-decided)

PRs 3 (derived abort signal + time trips) and 4 (feedback channel) first —
they are runtime work and do not depend on this. Then this feature as its
own loop, bundled with the `raises` attribution, feeding #555 its first
typed-effect customer.
