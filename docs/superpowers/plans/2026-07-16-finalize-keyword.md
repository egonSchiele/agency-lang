# The `finalize` Keyword Implementation Plan (PR B, re-planned for revision 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the main session (owner preference: no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `finalize { ... }` blocks: when an abort stops a scope, its finalize runs with the scope's locals — including the aborted callee's partial bound into the local it was headed for — and the finalize's return becomes the scope's forced return value.

**Architecture:** This plan supersedes the PR-B tasks in `2026-07-15-save-draft-carry-on-abort.md`, which were written against the exception transport. Under revision 3 (aborts travel as `AbortedResult` return values), a frame stops at three kinds of compiled site — its own catch, the post-call aborted check, and (new lowering, finalize scopes only) a checked temp at return-position calls — across FOUR emission points the executor edits: `functionCatchFailure.mustache`, `blockSetup.mustache`, `assignmentAbortedGuard`, and `processReturnStatement`. Finalize plugs into those stop sites via one runtime method, `AbortedResult.withFinalize`, which replaces the partial with the finalize's return and falls back to the existing partial if the finalize fails. The locals binding is nearly free: at an assignment site the callee's aborted result is ALREADY in the local; the check unwraps it (via `partialValueOrNull()` — never by field-reaching) before the finalize runs.

**Incorporates the external review** (`2026-07-16-finalize-keyword-REVIEW.md`): the return-expression smuggling hole is closed by a checker rule (rule 6 below) rather than lowering — hoisting a whole return expression to statement position cannot help (the aborted value is consumed INSIDE the expression before any check runs), and hoisting each call subexpression individually would break short-circuit evaluation (`a || f()` must not evaluate f unconditionally). The fork-boundary drop is documented and pinned; the transitive no-interrupts map gets an explicit imported-function verification; the partial unwrap is encapsulated behind a method.

**Tech Stack:** parser (`lib/parsers/parsers.ts`, tarsec), AST (`lib/types/`), formatter (`lib/backends/agencyGenerator.ts`), type checker (`lib/typeChecker/`), codegen (`lib/backends/typescriptBuilder.ts` + `lib/templates/backends/typescriptGenerator/`), runtime (`lib/runtime/abortedResult.ts`), vitest + Agency execution tests.

## Global Constraints

- **Design spec (source of truth):** `docs/superpowers/specs/2026-07-15-save-draft-carry-on-abort-redesign.md`, revision 3 — the `finalize` section AND the level-rule section. Before any code, run the Task F0 drift check.
- **One deliberate scope narrowing vs the spec (owner sign-off in review):** v1 finalize works in **defs and guard blocks only**. The spec's "works in nodes" sentence predates the value transport: above node level aborts are exceptions again and nothing consumes a node's partial (root budgets are deferred), so a node finalize would compute a value nobody reads. The checker rejects it with a message saying so.
- **Branch mechanics:** branch `finalize-keyword` off origin/main after PR #554 merges (or cut from `guards-followups` if #554 is still open — rebase before pushing). Worktree: reuse `guards-followups` or create fresh.
- Commits: message in a temp file + `git commit -F`; plain imperative subjects; Co-Authored-By line for the EXECUTING model; re-check `git branch --show-current` before every commit.
- After `stdlib/` or `lib/` changes run `make`; after `.mustache` edits run `pnpm run templates` first and commit regenerated `.ts` with sources. Run `make fixtures` after codegen changes and commit the `.mjs` companions.
- Run the FULL `tests/agency/guards/` sweep plus the subprocess sample (`nested-pause-resume`, `run-max-cost`, `pause-fork-mixed`) before the PR. Save all test output to files.
- Banned patterns per `docs/dev/coding-standards.md` / `docs/dev/anti-patterns.md`. In particular: methods on the object, not free functions taking it; no nested ternaries; every try/catch logs or rethrows.
- `docs/site/guide/guards.md` edits: draft freely but flag the wording as the owner's to edit (established convention).
- Update `docs/dev/saveDraft.md` (it promises a finalize update) in the same PR.

---

## Task F0: Drift check (before any code)

