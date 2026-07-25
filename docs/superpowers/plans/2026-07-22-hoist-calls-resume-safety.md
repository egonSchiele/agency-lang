# Hoist Calls for Resume Safety — Implementation Plan (rev 3: review + simplifications S1/S2/S3/S5/S6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in the main session (this project does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-process resume never desyncs the frame queue: helper calls that completed before a pause become their own skippable steps (the `hoistCalls` preprocessor pass), and any residual frame theft fails loudly (the scope-name tripwire).

**Architecture:** A new AST-to-AST pass in `lib/preprocessors/hoistCalls.ts` built on the existing walkers (`lib/utils/mapBodies.ts` + `lib/utils/bodySlots.ts` for statement recursion; a generic child walk only for expression interiors), with position rules expressed as a three-value rulings table the traversal consults. Zero builder changes for the pass. The tripwire stamps frames at the sites that CLAIM a frame (codegen preambles + two hand-written runtime sites), never in the Runner constructor, because finalize Runners run on frames they do not own.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-22-hoist-calls-resume-safety-design.md`
**Review incorporated:** `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-22-hoist-calls-resume-safety-REVIEW.md` — all blocking issues, corrections, anti-patterns, the test critique, and simplifications S1 (conditional collapsed into opaque), S2 (no lint rule; counter seeding is the protection), S3 (no legacy accommodations; statelog emit via the ALS pattern, not a parameter), S5 (five tasks, same commits), S6 (permanent compiled-shape assertion; red run is a one-time manual check), S7 (if/else-break rewrite, no negation).

**Tech Stack:** TypeScript (compiler + runtime), typestache templates, vitest, Agency execution tests.

## Global Constraints

- NEVER commit on main. All work on branch `adit/hoist-calls-resume-safety` in a worktree inside the agency-lang directory. Re-check `git branch --show-current` before every commit.
- Save every test run's output to a file.
- Do not run the full agency test suite locally; CI does. Unit tests: `npx vitest run <path>`. Agency tests: `pnpm run agency test <file>`.
- After changing anything the compiler emits or any `.mustache` template: `pnpm run templates` (if templates changed), then `make` — plain `pnpm run build` skips `lib/agents`, and agency tests exercise stdlib compiled by the CURRENT compiler.
- Agency syntax in fixtures: `def name(args): Type { ... }`, parenthesized conditions, `let`/`const`, braces always.
- No apostrophes in command-line commit messages. Do not touch CHANGELOG.md.
- No backwards compatibility with old checkpoints is required (owner ruling). Do not add tolerance branches for them.
- Paths relative to `packages/agency-lang/` unless absolute.

## Background (read first)

When Agency pauses on an interrupt, it checkpoints the frames of every function still running. On resume, the program re-runs from the top and each function reclaims its saved frame from a positional queue (`StateStack.getNewState()` in deserialize mode is a bare `this.stack.shift()`, lib/runtime/state/stateStack.ts:973-993). Completed steps are skipped by counter, so completed statements never re-run. But the statement in progress at the pause re-runs its whole body — including helper calls that already completed, like `llmOptions(...)` inside `llm(msg, llmOptions(...))`. Those helpers were not in the checkpoint, yet on replay they call `setupFunction()` and consume a saved frame belonging to a still-live function. The still-live function gets a blank frame, believes it never ran, and re-issues work — in the motivating bug, `runPrompt` re-sent a request whose thread ended with an unanswered tool call: `400 No tool output found for function call`.

Two halves:

1. **The pass:** every helper call becomes its own `const __hoist_N = ...` statement. Statements are steps, step results live on `__stack.locals`, locals serialize — so on resume the helper's step is skipped and its value read back. The helper never re-runs; the queue stays aligned.
2. **The tripwire:** frames are stamped with their owner's scope name at frame-CLAIM time; a mismatched claim throws. Residual desyncs (calls nested in opaque positions) become named errors instead of silent corruption. House precedent for throw-on-corruption: the guard-stack drift throw (stateStack.ts:957).

**The claim/run distinction (governs the tripwire).** Claiming a frame (pulling it from the queue via `setupFunction()`) and running on a frame are different events; only claims stamp. Proof it matters: `finalize { }` builds a SECOND Runner on the container's own frame (`finalizeClosure.mustache:2` passes the container's `frameVar`; `finalizeCodegen.ts:44-50` documents it). A constructor-side check would throw `foo#finalize claimed the state of foo` on every aborting finalize — a false positive on the salvage path this work protects.

## File structure

