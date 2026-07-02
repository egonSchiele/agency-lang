# Match Expressions: block arms, assignability, and `return`-yields semantics

**Date:** 2026-07-01
**Status:** Approved design, pending implementation plan

## Summary

Extend `match` from a statement-only construct to a full expression, with three changes:

1. **Block arms.** Arm bodies may be a braced block of statements, not just a single statement.
2. **Match as an expression.** A match may appear anywhere an expression can: assigned to a variable, passed as an argument, or returned from a function.
3. **`return` yields to the match.** Inside a match arm, `return expr` produces the arm's value for the match itself — it does NOT return from the enclosing function. Single-expression arms (`pattern => expr`) yield implicitly.

This is a **breaking change**: today, `return` inside a match arm returns from the enclosing function. Section "Breakage and migration" specifies how the break is made loud (compile error) rather than silent.

## Motivation

Today the only ways to get a value out of a match are assigning to an outer variable inside every arm or returning from the enclosing function:

```agency
let points = 0
match(grade) {
  "A" => points = 100
  "B" => points = 80
  _ => points = 0
}
```

Match-as-expression removes the mutable-outer-variable dance:

```agency
const points = match(grade) {
  "A" => 100
  "B" => 80
  _ => 0
}
```

Every mainstream language with `match` (Rust, Scala, OCaml, Kotlin's `when`) treats it as an expression. Agency keeps its own convention — no implicit block values anywhere in the language — by requiring an explicit `return` in block arms, mirroring how JS arrow functions distinguish `x => expr` from `x => { return expr }`.

## Syntax

An arm body is one of:

- **Single expression:** `pattern => expr` — the arm yields `expr` (implicit, unchanged surface syntax).
- **Block:** `pattern => { statements }` — the arm yields via explicit `return expr`.

```agency
const val = match(result) {
  success(r) => {
    print(r)
    return r.value
  }
  failure(e) => e.message
}
```

Guards are unchanged: `pattern if (cond) => body`. Arm separators are unchanged (newline or `;`).

### Grammar disambiguation: `=> {`

A `{` immediately after `=>` always begins a **block**, never an object literal. To yield an object literal from a single-expression arm, parenthesize it or use a block:

```agency
kind => ({ label: kind })          // parenthesized object literal
kind => { return { label: kind } } // block form
```

This matches the JS arrow-function rule and avoids parser ambiguity.

### AST change

`MatchBlockCase.body` changes from `Expression | Assignment | ReturnStatement` to `AgencyNode[]` (`lib/types/matchBlock.ts`). A single-expression arm parses as a one-element body containing the expression; this mirrors `IfElse.thenBody` and simplifies downstream passes. The parser change is in `matchBlockParserCase` (`lib/parsers/parsers.ts:3003`): the body becomes `or(blockParser, returnStatementParser, assignmentParser, exprParser)`.

### Expression grammar

`match(...) { ... }` is added to the expression parser. A match at statement level continues to parse as a statement node (statement parsers try first, as today). Position — statement vs. expression — is therefore determined syntactically: `const x = match(...)`, `f(match(...))`, and `return match(...)` are expression position; a match alone as a statement is statement position.

## Semantics of `return`

**Rule: `return` targets the nearest enclosing value scope — a match arm if there is one, otherwise the function body.**

- `return expr` directly in an arm block yields `expr` as the match's value; execution continues after the match.
- `return` inside an `if`/`while`/`for` nested within an arm block still yields to the match (the arm is the nearest value scope).
- A nested match's arms yield to the *inner* match.
- Functions cannot be defined inside other functions in Agency, so there is no def-inside-arm case.
- To return from the enclosing function based on a match, write `return match(...) { ... }` — the match is in expression position and its value is returned.

```agency
def classify(r: Result<number>): string {
  return match(r) {
    success(v) => "got ${v}"
    failure(e) => "err: ${e}"
  }
}
```

A single-statement arm `pattern => return expr` remains grammatically valid and is equivalent to `pattern => expr` (both yield). In statement position it is an error per the next section.

### Handlers

`handle` blocks may now appear inside block arms like any other statement. `return` semantics *within a handler body* are unchanged from today; a match arm *inside* a handler body yields to its match as usual. Handler registration must flow through block arms exactly as it does through `IfElse` bodies — handlers are safety-critical and must never be skipped (verify during implementation; see Testing).

## Position-specific rules

### Expression position

- **Every arm must yield on every code path.** A bare `return` (no value) or a path that falls off the end of an arm block is a compile error: `match arm must return a value when the match is used as an expression`. This reuses the all-paths-return analysis used for function bodies.
- **Exhaustiveness is a hard error**, regardless of `config.typechecker.matchExhaustiveness`. A value must exist on every path, so `silent`/`warn` configurations do not apply in expression position. Guarded arms still do not count toward coverage; open scrutinee types need `_`.
- **Typing is bidirectional.** In checked position (`const val: string = match ...`), each arm's yielded expressions are checked against the expected type. In synthesis position, the match's type is the union of all arms' yield types. Existing pattern narrowing (Result patterns, object patterns, field-path narrowing) applies inside block arms unchanged.

### Statement position

- Arms are effect-only. Block arms are now allowed.
- **`return` anywhere in an arm is a compile error** with a fixit-style message: `` `return` inside a match arm yields the match's value, but this match's value is unused — did you mean `return match(...)`? `` See "Breakage and migration."
- Exhaustiveness follows `config.typechecker.matchExhaustiveness` as today.

## Breakage and migration

Today `return` in an arm exits the enclosing function; under this design it yields to the match. Without mitigation, existing code like

```agency
match(r) {
  success(v) => return "got ${v}"   // today: exits function
  failure(e) => return "err: ${e}"
}
return "unreachable"
```

would silently change behavior (fall through to `"unreachable"`). The statement-position error above converts every such site into a **loud compile failure** pointing at the fix: hoist the `return` — `return match(r) { success(v) => "got ${v}" failure(e) => "err: ${e}" }`.

Matches that mix function-exit arms with effect-only arms cannot be mechanically hoisted and must be restructured by hand (e.g., assign an optional result and return conditionally after the match).

Migration tasks in scope:

- Sweep `tests/`, stdlib `.agency` sources, and examples for `return` inside match arms; rewrite as `return match(...)` or restructure. Known sites include `tests/agency/pattern-matching/resultPatternMatch.agency` and `tests/agency/pattern-matching/matchGuardFallthrough.agency`.
- Rebuild fixtures (`make fixtures`).
- Changelog entry marking the breaking change with before/after examples.

Note: `lowerMatchIsForm` (`lib/lowering/patternLowering.ts:305`) synthesizes a `failure(...)` **function return** in the else branch of the `match(x is pattern)` form. That lowering runs after (or must be adjusted alongside) the new semantics so its synthesized return still targets the function, not a match arm. Audit during implementation.

## Lowering, the step runner, and interrupts

Match blocks already compile to the same IR as if/else: `processMatchBlockWithSteps` (`lib/backends/typescriptBuilder.ts:1286`) emits `ts.runnerIfElse` (`TsIfSteps`), the node that carries the `__condbranch_K` / `__substep_K` interrupt-resume machinery documented in `docs/dev/interrupts.md`. That machinery already supports multi-statement branch bodies — if/else uses it today. Consequences:

**No changes to the runtime or SimpleMachine are needed for statement-position block arms.** The work is in codegen: `processMatchBlockWithSteps` currently wraps each arm as a single unguarded node (`body: [this.processNode(caseItem.body)]`); it must instead process arm bodies through `processBodyAsParts` with unique substep ID ranges per arm, exactly mirroring `processIfElseWithSteps` (`typescriptBuilder.ts:1169`). This gives every arm statement its own substep guard. `processBlockPlain` (the `insideHandlerBody` path, `typescriptBuilder.ts:3223`) generalizes the same way. Routing arm bodies through `processBodyAsParts` also means handler registration, hook firing, and checkpointing inside arms flow through the identical code path as if/else bodies.

**Interrupt-in-arm resume semantics** (mostly inherited, verify with tests):

1. The winning arm is cached in `__condbranch_K` before the arm body runs. On resume, dispatch re-enters the cached arm without re-evaluating the scrutinee or guards — arm selection is stable across pause/resume even if guards or scrutinee have side effects. This is existing `TsIfSteps` behavior.
2. `__substep_K` resumes execution at the exact statement within the arm — same as `interrupt-in-if`/`interrupt-in-else` today.
3. If the match is inside a loop, the loop's end-of-iteration `clearLocalsWithPrefix` reset already clears `__condbranch_` and `__substep_` prefixed vars, so each iteration re-matches.

**Expression-position lowering.** `const val = match(...)` lowers to the statement form plus a result temp:

```
<bind scrutinee once, as lowerMatchBlock already does for pattern arms>
<TsIfSteps chain; each arm's `return expr` compiles to `__stack.locals.__matchvalue_K = expr` + exit-match>
const val = __stack.locals.__matchvalue_K
```

- **The temp must live in `__stack.locals`** (named `__matchval_<id>`, id minted by the lowering counter like `__scrutinee_N`), not a bare `let`, so it survives interrupt serialization (an interrupt can fire between the yield and the consuming statement; resume skips completed statements, so a plain `let` would be undefined after restore). No loop-iteration reset is needed for it: the all-paths-yield rule guarantees every read is preceded by a fresh write in the same iteration. (Correction to an earlier draft: the loop-iteration `clearLocalsWithPrefix` resets live in `lib/runtime/runner.ts` `loop()`/`whileLoop()`, not in mustache templates — those templates don't exist.)
- **No IIFEs wrapping arms beyond what the runner already does.** Arm bodies compile into the existing `runner.ifElse(id, branches, else)` callback structure (`runnerIfElse.mustache`); the runner manages step skipping inside those callbacks, so no new closure boundary is introduced.

**Mid-arm `return` (exit-match).** A `return` that is not the arm's last statement (e.g., inside a nested `if`) must set the temp and skip the rest of the arm and everything after it up to the end of the match. Mechanism: mirror the runner's existing `_break`/`_continue` propagation (`lib/runtime/runner.ts:239-249`, consumed by `shouldSkip()` at `:269`). The lowered `return expr` becomes a new `matchYield` AST node that compiles to `runner.exitMatch(<id>, expr); return;` — `exitMatch(matchId, value)` stores the value into the frame local `__matchval_<id>` (storage layout owned by the runner, not baked into codegen) and sets a `_matchExit` flag that `shouldSkip()` honors, so all subsequent runner constructs (steps, nested ifElse, loop iterations) skip — exactly like `breakLoop()` — until the match's own root `runner.ifElse(...)` call (which carries the match id) clears the flag in a `try/finally` on exit. The flag is transient unwind state and is never serialized: interrupts cannot fire while skipping. This is the highest-risk piece and gets dedicated interrupt tests (interrupt after a mid-arm return path, resume, verify the match value and that skipped statements never ran).

**Interrupt walkthrough** (expression position):

```agency
const val = match(r) {
  success(v) => {
    print(v)                       // substep 0
    const ok = interrupt("ok?")    // substep 1 — pauses here
    return "${v}:${ok}"            // substep 2 — sets __matchvalue_K
  }
  failure(e) => e.message
}
```

Pause serializes step, `__condbranch_K = 0`, `__substep_K = 1`, and locals. Resume re-enters the node body; outer guards skip completed statements; condbranch dispatch re-enters the `success` arm without re-matching; substep guard skips `print`; the interrupt statement completes with the response; `return` sets `__stack.locals.__matchvalue_K` and breaks out; the consuming statement reads the temp. Checkpoint/`restore()` interacts the same way it does for if/else since all tracking lives on the stack.

**Other lowering notes:**

- Pattern/guard/Result arms continue to lower through `lowerMatchBlock` (`lib/lowering/patternLowering.ts:251`); its arm-body handling generalizes from single node to node list. Expression-position lowering reuses its scrutinee-hoisting (`const __scrutinee`) so the scrutinee is evaluated exactly once.
- The Agency formatter (`lib/backends/agencyGenerator.ts:1133`) learns to print block arms.

## Testing

- **Parser** (`lib/parsers/matchBlock.test.ts`): block arms, `=> {` block-vs-object-literal rule, single-expression arms unchanged, guards on block arms, arm separators around blocks.
- **Typechecker:** all-paths-yield analysis in arm blocks (including `if`/`else` inside arms); hard exhaustiveness error in expression position under `silent`/`warn` config; union synthesis vs. checked position; narrowing inside block arms; statement-position `return` error.
- **Lowering/codegen fixtures** (`tests/typescriptGenerator/`): expression match with literal arms, Result arms, guards; mid-arm return.
- **Execution tests** (`tests/agency/`): expression match end-to-end; block arms with side effects; `return match(...)`; nested match; checkpoint inside a block arm and inside an expression-position match (extend `checkpoint-in-match.agency`); handler registered inside a block arm fires correctly.
- **Substep/interrupt tests** (`tests/agency/substeps/`), mirroring the existing if/else suite: `interrupt-in-match-arm` (statement position, second statement of a block arm — verify earlier arm statements don't re-run on resume), `interrupt-in-match-expression` (expression position — verify the yielded value survives pause/resume), `interrupt-in-match-in-loop` (verify `__matchvalue_`/`__condbranch_` reset between iterations), interrupt after a mid-arm `return` inside a nested `if` (verify exit-match skips trailing arm statements), and a match arm whose guard has side effects (verify guards are not re-evaluated on resume).
- **Formatter:** `pnpm run fmt` round-trips block arms.

No LLM calls are needed for any of these.

## Docs

- `docs/site/guide/pattern-matching.md`: add expression-match and block-arm sections; document the `return`-yields rule and the `=> ({...})` object-literal rule.
- Fix stale claim at `docs/site/guide/pattern-matching.md:201` that exhaustiveness defaults to a warning — the default is `error` (`lib/typeChecker/matchExhaustiveness.ts:246`, changed in `e11ca557`).
- `docs/site/guide/basic-syntax.md`: mention match in the expression forms if it lists them.

## v1 restrictions (discovered during implementation planning)

- **Expression position is limited to assignment RHS (`const x = match(...)`) and return operands (`return match(...)`).** Agency has no generic hoist-subexpression-to-temp pass; supporting match in arbitrary expression slots (call arguments, binop operands) would require building one. The restriction is enforced structurally by the grammar: the match-expression parser is wired into exactly those two capture sites rather than the general expression atom, so `f(match(...) {...})` is a parse error. These two positions cover the motivating use cases.
- **Module-level `const x = match(...)` initializers are a v1 compile error.** Module-level initializers run through the init-topsort machinery (`docs/dev/init-topsort.md`), which plans one initializer expression per variable; a lowered match region is multiple statements. Supporting this is future work.
- **The `match(x is pattern)` form stays statement-only.** Its lowering synthesizes a `failure(...)` function return on head mismatch, which has no coherent meaning in expression position.
- **`return`-to-match may not cross a concurrency boundary.** A `return` inside a `parallel`/`fork`/`race`/`thread` block within an arm is a compile error — those branches are separate execution contexts the `_matchExit` unwind cannot cross.
- **The all-paths-yield check is syntactic** (a statement either is a yield, or is an `if`/`else` whose branches both always yield), performed during pattern lowering, rather than reusing the flow-graph `checkDefiniteReturns` pass (which runs post-lowering, deliberately skips match-containing bodies, and has no per-arm view). Loops never count as yielding on all paths.

## Out of scope

- If-expressions or any other expression-oriented control flow.
- Valueless arms in expression position (explicitly rejected).
- Implicit tail-expression values in blocks (explicitly rejected — Agency has no implicit block values).
- New keywords (`yield`, etc.) in the surface syntax (`matchYield` is an internal AST node produced by lowering, not writable by users).
