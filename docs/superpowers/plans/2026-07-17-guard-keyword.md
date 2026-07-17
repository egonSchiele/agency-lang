# Guard Keyword Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task (owner works inline, no subagents).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `guard` a language-level construct — keyword, AST node,
checker typing, effect attribution — that lowers to the exact call
today's stdlib-function syntax emits, per the approved spec
`docs/superpowers/specs/2026-07-17-guard-keyword-design.md`.

**Architecture:** front end only. A new `guardBlock` AST node, parsed at
the value positions where `match` expressions already live, is DESUGARED
by a preprocessor pass (the `parallelDesugar` precedent) into the same
`functionCall` + `blockArgument` shape the old syntax parsed to, calling
the internalized stdlib impl. Everything downstream — block lifting,
codegen, the runtime, serialization — is untouched by construction. The
typechecker and the effect analysis see the `guardBlock` node before
desugaring and contribute `Result<T>` typing and the `std::guard` effect.

**Tech stack:** tarsec parsers (`lib/parsers/parsers.ts`), the AST types
in `lib/types/`, the preprocessor pipeline
(`lib/preprocessors/typescriptPreprocessor.ts`), the bidirectional
typechecker (`lib/typeChecker/`), the interrupt-effect analysis
(`lib/typeChecker/interruptAnalysis.ts`, `functionTypeRaises.ts`), the
AgencyGenerator formatter.

## Global constraints

- The construct must lower to the SAME emitted call as the legacy
  syntax. Acceptance: near-zero compiled-output churn in `make fixtures`
  beyond the mechanical source edits (spec Part 5).
- No new diagnostic codes anywhere (spec decision 3).
- No runtime file changes: `lib/runtime/guard.ts`, `guardScope.ts`,
  `guardTripInterrupt.ts`, `prompt.ts`, `runBatch.ts`, and all
  serialization formats stay untouched.
- The legacy `as` parses and is ignored; the formatter never prints it.
- Hard-require: `raises`-annotated code containing (or transitively
  calling) a guard must list `std::guard`, via the EXISTING
  `checkFunctionTypeRaises` diagnostic (spec decision 4).
- Run `make` before running any agency fixture; save test output to
  files; never run the full agency suite locally (CI does).
- Commit after every green task. Never commit on main — work stays on
  the `guard-keyword` branch (worktree
  `/Users/adityabhargava/agency-lang/.claude/worktrees/guard-keyword`).

---

# Part 0: Background — read this before touching code

## How guard compiles today

`guard(cost: $1) as { ... }` is not special anywhere in the front end.
It parses as an ordinary `functionCall` whose arguments are three named
args plus one `blockArgument` (the generic `as { }` mechanism,
`lib/parsers/parsers.ts:3163` `blockArgumentParser`). The preprocessor
lifts the block into a module-registered closure named `__block_N`
(`lib/preprocessors/liftCallbacks.ts`); codegen emits a call to the
stdlib `guard` function (`stdlib/thread.agency:219`), whose body is four
lines: `_pushGuard`, `_runGuarded`, `_popGuard`, return. Those helpers
in `lib/stdlib/thread.ts` are the whole runtime.

Two structural facts are load-bearing and must survive unchanged:

1. **The guard impl runs in its own frame with its own step ids.** Trip
   interrupt keys live in that frame's `stack.other`; the settle window
   is "one step before `_popGuard`"; checkpoint resumes replay into
   those step paths. If the construct inlined push/run/pop into the
   caller, every one of those assumptions would shift silently.