| File | Role |
|---|---|
| `lib/runtime/state/stateStack.ts` | Modify: `State.scopeName` (always serialized) + `StateJSON` field + `claimFrameForScope` |
| `lib/runtime/index.ts` | Modify: re-export `claimFrameForScope` for generated code |
| `lib/backends/typescriptBuilder.ts` | Modify: emit the claim in function (~:2247) and node (~:3067) preambles |
| `blockSetup.mustache`, `forkBlockSetup.mustache` | Modify: emit the claim after frame acquisition |
| generated-imports template | Modify: import `claimFrameForScope` |
| `lib/runtime/prompt.ts`, `lib/runtime/resumableScope.ts` | Modify: hand-written claims (TypeScript `setupFunction()` callers) |
| `lib/preprocessors/hoistCalls.ts` | Create: rulings table + pure extractor + mapBodies recursion |
| `lib/preprocessors/hoistCalls.test.ts` | Create: unit tests (incl. compiled-shape pins) |
| `lib/preprocessors/typescriptPreprocessor.ts` | Modify: one wiring line |
| `tests/agency/hoist/`, `tests/agency-js/hoist-stamp/` | Create: execution fixtures |

No lint rule (S2): no other compiler-reserved prefix (`__block_N`, `__comprehensionItem`, `__substep_`, `__condbranch_`) is linted, and the pass's counter seeding makes collision impossible. A friendly-message rule is a #646 candidate if ever wanted.

---

### Task 0: Worktree and baseline

- [ ] **Step 1:**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git worktree add worktree-hoist-calls -b adit/hoist-calls-resume-safety origin/main
cd worktree-hoist-calls/packages/agency-lang
pnpm install
make > /tmp/hoist-make.out 2>&1; tail -3 /tmp/hoist-make.out
```

- [ ] **Step 2:**

```bash
git branch --show-current   # expect: adit/hoist-calls-resume-safety
npx vitest run lib/runtime/state/stateStack.test.ts lib/runtime/runner.test.ts > /tmp/hoist-baseline.out 2>&1; tail -5 /tmp/hoist-baseline.out
```

If anything fails at baseline, stop and report.

---

### Task 1: The scope-name tripwire

**Files:**
- Modify: `lib/runtime/state/stateStack.ts` (`State.scopeName`, `StateJSON`, `toJSON` ~:219, `State.fromJSON` ~:271, `claimFrameForScope`), `lib/runtime/index.ts`, `typescriptBuilder.ts` preambles, both block templates, the generated-imports template, `prompt.ts` (:887 area), `resumableScope.ts` (:122-138)
- Test: `lib/runtime/state/stateStack.tripwire.test.ts`, `tests/agency/hoist/finalize-no-tripwire/`, `tests/agency-js/hoist-stamp/`

**Interfaces:**
- Produces: `State.scopeName: string | null` — ALWAYS serialized (S3: no back-compat, so no only-when-non-null pruning and no null-versus-missing question; the field is required in `StateJSON`, value `null` meaning "never claimed"). `claimFrameForScope(frame, scopeName)` exported from `stateStack.ts` and re-exported from `lib/runtime/index.ts`. No statelog parameter: the function reads the client via the ALS pattern (`agencyStore.getStore()?.ctx?.statelogClient`), same as `emitFunctionRefMissError` in the reviver.
- Why the emit exists at all (do not delete it as redundant with the throw): throws convert to Failures at function boundaries in this runtime, and Failures get laundered — `failOpenFeedback` turning a reviver crash into a review PASS is the incident that started this work. The statelog event is the only signal guaranteed to survive downstream laundering.

- [ ] **Step 1: Read before editing.** `State.toJSON`/`fromJSON`, `StateJSON`, `StateStack.fromJSON` (~:1152), both preamble emission sites, both templates, `resumableScope.ts:122-138`. Then enumerate claim sites and confirm the list is complete:

```bash
grep -rn "setupFunction()" lib --include="*.ts" --include="*.mustache" | grep -v test | grep -v dist
```

Any site not in the file table above also gets a claim and a line in the Task 4 docs table.

- [ ] **Step 2: Failing unit tests** — `lib/runtime/state/stateStack.tripwire.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { StateStack, claimFrameForScope } from "./stateStack.js";