Re-read the spec's finalize section and confirm these decisions are still what the doc says. STOP on any mismatch:

1. `finalize` is a KEYWORD (grammar, next to `handle`), not a stdlib function — it must run in the scope's own frame to see locals.
2. At most one per scope, top level of the body only, position free (convention: last).
3. The finalize reads locals; the aborted callee's partial is bound into the local its call was assigning. In `const x = f(g())`: g aborting leaves `x` null (argument-position drop happens at the call boundary before f runs); f aborting leaves `x` holding f's partial.
4. Body rules: a finalize error never masks the trip (fall back to the saved draft, else nothing, and log); no interrupts (statically checked, transitively); no `saveDraft` inside; v1 computational-only (the tripped guard's signal still fires, so leaf ops inside the finalize cancel — that is documented, not shielded).
5. The finalize's return type checks against the enclosing scope's return type; inside the body every local reads as possibly-null.

Also reproduce the walked example by hand under revision 3 mechanics: `code` calls `verify` via `const x = verify()`; verify aborts with partial `"v-partial"`; the statement-site check binds `x = "v-partial"`, runs code's finalize, which returns `"combined:v-partial"`; the guard salvages that. If your trace disagrees, stop.

---

### Task F1: Parser + AST + formatter for `finalize { }`

**Files:**
- Create: `lib/types/finalizeBlock.ts`
- Modify: `lib/types.ts` (add to the `AgencyNode` union; find where `HandleBlock` is registered and mirror it)
- Modify: `lib/parsers/parsers.ts` (statement parser; mirror `handleBlockParser`, minus the `with` suffix)
- Modify: `lib/backends/agencyGenerator.ts` (formatter arm; grep `handleBlock` for the precedent)
- Test: `lib/parsers/finalizeBlock.test.ts` (mirror `lib/parsers/handleBlock.test.ts`'s harness exactly)

**Interfaces:**
- Produces: AST node `{ type: "finalizeBlock"; body: AgencyNode[]; loc }` parseable at statement position inside def and block bodies. F2–F4 consume it.

- [ ] **Step 1: Write the failing parser tests** (in `lib/parsers/finalizeBlock.test.ts`, using `handleBlock.test.ts`'s `normalizeCode` harness):

```ts
import { finalizeBlockParser, bodyParser } from "./parsers.js";

describe("finalizeBlockParser", () => {
  it("parses a finalize block with a return", () => {
    const result = finalizeBlockParser(normalizeCode(`finalize {\n  return "a"\n}`));
    expect(result.success).toBe(true);
    expect(result.result.type).toBe("finalizeBlock");
    expect(result.result.body).toHaveLength(1);
  });

  it("parses inside a def body, landing a finalizeBlock node in the body", () => {
    const result = bodyParser(normalizeCode(`saveDraft("d")\nfinalize {\n  return "a"\n}`));
    expect(result.success).toBe(true);
    const kinds = result.result.map((n) => n.type);
    expect(kinds).toContain("finalizeBlock");
  });

  it("parses a multi-statement body, an empty finalize, and finalize-not-last", () => {
    expect(finalizeBlockParser(normalizeCode(`finalize {\n  const a = 1\n  return a\n}`)).success).toBe(true);
    expect(finalizeBlockParser(normalizeCode(`finalize {\n}`)).success).toBe(true);
    const notLast = bodyParser(normalizeCode(`finalize {\n  return "a"\n}\nsaveDraft("d")`));
    expect(notLast.success).toBe(true);
    expect(notLast.result.map((n) => n.type)).toContain("finalizeBlock");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:run lib/parsers/finalizeBlock.test.ts`, expected: `finalizeBlockParser` is not exported.
- [ ] **Step 3: Implement.** `lib/types/finalizeBlock.ts`:

```ts
import { AgencyNode, BaseNode } from "../types.js";

/** `finalize { ... }` — runs when an abort stops the enclosing scope; its
 *  return becomes the scope's forced return value (the salvage a guard
 *  receives). A declaration, not control flow: position in the body does
 *  not matter, and at most one is allowed per scope. */
export type FinalizeBlock = BaseNode & {
  type: "finalizeBlock";
  body: AgencyNode[];
};
```

Parser: copy `handleBlockParser`'s structure for keyword-then-braced-body, keyword `finalize`, no binder and no `with` clause. Register in the same statement-alternatives list `handleBlockParser` sits in. Check how `handle` avoids capturing a variable named `handle` and match that treatment.
- [ ] **Step 4: Formatter arm** — every `switch`/dispatch on `handleBlock` in `agencyGenerator.ts` gets a `finalizeBlock` arm printing `finalize {`, the indented body, `}`. Add an AUTOMATED round-trip case to `lib/backends/agencyGenerator.test.ts` (parse → generate → parse, finalize block survives byte-stable) — a manual `pnpm run fmt` probe pins nothing against regressions. Probe additionally by hand: `pnpm run ast tmp/finalize-probe.agency` and `pnpm run fmt tmp/finalize-probe.agency` on the walked example.
- [ ] **Step 5: Run parser + generator suites** — `pnpm test:run lib/parsers lib/backends/agencyGenerator.test.ts`, green. Commit: `Parse and format finalize blocks`.

### Task F2: Checker rules

**Files:**
- Modify: `lib/typeChecker/checker.ts` (structural checks + return-type check), `lib/typeChecker/interruptAnalysis.ts` (no-interrupts rule)
- Modify: `lib/typeChecker/diagnostics.ts` + `lib/typeChecker/diagnosticExplanations.ts` (new AG6 codes; run `make diagnostics-docs` after)
- Test: `lib/typeChecker/finalize.test.ts` (same harness as `saveDraft.test.ts`)

**Interfaces:**
- Consumes: `finalizeBlock` AST (F1); `info.returnType`; `interruptEffectsByFunction` (already computed by `analyzeInterruptsFromScopes` — this is what makes the no-interrupts rule TRANSITIVE for free).
- Produces: five rules, each with its own registry entry (message text final at implementation time, one entry per rule):
  1. return-type: finalize `return`s check against the enclosing scope's return type (reuse the machinery `checkReturnTypesInScope` applies to the scope's own returns).
  2. structural: at most one finalize per scope; top level of the body only.
  3. no interrupts: neither a direct `interrupt(...)` in the body nor a call to a function with a non-empty `interruptEffectsByFunction` entry. EXPLICIT VERIFICATION, not an assumption: confirm the map is populated for IMPORTED functions (stdlib and cross-file), not just same-unit defs — write a test where the finalize calls an imported interrupting function (e.g. `input` from the prelude). If imported callees are NOT covered, say so in the rule's explanation page ("direct and same-file transitive calls are checked; imported calls are caught at runtime") and rely on F3's runtime backstop — documented, not silent.
  4. no `saveDraft` in the body.
  5. placement: defs and guard/`as {}` blocks only; a finalize in a NODE body errors with "finalize in a node has no effect: nothing above a node consumes a partial result yet".
  6. return shape (finalize scopes only): a `return` expression that CONTAINS an Agency call must BE a single direct call. `return f(x)` and `return someVar` are fine; `return "x:" + f()`, `return [f()]`, `return {k: f()}` error with "assign the call to a local first, then return the local". WHY AN ERROR AND WHY HERE: an aborted value consumed inside an expression bakes garbage into the return before any stop site can fire, silently skipping the finalize — and no lowering fixes it (whole-expression hoisting checks too late; per-call hoisting breaks short-circuit evaluation). Restricting the return shape makes F4 Step 4's direct-call lowering exhaustive. The equivalent gap at ASSIGNMENT sites (`const x = "a:" + f()`) stays in the documented shared envelope with interrupts — the checker rule covers returns only, the finalize-skip vector.

- [ ] **Step 1: Write the failing checker tests**, one accept and one reject per rule. Reject cases (each expects ≥1 error):

```
def f(): string { finalize { return 42 } return "x" }                              // rule 1
def f(): string { finalize { return "a" } finalize { return "b" } return "x" }     // rule 2
def f(): string { if (true) { finalize { return "a" } } return "x" }               // rule 2
def f(): string { finalize { interrupt("no") return "a" } return "x" }             // rule 3, direct
def asker(): string { interrupt("ask") return "a" }
def f(): string { finalize { return asker() } return "x" }                         // rule 3, transitive
def f(): string { finalize { saveDraft("no") return "a" } return "x" }             // rule 4
node main() { finalize { return "a" } return "x" }                                 // rule 5
def g2(): string { return "ok" }
def f(): string { finalize { return "a" } return "x:${g2()}" }                     // rule 6: call embedded in a return expression
def f(): string { finalize { return "a" } }                                        // definite-returns: still errors (finalize is not a normal-path return)
```

Accept cases (zero errors each): the spec's walked example (finalize returning a string in a `(): string` def); a finalize directly inside a `guard(...) as { }` block; a finalize that is NOT the last statement of the body (position is free); `return g2()` — a direct call in return position — inside a finalize scope (rule 6 permits it).

EVERY reject case must assert the SPECIFIC diagnostic code of its rule, not "≥1 error" — the harness returns `e.code` alongside `e.message`. This matters most for rule 1 (the ordinary return-type checker may also flag `return 42`, so a generic assertion would stay green with the finalize rule entirely broken) and rule 3 (a generic interrupt diagnostic is not the finalize diagnostic).
- [ ] **Step 2: Run to confirm every reject case currently passes with zero diagnostics** (the red state), then implement rule by rule, registry entry by registry entry. The explanations Record is exhaustive-by-type: the compiler forces each explanation.
- [ ] **Step 3 — DECISION GATE (nullable locals).** The spec: inside a finalize body every local reads as `T | null` (any statement might not have run). Investigate whether flow narrowing (`docs/dev/typechecker/narrowing/`) supports a scope-level "all locals nullable here" context cheaply — the finalize body is a distinct region of the SAME scope, so check whether the flow graph can seed the region with widened bindings. If cheap: implement + two tests (unguarded use errors under strict settings; a `!= null` check narrows). If invasive: STOP and present the owner options (a) invasive-now (b) document-and-defer with a tracking issue. Do not silently pick (b). Acknowledge the UX cost either way: all-locals-nullable is sound but conservative — a local definitely assigned before any trippable call still demands a null check inside the finalize; the owner weighs that against the implementation cost. WHICHEVER branch the gate takes, pin the SHIPPED semantics with a test — if the decision is defer, add the test that documents today's (unchecked) behavior so the eventual change is visible.
- [ ] **Step 4:** `pnpm test:run lib/typeChecker` green; `make diagnostics-docs`; commit: `Type-check finalize blocks`.

### Task F3: Runtime — `AbortedResult.withFinalize`

**Files:**
- Modify: `lib/runtime/abortedResult.ts`
- Test: `lib/runtime/abortedResult.test.ts`

**Interfaces:**
- Consumes: the existing `AbortedResult` (immutable, cause-by-identity, self-logging).
- Produces: `withFinalize(finalize: () => Promise<unknown>, scopeName: string): Promise<AbortedResult>` — called at every stop site of a finalize-bearing scope, AFTER `fromError`/`carryThrough` built the draft-or-nothing instance — and `partialValueOrNull(): unknown`, the ONLY way generated code reads a partial (the `{ value }` wrapper that distinguishes a saved null from no-partial is internal to the class; mirrors what `deliver()` does internally). Codegen must never touch `.partial` fields directly.

- [ ] **Step 1: Write the failing unit tests** (extend the existing stub-statelog harness):

```ts
describe("AbortedResult.withFinalize", () => {
  it("replaces the partial with the finalize's return", async () => { /* fromError with draft "d"; withFinalize(async () => "f"); expect partial {value:"f"}; cause identity preserved */ });
  it("a finalize returning null is a real partial", async () => { /* partial {value:null} */ });
  it("falls back to the existing partial when the finalize throws, and logs", async () => { /* withFinalize(async () => { throw new Error("boom") }) → same partial as before; one statelog error-ish event; the returned instance is usable */ });
  it("treats an interrupting finalize as a failure (backstop)", async () => { /* finalize resolves to an Interrupt[]-shaped value; hasInterrupts → fallback like a throw */ });
  it("treats an aborted finalize as a failure (backstop)", async () => { /* finalize resolves to an AbortedResult (a def it called was aborted — the signal is still firing); isAborted → fallback */ });
  it("emits a carried event for the finalize's partial", async () => { /* action "carried" with the finalize value's preview */ });
  it("with NO prior partial: a successful finalize becomes the partial", async () => { /* fromError with no draft; withFinalize(async () => "f") → partial {value:"f"} */ });
  it("with NO prior partial: a throwing finalize leaves no partial and does not crash", async () => { /* partial stays undefined; one failure log; instance usable */ });
});

describe("AbortedResult.partialValueOrNull", () => {
  it("returns the partial's value", () => { /* draft "d" → "d" */ });
  it("returns a saved null (a real partial)", () => { /* draft null → null */ });
  it("returns null when there is no partial", () => { /* fromError with no draft → null */ });
});
```

- [ ] **Step 2: Implement.** Sketch (final shape may adjust to the file's existing private helpers):

```ts
  /** A finalize-bearing scope is stopping: run its finalize and make the
   *  return this scope's partial. A finalize failure never masks the trip
   *  — the abort continues with the partial this instance already holds
   *  (the saved draft, or nothing) and the failure is logged. Two failure
   *  shapes are backstops for what the checker already forbids or the
   *  fired signal produces: a finalize that resolves to interrupts, or to
   *  an aborted result of its own. */
  async withFinalize(
    finalize: () => Promise<unknown>,
    scopeName: string,
  ): Promise<AbortedResult> {
    let value: unknown;
    try {
      value = await finalize();
    } catch (finalizeError) {
      this.logFinalizeFailure(scopeName, finalizeError);
      return this;
    }
    if (hasInterrupts(value) || isAborted(value)) {
      this.logFinalizeFailure(scopeName, value);
      return this;
    }
    return new AbortedResult(this.cause, { value }, this.unwindSpanId)
      .logged("carried", /* frame-less variant — see note */);
  }
```

Note: `logged` currently takes a frame for the args preview; add a frame-optional path or pass the frame through `withFinalize` — decide against the file, keep one logging chokepoint. `logFinalizeFailure` posts through the statelog client's `error` event with `errorType: "finalizeError"` (check the client's existing `error()` signature and match it).
- [ ] **Step 3:** `pnpm test:run lib/runtime/abortedResult.test.ts` green. Commit: `Add AbortedResult.withFinalize`.

### Task F4: Codegen — compile the body, wire the three stop sites

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (`buildFunctionBody` / `processFunctionDefinition`: strip the finalizeBlock from the statement stream, compile it to a `__finalize` closure; `assignmentAbortedGuard`: finalize-aware variant with local binding; `processReturnStatement`: checked-temp lowering for return-position calls in finalize scopes)
- Modify: `lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache` (+ regenerated `.ts`): `{{#hasFinalize}}` branch
- Modify: `lib/templates/backends/typescriptGenerator/blockSetup.mustache`: same branch for blocks
- Test: fixture regen (`make fixtures`) + the F5 execution fixtures

**Interfaces:**
- Consumes: `finalizeBlock` AST (F1); `withFinalize` (F3).
- Produces: in finalize-bearing scopes only — everywhere else compiles byte-identically to today (verify via `make fixtures` producing no diffs for existing fixtures once the templates' no-finalize branch renders the current text).

- [ ] **Step 1: Compile the finalize body to `__finalize`.** VERIFY FIRST (this was rev 2's explicit gate and it still holds): read how `handleBlock`'s inline-handler body compiles (`typescriptBuilder.ts` case "handleBlock", ~L624) and mirror that closure shape. Target shape in `setupStmts`:

```ts
const __finalize = async (): Promise<any> => {
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: <moduleId>, scopeName: "<fn>#finalize" });
  /* compiled finalize statements — `return x` lowers to runner.halt(x), the block lowering */
  return runner.halted ? runner.haltResult : undefined;
};
```

The distinct `scopeName` keeps its `__substep_*` keys from colliding with the body's. Interrupts are statically impossible (F2), and the runtime backstop (F3) covers what slips through.

HOW THE FINALIZE SEES THE SCOPE'S VARIABLES — the rule is: EVERY pass that walks a scope body treats `finalizeBlock.body` as same-scope statements (like an `if` body), never as a new scope (unlike an `as {}` block or a handler body). Three enforcement points, each independently checkable:

1. Scope ANNOTATION (the preprocessor/symbol-table pass that stamps each variable reference with its scope kind and blockDepth) must descend into `finalizeBlock.body`. This is what makes locals/params resolve to the frame, enclosing-block references resolve to the right `__bframe_*` depth, and globals/statics keep compiling through their ALS-resolved accessors (`__globals()`, `__readStatic`) — globals never touch the frame, so they work in the finalize for free, including branch-isolated globals inside a fork.
2. DEFINITE-RETURNS must IGNORE `finalizeBlock.body` — the inverse direction. A finalize `return` is a forced-return computation, not a normal-path return: `def f(): string { finalize { return "a" } }` with no real return must STILL error, and a finalize must never satisfy the definite-returns pass. Add a checker test for exactly that source.
3. The generic walkers (`walkNodes` and any pass that switches on statement node types — prunePreludeShadows, hoistBodyTypeAliases, interrupt analysis) must see inside the node. Grep for `handleBlock` arms as the checklist of switch sites; decide same-scope vs ignore per pass and write the decision down in a comment at each arm.

Then, in codegen: compile the finalize's statements under the FUNCTION's variable scope (do NOT push a block scope in the ScopeManager for it). Locals live on the frame, so `x` in the finalize body must compile to `__stack.locals.x` — the same slot the body wrote and the same slot the statement-site check binds the callee's partial into. The Runner's `"<fn>#finalize"` scopeName is ONLY a step-counter namespace; variable resolution must be the function's. If a block scope were pushed, references would resolve against a fresh `__bstack` and see nothing — the exact failure that forced finalize to be a keyword instead of a stdlib block function. For a finalize in a guard BLOCK, the same rule with the block's own scope and `__bstack`. Verify by compiling the F0 walked example and checking the finalize body's `x` compiles to the frame slot, then pin behaviorally with `finalize-consumes-partial`. Resume composes for free: the def's setup re-runs in deserialize mode and recreates `__finalize` over the RESTORED frame (`finalize-after-resume` pins this).
- [ ] **Step 2: The frame-catch site.** `functionCatchFailure.mustache` rung becomes:

```
if (__error instanceof AgencyAbort) {
{{#hasFinalize}}
  return await AbortedResult.fromError(__error, __stack, {{{functionName}}}).withFinalize(__finalize, {{{functionName}}});
{{/hasFinalize}}
{{^hasFinalize}}
  return AbortedResult.fromError(__error, __stack, {{{functionName}}});
{{/hasFinalize}}
}
```

Same branch structure in `blockSetup.mustache`'s catch. Pass `hasFinalize` from the builder at both render sites.
- [ ] **Step 3: The statement site with binding.** In `assignmentAbortedGuard`, when the current scope has a finalize AND the guarded value is an assignment's local (not the bare-call temp), emit:

```ts
if (isAborted(<varRef>)) {
  const __abortedCallee = <varRef>;
  <varRef> = __abortedCallee.partialValueOrNull();
  runner.halt(await __abortedCallee.carryThrough(__stack, "<scope>").withFinalize(__finalize, "<scope>"));
  return;
}
```

(`partialValueOrNull()` — never `.partial` field-reaching in generated code; the `{ value }` wrapper is the class's internal detail, and a leak here gets baked into every finalize-scope fixture.) For the bare-call temp there is nothing to bind — same emission minus the middle assignment. At implementation, check whether the two variants collapse into one emission; if they stay split, the split is genuine (one has a local to rebind). Blocks use `__bstack`. Track "current scope has a finalize" on the ScopeManager entry (set when F1's node is stripped in Step 1; blocks likewise).
- [ ] **Step 4: Return-position calls in finalize scopes get a checked temp.** In `processReturnStatement`, when the scope has a finalize and the return value is a function call, lower `return f(...)` to a temp + the same aborted check (no local to bind), so the finalize ALWAYS speaks for its scope — pass-through would silently skip it. This lowering is exhaustive BECAUSE of F2 rule 6: any other call-embedding return shape in a finalize scope is a compile error, so a direct call is the only call-bearing return that reaches codegen. Scopes without a finalize keep today's halt-through lowering, byte-identical.

Also add a short comment + plan note for the FORK boundary: a finalize inside a forked branch runs when the branch aborts, but `startInvoke`'s `.then` drops the partial at the boundary (`atForkBoundary`) — the finalize's salvage is discarded exactly like a branch's saveDraft. Consistent, deliberate, and pinned by the `finalize-inside-fork` fixture; a future fork-array salvage is the principled extension.
- [ ] **Step 5:** `pnpm run templates && make && make fixtures`. Confirm existing fixtures' `.mjs` companions show NO diff (`git status`) — the no-finalize path must be unchanged. Run the full guards sweep — all green. Commit: `Compile finalize blocks into the three stop sites`.

### Task F5: Execution fixtures

**Files:** create in `tests/agency/guards/` (all with `useTestLLMProvider` + `llmMocks` where an llm call drives the trip; `guard(cost: 0.000001)` + one mocked call = the standard trip):

- [ ] `finalize-consumes-partial.agency` — the walked example: verify saves `"v-partial"` and trips; `code`'s `const x = verify()` binds it; code's finalize returns `"combined:${x}"` (guarding for null); guard salvages `"combined:v-partial"`. THE load-bearing fixture; its expected value comes from the spec.
- [ ] `finalize-nested-call-binding.agency` — two nodes: g trips inside `const x = f2(g())` → finalize sees `x == null` → `"g-tripped:x-null"`; f2 trips after g succeeded → finalize sees f2's partial → `"f2-tripped:<partial>"`.
- [ ] `finalize-error-falls-back.agency` — the finalize throws; the scope saved a draft first; the guard salvages the DRAFT and the run does not crash.
- [ ] `finalize-in-guard-block.agency` — finalize directly inside `guard(...) as { ... }`; its return is the salvage.
- [ ] `finalize-on-return-position.agency` — finalize-bearing def whose trip escapes through `return verify()`; the finalize still runs (Step F4.4) and its return wins. THE FINALIZE'S RETURN MUST BE A VALUE THE PASS-THROUGH PATH COULD NEVER PRODUCE (e.g. prefix it `"finalized:"` while verify's partial has no prefix) — otherwise an omitted Step F4.4 lets verify's own partial through and the test stays green.
- [ ] `finalize-not-run-on-success.agency` — no trip: the finalize never executes (pin with a side effect the finalize would perform — e.g. the finalize returns a sentinel the node would surface).
- [ ] `finalize-after-resume.agency` — interrupt/resume inside the scope, then a trip; the finalize runs with the restored locals.
- [ ] `finalize-reads-globals.agency` — the finalize reads a module global (and a param) alongside the bound partial; pins that non-frame variable kinds resolve inside the finalize.
- [ ] `finalize-composes.agency` — outer def (with finalize) calls inner def (with finalize) via `const x = inner()`; inner trips. Pin the ordering end-to-end: inner's finalize runs first, outer's local `x` binds INNER'S FINALIZED value (not inner's raw draft — make them distinguishable), outer's finalize consumes it, the guard salvages outer's result. This is the plan's "composition falls out of value propagation" claim under test.
- [ ] `finalize-wins-over-draft.agency` — a scope with BOTH a saveDraft and a successful finalize; the guard salvages the finalize's return, not the draft (the success-path complement of `finalize-error-falls-back`).
- [ ] `finalize-cancel-not-salvaged.agency` — the scope is stopped by a NON-guard abort (agency-js test with a cancel, or a raceLoser shape): the finalize may compute, but nothing converts the abort to a success — the run terminates as a cancel does today. Pins that salvage stays guard-only.
- [ ] `finalize-inside-fork.agency` — a finalize-bearing def trips inside a fork branch under an outer guard; the branch's finalized partial is dropped at the fork boundary and the guard fails. Pins the F4 fork note.
- [ ] At least one fixture above must trip on `time:` rather than `cost:` (the time trip arrives via the abort signal cancelling a leaf op — a different path into the frame catch than a cost trip). If none naturally does, flip `finalize-after-resume` to a time trip.
- [ ] Run all seven + the FULL guards sweep + the subprocess sample. Commit: `Pin finalize semantics with execution fixtures`.

### Task F6: Docs + PR

- [ ] Update `docs/dev/saveDraft.md`: replace the "will be extended when finalize lands" note with a finalize section (the three stop sites, `withFinalize`, the binding-is-free insight, the fallback rule); adjust the files table.
- [ ] `docs/site/guide/guards.md`: draft a short finalize subsection under "Partial results with saveDraft" (flag wording as the owner's to edit).
- [ ] Commit this plan file. Push; open the PR titled `Add finalize blocks: translate a partial before the guard receives it`. Body: the walked example with values, the three stop sites, the body rules, the nullable-locals decision (from F2's gate), the node-scope narrowing vs the spec (explicitly for owner sign-off), and the deferred items (shielding + grace budget, fork-array salvage).

---

## Self-Review

**Spec coverage:** keyword surface + one-per-scope + top-level-only → F1/F2; return-type + no-interrupts (transitive, via `interruptEffectsByFunction`) + no-saveDraft → F2; nullable locals → F2 decision gate (not silent); never-mask-the-trip + computational-v1 backstops → F3; locals binding incl. `f(g())` both directions → F4 Step 3 + F5 fixture; runs at the frame catch AND statement sites AND return position → F4 Steps 2-4 + F5 fixtures (`finalize-on-return-position` pins the case naive pass-through would miss); composition (inner finalize before outer) needs no work — it falls out of values propagating one level at a time; works in guard blocks → F4 Step 2 + F5 fixture; NODES deliberately excluded with a checker error — flagged as the one spec deviation, for owner review.

**Placeholder scan:** F3 Step 1 test bodies are outlined in comments rather than full code — deliberate: they extend an existing harness whose helper names the executor must reuse (`withStubStatelog`, `abortedWithDraft`), and each comment names the exact assertion. F4 Step 1 carries the same VERIFY-against-handle gate rev 2 had, now with the file/line anchor.

**Type consistency:** `withFinalize(finalize, scopeName)` matches all three emission sites; `__finalize: () => Promise<any>` matches the closure built in F4 Step 1; `hasFinalize` is the template flag at both render sites; the F5 expected strings match F0's walked-example values.

**Review-round incorporation (2026-07-16-finalize-keyword-REVIEW.md):** return-expression smuggling → F2 rule 6 (checker error; lowering rejected with reasons) + reject test; fork-boundary drop → F4 note + `finalize-inside-fork`; transitive-map coverage → F2 explicit verification + imported-callee test; `.partial` field-reaching → `partialValueOrNull()` in F3, called in F4 Step 3; exact-diagnostic-code assertions in F2; F1 body-node + breadth + automated formatter round-trip; distinct finalize output in `finalize-on-return-position`; composition, wins-over-draft, cancel-not-salvaged, and time-trip coverage in F5; `withFinalize` no-prior-partial unit cases; nullable-locals pinned whichever branch the gate takes; emission-point count corrected to four.

**Known risks, named:** (1) the nullable-locals gate may be invasive — it has an explicit stop; (2) the return-position temp lowering changes fixture output ONLY for finalize scopes — F4 Step 5's no-diff check pins that; (3) `logged`'s frame parameter needs a frame-less variant for `withFinalize` — small refactor inside one file, flagged in F3, and it must remain the SINGLE logging chokepoint (one method, frame-optional), not a fork of it.