2. **The block closure is named `__block_N` and module-registered.**
   Checkpoint revival resolves function refs by that name
   (`lib/blockNames.ts`, the #513 lazy-stub machinery). The construct
   must produce its block through the SAME lifting path, not a new one.

Both facts are why this plan desugars to the legacy call shape instead
of writing new codegen: after the desugar pass runs, the compiler
cannot tell the construct ever existed.

## Where expressions like this live in the grammar

`match` and `if` expressions are NOT general atoms. They are offered at
specific VALUE positions via `or(...)` alternatives:

- assignment / declaration values (`lib/parsers/parsers.ts:3698`):
  `or(messageThreadParser, matchBlockExprParser, ifExpressionParser, exprParser)`
- return values (`lib/parsers/parsers.ts:2911`): same shape.

`guardBlockParser` joins exactly those `or(...)` lists, ahead of
`exprParser`. Statement position comes from the statement-parser list
(where `messageThreadParser`, `handleBlockParser` etc. are registered,
`lib/parsers/parsers.ts:3985-3999`).

**A refinement over the spec worth knowing:** the construct parser only
commits when it sees `guard` + word boundary + `(` args `)` +
optional `as` + `{`. Without the trailing block it FAILS and input falls
through to the normal call/identifier grammar. Consequence: a variable
or function named `guard` mostly keeps parsing (only the exact
`guard(...) {` shape is claimed). The spec said "variables named guard
stop parsing"; the implementation is strictly less breaking. Keep it
that way — it is free.

## The desugar precedent

`lib/preprocessors/parallelDesugar.ts` rewrites `parallel { ... }`
blocks into `fork(...)` call + `blockArgument` nodes inside
`typescriptPreprocessor` (wired at `typescriptPreprocessor.ts:33`).
Guard desugaring is the same move with less bookkeeping: one node in,
one `functionCall` out, no bindings hoisted.

## The impl's new name and reachability

The stdlib def renames `guard` → `__guard` in `stdlib/thread.agency`
(still exported from the module) and gets re-exported by the auto-import
prelude (`stdlib/index.agency`) so the desugared call resolves in every
module with zero imports. Double-underscore marks it internal by
convention. The dead user import `import { guard } from "std::thread"`
then fails with the EXISTING unresolved-import diagnostic (AG4008/4009
family — pin whichever fires in a test; do not add a code).
`prunePreludeShadows` handles any user symbol named `__guard` the same
way it handles other prelude collisions.

## Pipeline map (what runs when)

`parse → SymbolTable.build → buildCompilationUnit →
TypescriptPreprocessor (desugar lives here) → TypeScriptBuilder →
printTs()`. The typechecker (`agency tc`, and the check pass inside
compilation) operates on the PARSED tree — it sees `guardBlock`; the
builder never does.

---

# Task 1: the `guardBlock` AST node

**Files:**
- Create: `lib/types/guardBlock.ts`
- Modify: `lib/types.ts` (the `AgencyNode` union + re-export)
- Modify: `lib/utils/bodySlots.ts` (register the body slot)
- Test: `lib/utils/bodySlots.test.ts` (extend)

**Interfaces:**
- Produces: `type GuardBlock = { type: "guardBlock"; cost: Expression | null;
  time: Expression | null; label: Expression | null;
  argOrder: ("cost" | "time" | "label")[]; body: AgencyNode[];
  loc?: Loc }`. Every later task consumes this exact shape. `argOrder`
  records the source order of the named arguments so the formatter can
  print them as written. A legacy `as` in the source is parsed and
  simply discarded — nothing downstream needs to know it was there
  (the formatter test asserts on printed OUTPUT, not on a node field).

Terminology used throughout this plan: the **head** is everything
between the `guard` keyword and the block — the parenthesized
`cost:` / `time:` / `label:` list in `guard(cost: $1, time: 5m) { ... }`.
Head arguments are ordinary named arguments; the word only
distinguishes them from the block, since the construct is not a
function call.

- [ ] **Step 1: write the failing bodySlots test**

In `lib/utils/bodySlots.test.ts`, follow the existing per-node cases
(look at how `finalizeBlock` is asserted) and add:

```ts
it("guardBlock exposes its body slot", () => {
  const node = {
    type: "guardBlock",
    cost: null,
    time: null,
    label: null,
    argOrder: [],
    body: [{ type: "returnStatement", value: null }],
  } as any;
  expect(bodySlots(node).map((s) => s.body)).toEqual([node.body]);
});
```

- [ ] **Step 2: run it, watch it fail**

`npx vitest run lib/utils/bodySlots.test.ts` — expect the new case to
fail (unknown node type → no slots).

- [ ] **Step 3: create the node type and register it**

`lib/types/guardBlock.ts`, modeled line-for-line on
`lib/types/finalizeBlock.ts` (same imports, same `Loc` optionality):

```ts
import { AgencyNode, Expression } from "../types.js";

/** The `guard(head) { body }` construct (spec:
 *  docs/superpowers/specs/2026-07-17-guard-keyword-design.md).
 *  Desugared by the preprocessor into the legacy functionCall +
 *  blockArgument shape — see lib/preprocessors/guardDesugar.ts. */
export type GuardBlock = {
  type: "guardBlock";
  cost: Expression | null;
  time: Expression | null;
  label: Expression | null;
  /** Source order of the named arguments, for source-faithful
   *  formatting. */
  argOrder: ("cost" | "time" | "label")[];
  body: AgencyNode[];
  loc?: { line: number; col: number };
};
```

Add `GuardBlock` to the `AgencyNode` union in `lib/types.ts` next to
`FinalizeBlock`, and register the body slot in `lib/utils/bodySlots.ts`
next to the `finalizeBlock` case.

- [ ] **Step 4: tests pass** — rerun Step 2's command; also
  `npx tsc --noEmit`.

- [ ] **Step 5: capture the legacy-lowering goldens (plan review
  finding 2 — do this NOW, while the old parse still exists)**

Task 2 claims `guard(...) as {`, after which nothing can re-derive what
the OLD syntax compiled to. Capture it first:

```bash
mkdir -p tests/goldens/guard-lowering
for f in tests/agency/guards/guard-cost-no-trip \
         tests/agency/guards/guard-time-trip \
         tests/agency/guards/trip-time; do
  pnpm run preprocess "$f.agency" > "tests/goldens/guard-lowering/$(basename $f).json"
done
git add tests/goldens/guard-lowering
```

These are scaffolding for Task 4 Step 6's real equivalence diff; Task 8
deletes them once the fixture-churn gate has taken over the invariant.

- [ ] **Step 6: commit** — `feat: guardBlock AST node + body slot + legacy lowering goldens`.

---

# Task 2: the parser

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Test: `lib/parsers/guardBlock.test.ts` (create, co-located per parser
  convention)

**Interfaces:**
- Consumes: `GuardBlock` from Task 1.
- Produces: `guardBlockParser: Parser<GuardBlock>`, registered (a) in
  the statement-parser list and (b) in BOTH value-position `or(...)`
  lists (assignment ~:3698, return ~:2911) ahead of `exprParser`.

- [ ] **Step 1: write the failing parser tests**

`lib/parsers/guardBlock.test.ts` — follow the style of the co-located
parser tests. Cases, each parsing a full program through `parseAgency`
and asserting on the AST (`JSON` shape), not parser internals:

```ts
const HEAD_CASES = [
  ['guard(cost: $1) { return 1 }', { cost: "present", time: null }],
  ['guard(time: 5m, cost: $1) { return 1 }', "order-free"],
  ['guard(label: "x") { return 1 }', "label-only"],
  ['guard() { return 1 }', "empty-head"],
];
```

1. Each head case inside `node main() { const r = ... }` produces a
   `guardBlock` node as the declaration value, with the named args
   mapped to the right fields and `argOrder` reflecting source order.
2. Return position: `node main() { return guard(cost: $1) { return 1 } }`.
3. Statement position: bare `guard(time: 5ms) { doWork() }` inside a
   node body parses as an expression statement holding a `guardBlock`.
4. Legacy `as`: `guard(cost: $1) as { return 1 }` parses to a node
   deep-equal to the `as`-less form (the `as` leaves no trace).
5. Word boundary: `guardrails(x)` parses as a plain `functionCall`.
6. No block → not claimed: `const g = guard(1)` (a call to a
   user-defined `guard` function) still parses as a `functionCall` —
   the fall-through refinement from Part 0.
7. Positional args rejected: `guard($1) { return 1 }` fails to parse as
   a construct AND does not parse as a call-with-block (no `as`), so it
   surfaces a parse error mentioning the expected named arguments —
   assert via the parse failure, no new diagnostic code.

- [ ] **Step 2: run, watch fail** —
  `npx vitest run lib/parsers/guardBlock.test.ts`

- [ ] **Step 3: implement the head-args parser**

In `lib/parsers/parsers.ts`, next to `_threadNamedArgsParser`
(~:4036) and modeled on it — named keys restricted to
`cost` / `time` / `label`, each capturing an `exprParser` value,
comma-separated, any order, duplicates rejected the same way
`_threadNamedArgsParser` rejects them:

```ts
type GuardNamedArgs = {
  cost: Expression | null;
  time: Expression | null;
  label: Expression | null;
};
const _guardNamedArgsParser: Parser<GuardNamedArgs> = (input) => {
  // mirror _threadNamedArgsParser: seen-map, one entry per key,
  // unknown key → failure("expected cost:, time:, or label:", input)
};
```

- [ ] **Step 4: implement `guardBlockParser`**

Modeled on `_messageThreadParser` (~:4087) for the shape and on
`handleBlockParser` (~:4204) for the keyword word-boundary check:

```ts
export const guardBlockParser: Parser<GuardBlock> = label(
  "a guard block",
  withLoc(memo("guardBlockParser", seqC(
    set("type", "guardBlock"),
    str("guard"),
    // word boundary: `guardrails(...)` must not match
    not(varNameChar),
    optionalSpaces,
    char("("),
    optionalSpaces,
    capture(optional(_guardNamedArgsParser), "_args"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    // legacy `as`: accepted and DISCARDED — it leaves no trace on the node
    optional(seqC(str("as"), spaces)),
    optionalSpaces,
    char("{"),                    // ← the commit point: no `{`, no claim
    captureCaptures(parseError(
      "expected block body followed by `}`",
      spaces,
      capture(bodyParser, "body"),
      optionalSpacesOrNewline,
      char("}"),
    )),
  ))),
);
```

Post-map `_args` into the node fields (null defaults; `argOrder` from
the parse order). The `char("{")` placement is what makes case 6 fall
through: tarsec failure before consuming commits nothing.

- [ ] **Step 5: register it**

- Statement list (~:3985): add `lazy(() => guardBlockParser)` next to
  `messageThreadParser`.
- Both value-position `or(...)` lists (assignment ~:3698, return
  ~:2911): insert `lazy(() => guardBlockParser)` BEFORE `exprParser`.

- [ ] **Step 6: tests pass** — Step 2's command, then the whole parser
  suite: `npx vitest run lib/parsers > /tmp/scratch-parsers.log`.
  Also sanity-parse a real file:
  `pnpm run ast tests/agency/guards/trip-time.agency > /dev/null` (old
  syntax must still parse — it is now claimed by the construct via the
  legacy-`as` arm, producing the same node the new syntax would).

  **Watch out:** `trip-time.agency` and friends parse guard through the
  construct now. Until Task 4's desugar exists, compilation of guard
  files is BROKEN in the middle of this plan. That is expected: the
  branch is red for the Task 2 and Task 3 commits — fine on a feature
  branch, do not "fix" it — and do NOT run `make fixtures` in that
  window (it would churn or fail). Fixtures rejoin at Task 4 Step 6.

- [ ] **Step 7: commit** — `feat: parse the guard construct`.

---

# Task 3: the formatter (which is also the migration tool)

**Files:**
- Modify: the AgencyGenerator (find the `messageThread` /
  `handleBlock` print cases; the generator lives in
  `lib/backends/` — locate with `grep -rn "handleBlock" lib/backends/*generator*`)
- Test: co-located generator test file (extend), plus one fmt
  round-trip case

**Interfaces:**
- Consumes: `GuardBlock`.
- Produces: canonical printing — `guard(<args in source order>) { ... }`,
  never `as`.

- [ ] **Step 1: failing test** — in the generator's test file, add:

```ts
it("prints guard canonically and drops legacy as", () => {
  const src = 'node main() {\n  const r = guard(cost: $1, label: "x") as {\n    return 1\n  }\n  return r\n}\n';
  const out = generate(parseAgency(src));   // match the file's helpers
  expect(out).toContain('guard(cost: $1, label: "x") {');
  expect(out).not.toContain(" as {");
});
```

- [ ] **Step 2: run, watch fail.**

- [ ] **Step 3: implement the print case** — print the named arguments
  in `argOrder` (the node's record of source order — the three typed
  fields alone cannot express it), skipping absent ones. Body prints
  through the same block-printing helper `handleBlock` uses. Never
  print `as`.

- [ ] **Step 4: pass + fmt smoke** — run the test; then
  `pnpm run fmt tests/agency/guards/guard-time-trip.agency | head -30`
  and eyeball: `as` gone, body intact.

- [ ] **Step 5: commit** — `feat: format the guard construct; fmt strips legacy as`.

---

# Task 4: the desugar pass (the whole lowering)

**Files:**
- Create: `lib/preprocessors/guardDesugar.ts`
- Create: `lib/preprocessors/guardDesugar.test.ts`
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` (wire the pass
  where `desugarParallelInBody` is wired, `:33` import + its call site)
- Modify: `stdlib/thread.agency` (rename `guard` → `__guard`, keep the
  doc comment)
- Modify: `stdlib/index.agency` (prelude re-export of `__guard`)

**Interfaces:**
- Consumes: `GuardBlock` nodes anywhere in a body.
- Produces: in-place replacement with a `functionCall` node:
  `__guard(cost: <expr|null>, time: <expr|null>, label: <expr|null>)`
  plus a `blockArgument` `{ type: "blockArgument", inline: false,
  params: [], body: <guardBlock.body> }` — the EXACT shape the legacy
  parse produced (compare `lib/parsers/parsers.ts:2298-2330` for how
  calls carry block args).

- [ ] **Step 1: failing desugar unit test**

`lib/preprocessors/guardDesugar.test.ts`, modeled on
`parallelDesugar.test.ts`:

```ts
it("rewrites guardBlock into the legacy __guard call shape", () => {
  const body = parseNodeBody('const r = guard(cost: $1) { return 1 }');
  desugarGuardsInBody(body);
  const call = /* the declaration's value */;
  expect(call.type).toBe("functionCall");
  expect(call.functionName).toBe("__guard");
  const block = call.arguments.find((a) => a.type === "blockArgument");
  expect(block.params).toEqual([]);
  expect(block.body).toHaveLength(1);
});
it("desugars nested guards innermost-safe (walk children first)", ...);
it("legacy-as nodes desugar identically", ...);
```

- [ ] **Step 2: run, watch fail.**

- [ ] **Step 3: implement `desugarGuardsInBody`**

Recursive walk over `bodySlots` (guard bodies included via Task 1's
registration — children first, then replace the node). Named-arg nodes
must match what the legacy call parse produced for
`guard(cost: $1, ...)` — copy the named-argument node shape from a
`pnpm run ast` dump of a legacy call before writing this. Absent args
are OMITTED from the call (the stdlib def's defaults supply null), so
the emitted call matches what users write today.

- [ ] **Step 4: wire into typescriptPreprocessor** next to
  `desugarParallelInBody` — same traversal entry, guards BEFORE
  callback lifting (the block must exist as a `blockArgument` when
  `liftCallbacks` runs so it becomes a normal `__block_N`).

- [ ] **Step 5: move the impl to the prelude (plan review finding 1 —
  the saveDraft shape, NOT a re-export)**

Three edits, and the middle one is the actual mechanism:

- **Move the four-line def** out of `stdlib/thread.agency:219` and into
  `stdlib/index.agency` as `def __guard(cost, time, label, block)` —
  same body (`_pushGuard` / `_runGuarded` / `_popGuard` / return),
  exported. Import the three TS helpers in `index.agency` exactly the
  way it already imports `_saveDraft` (copy that import line's form;
  `index.agency` is non-templated, which is what makes this legal).
  The `guard` def leaves `thread.agency` entirely — its docstring
  content moves to the guide in Task 8.
- **Add `__guard` to the literal prelude import list** at line 1 of
  `lib/templates/backends/agency/template.mustache` (the
  `import { print, printJSON, … } from "std::index"` literal). That
  list IS the auto-import mechanism; re-exporting from `index.agency`
  alone auto-imports it into exactly zero modules. Run
  `pnpm run templates` after editing the mustache file.
- **Why not rename-in-place in `thread.agency`:** `thread.agency` is
  TEMPLATED, so it receives the prelude import — a `__guard` re-export
  in `index.agency` sourced from `thread.agency` is a
  `thread` ↔ `index` module cycle, the exact thing
  `isNonTemplatedStdlib` (`lib/importPaths.ts:104`) exists to prevent.
- `make` (stdlib + templates changed).

- [ ] **Step 6: the equivalence test against the Task 1 goldens — this
  is the plan's acceptance gate in miniature**

Diff the NEW pipeline's output against the legacy goldens captured in
Task 1 Step 5 (comparing the legacy-`as` arm to the braces arm would
prove nothing — both go through the same desugar; the goldens are the
only surviving record of what the OLD parse compiled to):

```bash
for f in guard-cost-no-trip guard-time-trip trip-time; do
  pnpm run preprocess tests/agency/guards/$f.agency > /tmp/scratch-$f-new.json
  # Normalize the two KNOWN, intended differences before diffing:
  #   1. loc fields (positions shift with the syntax)
  #   2. the callee: `guard` (imported) → `__guard` (prelude), and the
  #      dropped `import { guard }` line's residue
  # Everything else must be byte-identical — especially __block_N
  # names, step-relevant structure, and argument shapes.
  diff <(normalize tests/goldens/guard-lowering/$f.json) \
       <(normalize /tmp/scratch-$f-new.json)
done
```

(The fixtures' sources must be migrated — `as` dropped, import line
removed — for this run; that edit is these three files' real migration,
landing early. Write `normalize` as a ten-line jq/node script in
`tests/goldens/guard-lowering/normalize.mjs`; it dies with the goldens
in Task 8.)

Then compile-and-run one real fixture end to end:
`pnpm run agency test tests/agency/guards/guard-cost-no-trip.test.json`.

- [ ] **Step 7: run the desugar tests + preprocessor suites**
  `npx vitest run lib/preprocessors > /tmp/scratch-preproc.log`

- [ ] **Step 8: commit** — `feat: desugar guard construct to the __guard call`.

---

# Task 5: typechecker — `Result<T>` and the block rules

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts` (the `guardBlock` case)
- Test: the synthesizer/checker test file that covers `try` expressions
  (find with `grep -rln "tryExpression" lib/typeChecker/*.test.ts`) —
  extend it

**Interfaces:**
- Consumes: `GuardBlock`.
- Produces: the construct synthesizes to the same `Result<T>` type a
  `try` expression produces, with `T` = the join of the block's return
  types and the failure side `GuardFailureData`.

**How:** the `try` expression's synthesis is the in-repo constructor
for `Result<T>` — copy its type-building, not its control flow. The
block body checks like an unannotated def body: open a function-boundary
scope (the `isFunctionBoundary` flag from the scope-visibility work),
check statements, join return types into `T`. Head args check as:
`cost`/`time`: `number | null`; `label`: `string | null`.

`saveDraft` and `finalize` need NO new wiring if the block scope is
opened the same way the legacy block argument's scope was — verify
rather than assume: the draft-type rule keys off the enclosing
function/block scope's return type, and the construct's body scope must
land in the same registry. One test each proves it.

- [ ] **Step 1: failing tests**

1. `const r = guard(cost: $1) { return 1 }` → `r` is `Result<number>`;
   `r.value` narrows to `number` under `isSuccess`.
2. Mixed returns join: block returning `1` and `"x"` →
   `Result<number | string>`.
3. `r.error.maxTime` typechecks (failure side is `GuardFailureData`).
4. Head arg type errors: `guard(cost: "expensive") { ... }` → the
   existing type-mismatch diagnostic.
5. `saveDraft("x")` inside a block whose `T` is `number` → the existing
   draft-mismatch diagnostic.
6. A `finalize` inside the block returning the wrong type → existing
   finalize diagnostic.

- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement the synthesizer case** per the How above.
- [ ] **Step 4: pass; then the checker suite:**
  `npx vitest run lib/typeChecker > /tmp/scratch-tc.log`
- [ ] **Step 5: commit** — `feat: type the guard construct as Result<T>`.

---

# Task 6: the effect — `std::guard` enters the analysis

**Files:**
- Modify: the effect-collection walk that populates
  `interruptEffectsByFunction` (`lib/typeChecker/interruptAnalysis.ts`,
  `collectRaisableEffects` / its `collectFromBody` helper ~:472)
- Test: `lib/typeChecker/functionTypeRaises.test.ts` (extend) and the
  interruptAnalysis test file (extend)

**Interfaces:**
- Consumes: `GuardBlock` nodes during the collect walk.
- Produces: `"std::guard"` in the containing function's entry in
  `interruptEffectsByFunction`. Everything else — transitive
  propagation, `checkFunctionTypeRaises` (`functionTypeRaises.ts:176`),
  function-type raises checking — is existing machinery and gets NO
  changes.

- [ ] **Step 1: failing tests**

1. Direct: a `raises`-annotated def containing a guard without
   `std::guard` in the clause → the existing raises diagnostic fires.
2. Listing `std::guard` satisfies it.
3. Transitive: annotated `a()` calls unannotated `b()` which contains a
   guard → `a` requires `std::guard`.
4. Function type: passing a guard-containing function where the
   parameter type's `raises` lacks `std::guard` → existing error.
5. Negative: a guard-free annotated function does NOT need it, and a
   handler-wrapped guard still DOES (no effect discharge — spec
   decision 5).
6. **The warning walker (spec decision 8):** a BARE
   `guard(cost: $1) { ... }` in a node body with no enclosing handler →
   the existing unhandled-interrupt warning fires (it would otherwise
   be invisible: `checkUnhandledInterruptWarnings`,
   `lib/typeChecker/interruptAnalysis.ts:384`, keys on `functionCall`
   nodes and skips everything else).
7. The same guard wrapped in `handle { ... } with (i)` → NO warning
   (the existing `isInsideHandler` discharge applies to the construct
   the same way it applies to interrupting calls).

- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement** — one `case "guardBlock":` in the collect
  walk adding the constant effect, plus recursing into the body (the
  bodySlots-driven walk may already recurse; verify, don't duplicate).
- [ ] **Step 4: implement the warning case** — in
  `checkUnhandledInterruptWarnings`, treat a `guardBlock` node as a
  site carrying `["std::guard"]`, sharing the existing warning code and
  the existing `isInsideHandler` check. No new diagnostic code.
- [ ] **Step 5: pass; rerun the checker suite.**
- [ ] **Step 6: commit** — `feat: guard construct enters raises analysis and the unhandled-interrupt warning`.

---

# Task 7: migrate the world

**Files:** every `.agency` file matching `guard(` with an
`import { guard }` line — stdlib, fixtures, agency-js tests, examples.

- [ ] **Step 1: mechanical sweep**

```bash
# Sweep by MODULE, not by the exact import string — a literal
# 'import { guard }' misses every multi-name line like
# `import { guard, getThread } from "std::thread"` (plan review
# finding 3), and those files would otherwise surface as mystery
# failures in Step 5:
grep -rln 'from "std::thread"' stdlib/ tests/ | tee /tmp/scratch-migrate.txt
# For each hit: if the import list names `guard`, remove exactly that
# name (keep the others; delete the line only when guard was alone),
# then run the formatter to strip `as`:
pnpm run fmt <file>   # writes canonical construct syntax
```

`std::agents` (`stdlib/agents/*.agency`) is the largest stdlib
consumer.

- [ ] **Step 2: stdlib raises clauses**

`pnpm run tc stdlib/` (directory typecheck) — every hard-require error
is a stdlib signature needing `std::guard` added. Fix them all; zero
suppressions.

- [ ] **Step 3: the churn gate**

`make && make fixtures`, then `git diff --stat tests/`. Compiled `.js`
churn must be limited to the mechanical rename (`guard` → `__guard` in
emitted calls) and import-line removals. Anything structural — changed
step ids, changed block names, reordered statements — is a Task 4 bug;
stop and fix there, do not paper over here.

- [ ] **Step 4: the pinned-diagnostic test**

One checker test: `import { guard } from "std::thread"` now fails with
the existing unresolved-import diagnostic (assert the code it actually
produces — AG4008/9/10 family), pinning the migration UX.

- [ ] **Step 4b: expected warning churn (spec decision 8)**

The taught warning walker makes every BARE node-body guard in the
corpus warn. Post race-proofing, most guards fixtures are
handler-wrapped and stay silent; the remainder (e.g. `checkpointApproved`
in trip-time, harness-answered fixtures) will print the warning in
sweep output. Warnings do not fail fixtures — verify the sweep logs
show only EXPECTED new warnings, and list them in the PR body so the
reviewer sees the coverage change as a decision, not noise.

- [ ] **Step 5: sweeps, saved to files**

```bash
pnpm run agency test tests/agency/guards > /tmp/scratch-guards.log
pnpm run agency test tests/agency/handlers > /tmp/scratch-handlers.log
pnpm run agency test tests/agency/subprocess > /tmp/scratch-subprocess.log
pnpm run agency test js tests/agency-js/guard-feedback > /tmp/scratch-gf.log
npx vitest run lib > /tmp/scratch-units.log
pnpm run lint:structure
```

All green before proceeding.

- [ ] **Step 6: commit** — `feat: migrate stdlib and test corpus to the guard construct`.

---

# Task 8: docs + wrap-up

**Files:**
- Modify: `docs/site/guide/guards.md` (syntax update — owner-owned
  page, mechanical change, flag it in the PR body for the owner's read)
- Modify: `docs/site/guide/ts-helpers.md` + the effects guide
  (`docs/site/guide/effects-and-raises.md` or wherever `raises` is
  documented — locate) — the TS-boundary paragraph (spec decision 6)
  and `std::guard` in the effects story
- Modify: `docs/dev/interrupts.md` — one paragraph noting guard is now
  a construct lowering to the same call
- The generated stdlib reference: verify how `agency doc` treats the
  underscore-prefixed `__guard` export (spec Part 5). If it skips
  underscore names, done; if not, its docstring reads "internal — use
  the guard construct" so the generated entry is honest.

- [ ] **Step 1: make the doc edits.** Keep the guards-guide examples
  compiling: parse-check every updated snippet with a scratch file +
  `pnpm run ast` (the CLAUDE.md snippet discipline).
- [ ] **Step 2: delete the scaffolding** —
  `git rm -r tests/goldens/guard-lowering` (the Task 1 goldens and
  `normalize.mjs`; the fixture-churn gate now owns the invariant).
- [ ] **Step 2b: full validation once more** (same commands as Task 7
  Step 5) plus `npx tsc --noEmit`.
- [ ] **Step 3: anti-pattern audit** of the whole diff against
  `docs/dev/anti-patterns.md` (methods over free functions,
  declarative walks, no cross-object field-reaching).
- [ ] **Step 4: spec cross-check** — walk the spec's Parts 3–6 and
  point at the task that delivered each requirement; record deviations
  in a "as executed" section appended to the spec.
- [ ] **Step 5: commit, push, PR** — body written to a file (quoting
  rule), linking the spec, issue #571, and flagging the guards-guide
  edit for owner review. CI runs the full suite.

---

# Review rounds (folded before execution)

## Plan review (`2026-07-17-guard-keyword-REVIEW.md`)

1. **BLOCKER — the prelude plan had a cycle under it:** rename-in-place
   in `thread.agency` + re-export via `index.agency` is a
   `thread` ↔ `index` module cycle, because `thread.agency` is
   TEMPLATED and receives the prelude. Fixed: the def MOVES into
   `index.agency` (the saveDraft shape) and `__guard` joins the literal
   prelude list in `template.mustache` — the step that was missing
   entirely. Task 4 Step 5 rewritten; spec Part 5 amended.
2. **The equivalence test was comparing the desugar to itself** (both
   arms of the new parser). Fixed: Task 1 Step 5 captures legacy-parse
   goldens BEFORE Task 2 destroys the old parse; Task 4 Step 6 diffs
   against them with the two intended differences normalized.
3. **The migration grep missed multi-name imports** (`import { guard,
   getThread }` does not contain the literal `import { guard }`).
   Fixed: sweep by `from "std::thread"` and inspect hits.
4. **`argOrder` retrofit** — already fixed in the prior commit (the
   review predates it): the field lives in Task 1's type, Task 2
   populates it, Task 3 just prints.

## Spec review (`specs/2026-07-17-guard-keyword-design-REVIEW.md`)

Four findings; the spec was amended (decisions 8 and 9, the
stated soundness property, the named reachability mechanism) and this
plan absorbed them:

1. **Soundness property stated** — spec Part 1 now names what `raises`
   bounds (escape-to-an-acting-handler, not pass-through) and
   re-derives the cross-branch-handler case under it. No plan change;
   the attribution the plan implements is unchanged.
2. **Warning-walker gap** → Task 6 Steps 1.6/1.7/4 and Task 7 Step 4b.
3. **Impl reachability** → Task 4 Step 5 as written (rename-and-export
   `__guard` + prelude re-export, the #553 saveDraft precedent); the
   plan additionally verifies the doc generator's treatment of
   underscore exports in Task 8.
4. **Reservation scope** → the plan's Part 0 "no-`{`-no-claim"
   refinement, now spec decision 9.

# Self-review notes (done at write time)

- **Spec coverage:** Part 3 (syntax) → Tasks 2–3; Part 4 (typing,
  effects) → Tasks 5–6; Part 5 (lowering + acceptance) → Task 4 (the
  equivalence test) + Task 7 Step 3 (the churn gate); Part 6
  (migration, docs, testing) → Tasks 7–8; decisions 3/6/7 → Task 4
  Step 5, Task 8, and the absence of any new diagnostic anywhere.
- **Known mid-plan breakage:** between Task 2 and Task 4, guard files
  parse as constructs but cannot compile. Flagged in Task 2 Step 6.
  Execute in order; do not run fixture suites in that window.
- **Type-name consistency:** `GuardBlock` / `guardBlock` /
  `desugarGuardsInBody` / `__guard` are used identically across tasks.
- **Deliberate refinement over the spec:** the no-`{`-no-claim parser
  commit point (Part 0) makes `guard`-named identifiers mostly keep
  working. Recorded here and to be recorded in the spec's as-executed
  notes.