describe("frame scope-name tripwire", () => {
  it("stamps an unstamped frame and accepts a matching re-claim", () => {
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "myFunc");
    expect(frame.scopeName).toBe("myFunc");
    expect(() => claimFrameForScope(frame, "myFunc")).not.toThrow();
  });

  it("throws a named error when a frame is claimed by a different scope", () => {
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "runPrompt");
    expect(() => claimFrameForScope(frame, "searchTools")).toThrow(
      /Resume desync.*searchTools.*runPrompt/s,
    );
  });

  it("refuses to stamp an empty scope name", () => {
    // Not a legacy accommodation: guards the next hand-written claim
    // site whose author forgets a name (Runner defaults scopeName to "",
    // runner.ts:159 — an empty stamp would collide with the real owner).
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "");
    expect(frame.scopeName).toBeNull();
  });

  it("scopeName is always serialized and survives a round trip", () => {
    const stack = new StateStack();
    const claimed = stack.getNewState();
    claimFrameForScope(claimed, "myFunc");
    const unclaimed = stack.getNewState();
    const json = JSON.parse(JSON.stringify(stack.toJSON()));
    const restored = StateStack.fromJSON(json);
    // Adjust frame accessors to the real API; the assertions stand.
    const frames = restored.stack;
    expect(frames[0].scopeName).toBe("myFunc");
    expect(frames[1].scopeName).toBeNull();
  });

  it("two Runners on one frame do not conflict, because running is not claiming", () => {
    // The finalize shape: the container claimed the frame; the finalize
    // Runner merely runs on it and never calls claimFrameForScope.
    const stack = new StateStack();
    const frame = stack.getNewState();
    claimFrameForScope(frame, "foo");
    expect(frame.scopeName).toBe("foo");
  });
});
```

- [ ] **Step 3: Run red**

```bash
npx vitest run lib/runtime/state/stateStack.tripwire.test.ts > /tmp/hoist-t1-red.out 2>&1; tail -8 /tmp/hoist-t1-red.out
```

- [ ] **Step 4: Implement the runtime half**

`State.scopeName: string | null = null` with the claim/run doc comment; `StateJSON` gains the required field; `toJSON()` always writes it; `State.fromJSON` restores with `?? null`. The claim function:

```ts
/** Stamp-or-check a frame claim. First claim stamps; a mismatched later
 *  claim means resume replay handed this frame to the wrong function —
 *  state corruption, so throw (house precedent: the guard-stack drift
 *  throw below). Claiming and RUNNING are different events — finalize
 *  Runners run on their container's frame and must not stamp — so this
 *  is called from frame-claim sites only, never the Runner constructor.
 *  Empty names never stamp: they mean a claim site forgot its name.
 *  The statelog emit is not redundant with the throw: throws convert
 *  to Failures at def boundaries and can be laundered downstream; the
 *  event is the signal that survives. Best-effort via the ALS pattern
 *  (no store in bare unit tests → no emit, throw still fires). */
export function claimFrameForScope(frame: State, scopeName: string): void {
  if (!scopeName) return;
  if (frame.scopeName === null || frame.scopeName === undefined) {
    frame.scopeName = scopeName;
    return;
  }
  if (frame.scopeName !== scopeName) {
    const msg =
      `Resume desync: function "${scopeName}" tried to claim the saved ` +
      `state of "${frame.scopeName}". This is a compiler/runtime bug — ` +
      `please report it with the program that produced it.`;
    agencyStore.getStore()?.ctx?.statelogClient?.error?.({
      errorType: "runtimeError",
      message: msg,
      functionName: scopeName,
    });
    throw new Error(msg);
  }
}
```

(Import `agencyStore` from `../asyncContext.js`; check for an import cycle the way messageThread once hit one — if `stateStack.ts` importing `asyncContext` cycles, move the emit into a tiny helper module instead. Verify with `npx tsc --noEmit` plus one unit run, not by assumption.)

Re-export from `lib/runtime/index.ts`. Run the unit tests green.

- [ ] **Step 5: Emit the claim at the claim sites**

Same emitted line everywhere, immediately after the frame is acquired:

```ts
claimFrameForScope(__stack, "<scopeName>");
```

Sites: function preamble + node preamble in `typescriptBuilder.ts` (same string later passed to the Runner); `blockSetup.mustache` + `forkBlockSetup.mustache` (generated block names are deterministic per compiled artifact; cross-recompile resume is outside the compat contract and now errors loudly); the generated-imports template; hand-written claims in `runPrompt` (after prompt.ts:887, name `"runPrompt"`) and `resumableScope.ts` — each with a comment noting it is hand-written because the caller is TypeScript, not generated code.

```bash
pnpm run templates > /tmp/hoist-t1-templates.out 2>&1; tail -2 /tmp/hoist-t1-templates.out
make > /tmp/hoist-t1-make.out 2>&1; tail -3 /tmp/hoist-t1-make.out
```

- [ ] **Step 6: The finalize regression fixture.** `tests/agency/hoist/finalize-no-tripwire/`: a guarded function with a `finalize` block driven to the abort path (mirror the closest existing finalize fixture: `grep -rl "finalize" tests/agency | head -3`). Expected: salvage value returned, zero occurrences of `Resume desync` in the output.

```bash
pnpm run agency test tests/agency/hoist/finalize-no-tripwire > /tmp/hoist-t1-finalize.out 2>&1; tail -3 /tmp/hoist-t1-finalize.out
grep -c "Resume desync" /tmp/hoist-t1-finalize.out   # expect 0
```

- [ ] **Step 7: Prove frames get stamped at all** (a no-op implementation must not pass). `tests/agency-js/hoist-stamp/`: run a two-function program to a pause (bash-interrupt pattern), read the serialized checkpoint from the JS side, assert a frame carries a `scopeName` from the paused chain. If checkpoint access from agency-js is awkward, the fallback is a unit test compiling a two-function program and asserting both generated preambles contain `claimFrameForScope(` — weaker but still fails on unwired codegen. Do one; name which in the commit message.

- [ ] **Step 8: Neighboring suites + commit**

```bash
npx vitest run lib/runtime > /tmp/hoist-t1-runtime.out 2>&1; tail -5 /tmp/hoist-t1-runtime.out
```

If an existing resume test trips the tripwire, STOP and investigate — that is a real pre-existing desync, not a reason to weaken the check.

```bash
git add lib/runtime lib/backends/typescriptBuilder.ts lib/templates tests/agency/hoist/finalize-no-tripwire tests/agency-js/hoist-stamp
git branch --show-current
git commit -m "runtime+codegen: stamp frames with owner scope at claim sites and fail loudly on mismatched resume claims"
```

---

### Task 2: The hoistCalls pass — table, extractor, all positions, wiring

Three commits inside this task: core, control-flow + rulings, wiring. Read `lib/utils/bodySlots.ts`, `lib/utils/mapBodies.ts`, and `comprehensionDesugar.ts` (the model consumer: `mapBodies` for statements AND its own child walk for expressions) end to end before writing code.

**Interfaces:**
- `hoistCallsInScope(body: AgencyNode[], counter?: Counter): AgencyNode[]` — entry per frame-owning scope; pure, returns a fresh list.
- `hoistCallsInProgram(program: AgencyProgram): AgencyProgram` — fresh program with rewritten function/graphNode bodies (globals excluded by construction: init-topsort owns them and they cannot pause).
- Internal `extractCalls(expr): { temps: AgencyNode[]; expr: AgencyNode }` — pure, no out-parameter. The statement rewriter withholds the statement's tail call from the extractor; there is no `isTail` flag. (Why tails stay: hoisting them uniformly would need a graph-node-call exclusion — node calls are control flow and THROW in value position, typescriptBuilder.ts:1620-1634. At tail position they need no rule at all. Record this in the header comment.)
- `Counter = { n: number }` — ONE per frame-owning scope, shared by every nested statement list in it (frame locals are flat: a loop-body `__hoist_0` would silently clobber the function-level `__hoist_0` that the loop iterable re-reads on resume). Blocks and fork branches own frames (`blockSetup.mustache`, `forkBlockSetup.mustache`) and restart at 0 via `bodySlots`' `retargetsReturn`. Seeding scans the scope for existing `__hoist_(\d+)` and starts above the max — this seeding IS the collision protection (no lint rule exists; S2).

**The rulings table (S1: three values — "conditional" collapsed into "opaque", since walking without hoisting is observably identical to not descending):**

```ts
type Ruling = "descend" | "opaque" | "statements";

// Per-row reasons live HERE, not in the traversal:
const NODE_RULINGS: Record<string, Ruling> = {
  tryExpression: "opaque",   // whole operand compiles into the __tryCall thunk;
                             // hoisting args moves throws outside the catch
                             // boundary (builder :1377-1388)
  // handleBlock with-body slot: skipped outright — compiles to plain JS
  // (builder :659-668), cannot pause (#616/#621), safety-critical.
  // retargetsReturn slots: "statements" with a fresh scope counter.
  // unlisted node types: "descend".
};

// binOpExpression rulings are operator-keyed:
//   catch      -> opaque (fallback is conditional; left excluded too, for
//                 boundary simplicity — a left temp would be semantically
//                 identical, revisit with a test change if ever worth it)
//   |>         -> input descends; stages opaque (memoized __pipe_result_
//                 runner.ts:582-596 AND conditional via __pipeBind
//                 result.ts:283-286)
//   && || ??   -> left descends; right opaque (may not execute; the first
//                 inline call there is resume-aligned by construction, so
//                 only calls NESTED under it remain residual — tripwire
//                 territory)
// if-expressions: condition descends; branches opaque.
```

One small traversal consults the table and knows nothing about `try` or pipes; adding a construct is a row plus a test. Everything copies (`bodySlots.write` / fresh nodes); nothing mutates parsed AST — in-place mutation burned this repo via the parse cache (clone-on-read). The walker steps over `comment` and `newLine` nodes (real parsed-body citizens; builder has a `case "newLine"` arm at :668).

Known residual widened by S1 (record in the pass header and docs): a block-taking call nested inside an opaque position (e.g. a call-with-block on a short-circuit right side) gets no interior hoisting either. Rare, previously unprotected anyway, tripwire-covered.

- [ ] **Step 1: Failing tests — core.** Create `lib/preprocessors/hoistCalls.test.ts` with `bodyOf` (parses real source via `parseAgency`) and helpers `stmts` (filters `comment`/`newLine`) and `temps`. Tests, exactly as rev 2 specified (shapes are the contract — print one parsed body rather than guessing argument-node forms):

1. argument-position call becomes `const __hoist_0` before the statement (assert `declKind`, `variableName`, inner/outer call names).
2. input not mutated (JSON snapshot before/after).
3. nested calls unroll innermost-first, left to right (`combine(prepare(fetchRaw()), enrich())` → temps `fetchRaw, prepare, enrich`).
4. the statement tail call is not hoisted (`const x = solo(1)` → zero temps).
5. steps over comments between statements.
6. loc copied onto every synthesized statement (line > 0).
7. per-SCOPE numbering: `for (item in getItems()) { total = total + weigh(item, scale()) }` yields `__hoist_0` AND `__hoist_1` (distinct names across the shared frame).
8. seeding skips user `__hoist_0` (next temp is `__hoist_1`).
9. calls inside object literals, arrays, spreads, string interpolation all hoist in order.
10. a temp emitted inside a block body lands in THAT body (comprehension `[scaleBy(perItem(x)) for x in xs]`: zero outer temps, `__hoist_0` present inside the block body — positive assertion on the nested body, not a string search).

- [ ] **Step 2: Run red, implement the core, run green, commit**

```bash
npx vitest run lib/preprocessors/hoistCalls.test.ts > /tmp/hoist-t2a.out 2>&1; tail -5 /tmp/hoist-t2a.out
git add lib/preprocessors/hoistCalls.ts lib/preprocessors/hoistCalls.test.ts
git branch --show-current
git commit -m "preprocessor: hoistCalls core - rulings table, pure extractor, per-scope temp counters"
```

- [ ] **Step 3: Failing tests — control flow and boundaries.** Probes first (do not guess): `pnpm run ast` one-liners for `a() catch b()` and `load(1) |> clean |> summarize` (node type, operator string, input vs stages). Then tests:

1. `if (score(n) > 3)` → temp before the `ifElse` (runtime memoizes `__condbranch_`, runner.ts:885-905, so single evaluation is preserved; the win is the pause-inside-condition case; `else if` conditions stay inline — opaque).
2. `for (item in getItems())` → temp before the loop.
3. while rewrite, no negation (S7):

```
while (COND) { BODY }   ⇒   while (true) { <temps>; if (COND') { BODY' } else { break } }
```

Assert: condition is `{type:"boolean",value:true}`; body starts with the temp; then an `ifElse` whose `thenBody` is the original body and whose `elseBody[0]` is `{...createKeyword("break"), loc}`. (`Runner.whileLoop` awaits the condition BEFORE the completed-iteration skip, runner.ts:1058-1064 — a condition call re-runs once per completed iteration on resume, which is why this position matters most.)
4. call-free while condition untouched.
5. try operand fully opaque (`try parse(fetchBody(url))` → zero temps).
6. short-circuit: left hoists, right untouched (one temp).
7. catch expression fully opaque.
8. pipe: `load(x) |> clean |> summarize` → exactly `["load"]` hoisted.
9. fork comprehension: zero outer temps AND the branch-block body contains the temp (positive nested assertion).
10. handler bodies skipped: handle body hoists (`prep` gets a temp), the `with` body's `annotate` remains a call argument and no `__hoist` name appears in the with-body subtree (walk to the parsed handleBlock node; the shape lookup is a probe, the assertions are fixed).

- [ ] **Step 4: Implement (table rows + dispatch), green, commit**

```bash
npx vitest run lib/preprocessors/hoistCalls.test.ts > /tmp/hoist-t2b.out 2>&1; tail -5 /tmp/hoist-t2b.out
git add lib/preprocessors/hoistCalls.ts lib/preprocessors/hoistCalls.test.ts
git branch --show-current
git commit -m "preprocessor: hoistCalls control flow and rulings - if, for, while via if-else-break, try, catch, pipes, handlers, branches"
```

- [ ] **Step 5: Wire + smoke + commit.** In `preprocess()` between `this.collectSkills();` and `this.addAwaitPendingCalls();`:

```ts
// Hoist helper calls into their own const steps so resume replay never
// re-executes a completed call (frame-queue desync; spec
// docs/superpowers/specs/2026-07-22-hoist-calls-resume-safety-design.md).
// After collectSkills so skill detection sees original call shapes;
// before addAwaitPendingCalls and resolveVariableScopes so the __hoist
// temps get awaits and scopes like hand-written statements.
//
// Accepted behavior change: `for (x in async getItems())` was rejected
// by validateNoAsyncInLoops (async call under the loop node); hoisting
// moves it above the loop, so it now compiles. A relaxation, recorded
// here and in docs/dev/hoist-calls.md.
this.program = hoistCallsInProgram(this.program);
```

Smoke (file must live in the package dir):

```bash
cat > hoist-smoke.agency <<'EOF'
def side(x: number): number {
  return x + 1
}

def wrap(n: number): string {
  return "n=${n}"
}

node main() {
  const both = side(1) > 0 && side(2) > 1
  print(wrap(side(3)))
  return "ok"
}
EOF
pnpm run compile hoist-smoke.agency > /tmp/hoist-t2-compile.out 2>&1; tail -2 /tmp/hoist-t2-compile.out
grep -c "__hoist_" hoist-smoke.js   # expect >= 2
pnpm run agency hoist-smoke.agency > /tmp/hoist-t2-run.out 2>&1; grep "n=4" /tmp/hoist-t2-run.out
rm hoist-smoke.agency hoist-smoke.js
npx vitest run lib/preprocessors > /tmp/hoist-t2-units.out 2>&1; tail -4 /tmp/hoist-t2-units.out
git add lib/preprocessors/typescriptPreprocessor.ts
git branch --show-current
git commit -m "preprocessor: run hoistCalls between collectSkills and addAwaitPendingCalls"
```

(`lib/backends` fixture comparisons now differ — Task 4 regenerates them in their own commit; anything non-fixture that fails gets fixed now.)

---

### Task 3: Execution tests — the proof

**Rebuild first, and after every compiler change in this task:** `make > /tmp/hoist-t3-make.out 2>&1` (agency tests run stdlib compiled by the current compiler).

**Schema:** copy `tests/agency/callback-inprocess-resume-identity.test.json` (interrupt-approve shape: `"interruptHandlers": [{ "action": "approve" }]`, `evaluationCriteria: [{type:"exact"}]`, expectedOutput is the JSON-rendered return, e.g. `"\"cb=1\""`). For mock tool calls: `grep -rl "llmMocks" tests/agency | head -3` and mirror. Probes before writing fixtures: empty if body `if (c) { }` legality; `is number` spelling (#631 tests); `failure(...)` constructor spelling (existing failure-propagation fixture).

Fixtures under `tests/agency/hoist/`, each `main.agency` + `test.json`:

- [ ] **Step 1: Flagship resume regression, two variants + the permanent shape pin (S6).**

Variant `resume-regression-args` (the reported shape — a call in argument position):

```agency
effect std::test::greet { name: string }

def greetTool(name: string): string {
  """Greets a person."""
  return interrupt std::test::greet("Approve greeting?", { name: name })
}

def myOptions(): any {
  return { tools: [greetTool] }
}

node main() {
  const answer = llm("Greet Ada using the tool.", myOptions())
  print(answer)
  return answer
}
```

Variant `resume-regression-spread`: `llm("...", { tools: [...buildTools()] })`. Mock: response 1 calls `greetTool` `{name:"Ada"}`, response 2 is the final answer; responses approve. Resume path note for the fixture comment: the harness resolves the surfaced interrupt with the canned response and resumes through `respondToInterrupts` — the same entry point the interactive CLI (`run -i`) uses, where `bisect-a.agency` reproduced the bug.

**Permanent shape pin (replaces a scripted red run):** add to `hoistCalls.test.ts` a test that reads `tests/agency/hoist/resume-regression-args/main.agency` from disk, runs parse + `hoistCallsInProgram`, and asserts the `llm` statement's options argument is a `__hoist_` temp reference. This pins "the fixture exercises the hoisted shape" forever; a scripted unwire dance proves it once and can misfire.

**One-time manual red check (do once, report in the task log, not scripted):** comment out the wiring line by hand, `make`, run `resume-regression-args`, confirm the output contains `Resume desync` (the Task 1 tripwire converts the old silent desync into the named error — the replayed `myOptions()` claims the owner's queued frame via its own generated preamble). Then `git checkout -- lib/preprocessors/typescriptPreprocessor.ts` and `make` again. Never use `git stash` for this: pushing an unmodified committed file stashes nothing and a later `pop` applies unrelated stash state.

- [ ] **Step 2: Neutrality — pinned order + one-time comparison.** Fixture `eval-order`: helpers `mark(tag, v)` append to a shared list from argument positions, a binary op, both sides of `&&` (left yields 0 so `right` is SKIPPED), a try operand, and an `is`-pattern condition. Expected order `a, b, left, l1, l2, t1, t2, c` with `right` absent. The committed test pins the order for CI; the neutrality EVIDENCE is a one-time comparison run with the pass unwired (same manual procedure as Step 1) showing the identical printed order — record the diff command and empty result in the task log. Add `catch` and `|>` cases if the probes show them expressible with side-effecting helpers.

- [ ] **Step 3: While rewrites at runtime.** `while-rewrite`: `while (count(i) < 3) { i = i + 1 }` → `done 3` (the comparison in the condition is the point). `while-rewrite-break-continue`: a rewritten while whose body has a user `continue` and a user `break`, asserting the final value — two exit paths through one construct.

- [ ] **Step 4: Pause inside a while condition, resumed.** `while-cond-pause`: `while (gate(i) < 2) { i = i + 1 }` with `gate` raising `std::test::tick`; approve responses; expected final value `2`, with a printed marker inside `gate` appearing exactly once per iteration in the output (pins the no-re-run claim — today the condition re-runs once per completed iteration).

- [ ] **Step 5: Pause inside a hoisted temp's own step.** `temp-step-pause`: `llm("Say READY.", needsApproval())` where `needsApproval()` raises the interrupt and returns the options; mock returns a plain answer; approve. Expected: the answer, and `needsApproval`'s printed marker exactly once (the temp's assignment step carries `hasInterrupts` handling — the spec relies on it, this proves it).

- [ ] **Step 6: Failure propagation through a temp.** `failure-through-temp`: `wants(failing())` where `failing()` returns a Failure. FIRST capture today's exact output with the pass unwired (manual procedure), then pin that byte-identical string as expectedOutput. The point is identical behavior, not plausible behavior.

- [ ] **Step 7: FunctionRef round-trips with the chain in the pausing frame.** `roundtrip-tools`: the derivation chain sits in `main`'s own statement so hoisted temps hold the `AgencyFunction`s across the checkpoint:

```agency
node main() {
  const answer = llm("Use the gate, then greet Ada.", { tools: [add.partial(a: 5), hello.rename("greet_tool"), gate] })
  print(answer)
  return answer
}
```

Mock: round 1 calls `gate` (pause with the temps live), approve, round 2 calls `greet_tool` `{name:"Ada"}`, round 3 final answer containing `hello Ada`. Dependency check, not assumption: `gh pr view 653 --repo egonSchiele/agency-lang --json state,mergedAt` — the `registeredName` round-trip must be merged (or this branch rebased onto it); the pass must not reach main ahead of it.

- [ ] **Step 8: Pause inside a loop body, resumed.** `loop-body-pause`: a loop-body statement that hoists a helper AND contains an interrupting call, resumed mid-iteration, asserting the accumulated value (`whileLoop`/`loop` clear `__substep_`/`__condbranch_` per iteration, runner.ts:1075-1082, but never `__hoist_` locals — this pins the interaction).

- [ ] **Step 9: Idempotency unit test** in `hoistCalls.test.ts`: `hoistCallsInScope(hoistCallsInScope(body))` structurally equals `hoistCallsInScope(body)` (house convention: `guardDesugar` header, `typeChecker/index.ts:106`).

- [ ] **Step 10: Run all, commit**

```bash
for d in finalize-no-tripwire resume-regression-args resume-regression-spread eval-order while-rewrite while-rewrite-break-continue while-cond-pause temp-step-pause failure-through-temp roundtrip-tools loop-body-pause; do
  pnpm run agency test tests/agency/hoist/$d > /tmp/hoist-t3-$d.out 2>&1; echo "$d: $?"
done
npx vitest run lib/preprocessors/hoistCalls.test.ts > /tmp/hoist-t3-units.out 2>&1; tail -3 /tmp/hoist-t3-units.out
git add tests/agency/hoist tests/agency-js/hoist-stamp lib/preprocessors/hoistCalls.test.ts
git status --short tests/agency   # nothing silently gitignored (the tools.js trap, PR #651)
git branch --show-current
git commit -m "tests: resume regressions, neutrality, while rewrites, pause-in-temp, failure propagation, roundtrips"
```

---

### Task 4: Fixtures, full unit suite, docs, PR

- [ ] **Step 1: Regenerate fixtures — own commit, and know what green means.** The generator integration test string-compares fixtures to generated output and never executes them (`typescriptGenerator.integration.test.ts:32-75`); after regeneration, green is true by construction. The real gates are Task 3 locally and the CI agency suite. Eyeball three regenerated fixtures (a plain function, a while loop, a tool-call site) for the expected `__hoist_` shapes before committing.

```bash
make fixtures > /tmp/hoist-fixtures.out 2>&1; tail -3 /tmp/hoist-fixtures.out
git add tests/typescriptGenerator
git branch --show-current
git commit -m "fixtures: regenerate for hoistCalls statement shapes (mechanical)"
```

- [ ] **Step 2: Full unit suite** (PR #651 lesson — the whole suite, not the touched files)

```bash
npx vitest run lib > /tmp/hoist-final-units.out 2>&1; tail -6 /tmp/hoist-final-units.out
```

(If stale `worktree-*` repo copies fail under vitest globs, confirm failures are confined to those paths before ignoring.)

- [ ] **Step 3: Docs, commit.** `docs/dev/hoist-calls.md`: the invariant; the rulings table (pointing at the code table as source of truth); temp naming and why seeding alone protects it (no lint rule — S2, with the reserved-prefix consistency argument); the `validateNoAsyncInLoops` relaxation; the S1 residual (block bodies inside opaque positions); the tripwire section including **which sites claim frames and which Runners merely run on someone else's frame (finalize)**, and why the statelog emit survives laundering that a throw does not. `docs/dev/interrupts.md`: one paragraph. Also add the S1 residual sentence to the spec's residuals list (one-line spec edit, same commit).

```bash
git add docs/dev/hoist-calls.md docs/dev/interrupts.md ../../docs/superpowers/specs/2026-07-22-hoist-calls-resume-safety-design.md
git branch --show-current
git commit -m "docs: hoistCalls pass and resume tripwire"
```

- [ ] **Step 4: Anti-pattern audit of the implementation diff** (design-level ones were resolved in planning: walker reuse, rulings-as-data, purity), then PR from a body file covering: the bug, the two halves, the rulings table, residuals + tripwire, the fixture-commit split, the finalize claim/run distinction, the #653 dependency. Ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

```bash
git push -u origin adit/hoist-calls-resume-safety
gh pr create --title "Hoist helper calls into skippable steps so in-process resume cannot desync frames" --body-file /tmp/hoist-pr-body.md
```

---

## Self-review notes

- **Simplifications applied:** S1 → three-value `Ruling`, no `WalkContext`, residual recorded (Task 2 header + Task 4 docs/spec edit); S2 → lint task deleted, seeding named as the protection, consistency argument recorded; S3 → always-stamp/always-serialize, `StateJSON` field required, legacy test replaced by an always-serialized round-trip test, statelog via ALS pattern instead of a parameter (with the laundering rationale written into the claim function's comment), empty-name refusal KEPT as a hand-written-site guard; S5 → five tasks, commit granularity preserved (three commits in Task 2, the fixture-split commit intact); S6 → permanent compiled-shape pin in `hoistCalls.test.ts`, red run demoted to a one-time manual check with the stash prohibition and its reason; S7 already in (if/else-break). Considered-and-rejected items recorded where they bite: the node-call reason for keeping tails unhoisted is in Task 2's interface notes.
- **Everything from the review's earlier sections carries over from rev 2:** claim-site tripwire + finalize fixture + stamp-coverage test; per-scope counters + collision tests; block-boundary rule in the core commit; `make` before execution tests; comparison-in-condition while fixture; `bodyOf` filtering; the `validateNoAsyncInLoops` decision; positive nested-body assertions; fixture-green caveat; `gh pr view 653` check.
- **Interface consistency:** `hoistCallsInScope(body, counter?) → AgencyNode[]`, `hoistCallsInProgram(program) → AgencyProgram`, `claimFrameForScope(frame, scopeName) → void` used identically everywhere they appear.
- **Named unknowns are probes with commands:** argument-node shapes, catch/pipe parsed shapes, empty-if and `is` spellings, `failure(...)` spelling, handleBlock body path, `StateJSON` frame-array access path, the asyncContext import-cycle check in Task 1 Step 4.
