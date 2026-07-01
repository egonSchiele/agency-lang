# Definite-return checking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **SCOPE CHANGE — shipped as a SAFE SUBSET.** Execution surfaced that
> definite-return through a `match` depends on match **exhaustiveness** (a
> `Result` match over success/failure is total and returns; a `number` match over
> `1`/`2` is not) — which lives in `checkMatchExhaustiveness`, not the flow graph,
> and can't be assumed away (turning the last arm into an unconditional `else`
> would make `match (x) { x==1 => …  x==2 => … }` wrongly run arm 2 for `x==1000`).
> So this ships checking only functions that DON'T use a `match` (plain
> `if`/`else`/straight-line), where the flow terminal is authoritative. Any
> match-containing function is skipped (`containsMatch` in `definiteReturns.ts`) →
> zero false positives. Match-aware definite-return (reusing the exhaustiveness
> result) is a deferred follow-up. Consequently Task 1 (matchBlock divergence) was
> NOT shipped; Task 2 (terminal capture) and Task 3 (the check + the match-skip
> guard) are the substance.

**Goal:** A function that declares a (non-void) return type must `return` a value on **every** control-flow path. `def f(x: number): number { if (x > 0) { return 1 } }` — which silently returns `undefined` on the else path today — becomes a compile diagnostic *"not all code paths return a value in 'f'"*. Agency has **no implicit returns**, so falling off the end of a typed function is always a bug.

**Architecture:** The flow graph already computes reachability. `buildFlowGraph(body, start, env)` returns the flow node *at the end of the body*, which is `{ kind: "exit" }` iff every path diverges (a `return` produces `exit`; `mergeFlows` collapses to `exit` when all branches are `exit`). Today `buildFlowGraphs` **discards** that terminal node. This feature (1) captures the per-function terminal node and (2) errors when a typed function's terminal is not `exit`. One prerequisite: the `matchBlock` flow handler currently discards its arms' terminal flows, so a `match` where every arm returns doesn't produce `exit` — Task 1 makes it merge arm flows so `match`-terminated functions are handled correctly.

**Tech Stack:** TypeScript, vitest, the Agency type-checker flow layer (`lib/typeChecker/flowBuilder.ts`, `flow.ts`), `config.ts`.

## Grounding (verified against source)

- `return` → `{ kind: "exit" }` (`flowBuilder.ts:158-160`). `ifElse` merges then/else via `mergeFlows` (`flowBuilder.ts:163-174`), so an if/else where both branches return already yields `exit`.
- `raise`/`interrupt`/`goto` are **passThrough** — they do NOT diverge (`flowBuilder.ts:258`), matching the existing `alwaysExits` convention ("raise/interrupt may resume"). Consequence: a path ending in `raise` with no `return` is treated as able to reach the end → flagged. This is sound (a resumed interrupt continues past the `raise`); see Edge Cases.
- `buildFlowGraph(...)` returns the terminal `FlowNode` and short-circuits on `exit` (`flowBuilder.ts:277-290`); `buildFlowGraphs` throws the return value away (`flowBuilder.ts:302-311`).
- `mergeFlows(flows)` drops `exit` nodes; returns `exit` iff all inputs are `exit` (`flow.ts:280-283`).
- `ScopeInfo` already carries `returnType?: VariableType | null` (`types.ts:49`), set from `def.returnType` in `buildDefScope` (`scopes.ts:79`). Scopes are: one `"top-level"` + one per `def` (function or node). Nested scopes (handler/block bodies) do NOT get their own `ScopeInfo`. A scope is a **function** (not a node) when `info.name !== "top-level"` and `ctx.nodeDefs[info.name]` is absent (mirrors `interruptAnalysis.ts:366`).
- `VOID_T = { primitiveType, value: "void" }`, `NEVER_T = { ... "never" }` (`primitives.ts:7,10`).
- The current `matchBlock` handler (`flowBuilder.ts`) ignores each `buildFlowGraph([c.body], armFlow, env)` result and returns the incoming `flow`.

## Global Constraints

- **Handlers are safety infrastructure.** Type-checker-only. No lowering/codegen/runtime change. `matchBlock` still lowers/codegens identically; only the flow graph consulted during checking gains merged arm terminals.
- **Ships at `warn` for the first release**, then a follow-up flips to `error` once it has baked (the matchExhaustiveness trajectory) — because trailing-`raise` and infinite-loop patterns can trip it. When unsure whether a construct diverges, prefer treating it as diverging (don't flag) — a missed fall-through (false negative) is acceptable; flagging valid code is not.
- **Use objects not maps; arrays not sets; `type` not `interface`. No dynamic imports.**
- **Never commit/push unless asked.** Implement directly (no subagents). Commit messages / PR bodies in a **file** (apostrophes break inline `-m`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Do not run the agency execution suite locally.** typeChecker unit tests + targeted vitest + the fixture/execution *typecheck* scan (Task 4) only.

## Design: what counts as "diverges"

A function's body **definitely returns** iff its terminal flow node is `exit`. Divergence points:
- `return` → `exit` (already).
- `if/else` → `exit` iff both branches `exit` and there is an `else` (already, via `mergeFlows`).
- `match` → `exit` iff **every arm** body `exit`s (Task 1). We **assume totality**: a non-total `match` (missing cases, no `_`) is already the job of `checkMatchExhaustiveness` (now `error` by default, #383), so definite-return does not separately model the "no arm matched" fall-through. This avoids double-diagnosing one root cause and avoids false positives on exhaustive-without-`_` matches. (Under `matchExhaustiveness: "silent"` a non-total match becomes a definite-return false *negative* — acceptable; the user opted out of exhaustiveness.)
- `raise`/`interrupt`/loops/`goto` → do NOT diverge (passThrough / normal loop-exit flow). See Edge Cases.

## Edge Cases (documented, not fixed here)

1. **Trailing `raise`/`interrupt`.** `def f(): number { raise e("m", {}) }` → flagged (raise is passThrough; a resumed interrupt falls off the end). Sound. Workaround: add an explicit `return`, or drop the return type. A future refinement could treat a provably-rejecting raise as diverging.
2. **Infinite loops.** `def f(): number { while (true) { … } }` → the flow model produces the loop-exit (`facts.else`) flow, not `exit`, so it's flagged even though it never returns. Rare; documented limitation. A future refinement could detect `while (true)` with no `break` as `exit`.
3. **Nodes.** `node` scopes are exempt (nodes are graph steps, not value-returning functions), even if a node carries a `returnType`. Functions (`def`) only. (`ctx.nodeDefs` is bare-name-keyed — `index.ts:88` — so `ctx.nodeDefs[info.name]` is the right exemption test.)
4. **`void` / `never` / absent return type.** Exempt. `void`/absent: nothing to return. `never`: means "does not return normally", so the "must return a value" message would be misleading (a `never` function that *does* return a value is caught by return-type checking, not here).

---

### Task 1: Make the `matchBlock` flow handler model arm divergence

**Files:**
- Modify: `lib/typeChecker/flowBuilder.ts`
- Test: `lib/typeChecker/flowBuilder.test.ts` (or a new `matchDivergence.test.ts`)

**Interfaces:**
- Consumes: `mergeFlows` (already exported from `flow.ts`, imported in `flowBuilder.ts:11`).
- Produces: `matchBlock` returns `mergeFlows(armEnds)` instead of the incoming `flow`.

- [ ] **Step 1: Write the failing test — an all-arms-return match yields `exit`**

The observable proxy for "terminal is exit" is Task 3's diagnostic, which doesn't exist yet. So test the flow directly. `buildFlowGraph` is exported (`flowBuilder.ts:277`). **The AST node type for a function is `"function"` (`function.ts:48`), NOT `"functionDefinition"`** — mirror the existing `parseBody` helper in `flowBuilder.test.ts:14-24` (it wraps a snippet in `def __f() { … }` and finds `n.type === "function"`). Add to a new `lib/typeChecker/matchDivergence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildFlowGraph } from "./flowBuilder.js";
import { Scope } from "./scope.js";
import type { FlowEnvironment } from "./flow.js";
import type { AgencyNode } from "../types.js";

// Build the flow graph for a function body (statements wrapped in `def __f`) and
// return its terminal node kind. Mirrors flowBuilder.test.ts's parseBody helper.
function terminalKind(body: string): string {
  const r = parseAgency(`def __f() {\n${body}\n}`);
  if (!r.success) throw new Error("parse failed");
  const fn = r.result.nodes.find((n) => n.type === "function") as
    | (AgencyNode & { body: AgencyNode[] })
    | undefined;
  if (!fn) throw new Error("no function found");
  const scope = new Scope("test");
  const env: FlowEnvironment = {
    scope,
    flowOf: new WeakMap(),
    typeAliases: {},
    memo: new WeakMap(),
  };
  return buildFlowGraph(fn.body, { kind: "start", scope }, env).kind;
}

describe("matchBlock flow divergence", () => {
  it("a match where every arm returns diverges (terminal = exit)", () => {
    expect(terminalKind(`match (x) { "a" => return 1  _ => return 0 }`)).toBe("exit");
  });

  it("a match where an arm falls through does NOT diverge", () => {
    expect(terminalKind(`match (x) { "a" => return 1  _ => 0 }`)).not.toBe("exit");
  });
});
```

- [ ] **Step 2: Run — expect the first test to FAIL**

Run: `pnpm exec vitest run lib/typeChecker/matchDivergence.test.ts 2>&1 | tee /tmp/dr-t1-before.txt`
Expected: "every arm returns diverges" FAILS (today `matchBlock` returns the incoming non-exit `flow`). If parsing the bare `match` body shape fails, adjust the harness to locate the function via the compiled AST (`buildCompilationUnit`), but keep asserting the terminal kind.

- [ ] **Step 3: Merge arm terminal flows in the `matchBlock` handler**

In `flowBuilder.ts`, change the handler to collect each arm's terminal flow and return their merge. Replace the loop tail + `return flow`:

```ts
  matchBlock: (node, flow, env) => {
    attachExpressionsToFlow(node.expression as AgencyNode, flow, env);
    const scrutinee = node.expression as Expression;
    const armEnds: FlowNode[] = [];
    for (const c of node.cases) {
      if (c.type === "comment" || c.type === "newLine") continue;
      let armFlow = flow;
      if (c.caseValue !== "_" && c.guard === undefined) {
        const cond: Expression = {
          type: "binOpExpression",
          operator: "==",
          left: scrutinee,
          right: c.caseValue as Expression,
        };
        armFlow = wrapFacts(flow, analyzeCondition(cond).then);
      }
      armEnds.push(buildFlowGraph([c.body], armFlow, env));
    }
    // Assume the match is total (a non-total match is checkMatchExhaustiveness's
    // job, error by default). So the post-match flow is the merge of the arm
    // terminals: if every arm diverges (`return`s), the merge is `exit`. An
    // empty match (no arms) can't diverge → fall back to the incoming flow.
    return armEnds.length > 0 ? mergeFlows(armEnds) : flow;
  },
```

Update the handler's doc comment: its current final sentence — *"Post-match flow is unchanged."* — is now factually wrong and must be **replaced** (not tweaked) with a sentence stating the post-match flow is the merge of the arms' terminal flows (so an all-arms-return match yields `exit`).

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm exec vitest run lib/typeChecker/matchDivergence.test.ts 2>&1 | tee /tmp/dr-t1-after.txt`
Expected: both PASS.

- [ ] **Step 5: Narrowing-regression gate, then the full suite**

Changing the post-match flow from "incoming" to "merge of arm ends" affects narrowing *after* a match — the plan's largest risk. Run the narrowing-sensitive files FIRST so any regression lands in an easy-to-isolate place:
Run: `pnpm exec vitest run lib/typeChecker/matchArmNarrowing.test.ts lib/typeChecker/flowNarrowing.test.ts lib/typeChecker/narrowing.test.ts lib/typeChecker/matchExhaustiveness.test.ts 2>&1 | tee /tmp/dr-t1-narrowing.txt`
Then the full suite:
Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/dr-t1-unit.txt`
Expected: PASS. Any new failure is a narrowing/flow test observing the old "post-match flow unchanged" behavior. Inspect each: if the new behavior is more precise (it should be), update the test; **if any failure indicates a genuine soundness regression (a narrowing that is now wrong), STOP and reassess** — the merge must never produce an unsound post-match type. If none of the existing files exercise a *post-match* read (a narrowed variable used AFTER the match), add one positive assertion here that it still resolves correctly. Record the verdict in `/tmp/dr-t1-unit.txt`.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/flowBuilder.ts lib/typeChecker/matchDivergence.test.ts
git commit -F /tmp/dr-t1-msg.txt
```
`/tmp/dr-t1-msg.txt`:
```
feat(typechecker): model match-arm divergence in the flow graph

The matchBlock flow handler now returns the merge of its arms' terminal flows
(mergeFlows) instead of the incoming flow, so a `match` where every arm returns
yields an `exit` node. Assumes totality (a non-total match is checkMatchExhaustiveness's
job). Enables definite-return checking through match; also sharpens post-match
narrowing. Flow-layer only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 2: Capture per-function terminal flow nodes

**Files:**
- Modify: `lib/typeChecker/flowBuilder.ts`, `lib/typeChecker/flow.ts` (the `FlowEnvironment` type)

**Interfaces:**
- Produces: `ctx.flowEnv.scopeTerminals: Record<string, FlowNode>` — maps `scopeKey` → the flow node at the end of that scope's body.

- [ ] **Step 1: Extend `FlowEnvironment` with a terminals map**

In `flow.ts`, add to the `FlowEnvironment` type: `scopeTerminals?: Record<string, FlowNode>;` (optional — existing constructors/tests that build a bare env don't need it). Document it: "the end-of-body flow node per scopeKey; consumed by definite-return checking. `exit` means every path diverges."

- [ ] **Step 2: Populate it in `buildFlowGraphs`**

In `flowBuilder.ts` `buildFlowGraphs`, capture each scope's terminal (currently discarded):

```ts
export function buildFlowGraphs(scopes: ScopeInfo[], ctx: TypeCheckerContext): void {
  const flowOf: WeakMap<AgencyNode, FlowNode> = new WeakMap();
  const memo: WeakMap<FlowNode, Record<string, ScopeType>> = new WeakMap();
  const typeAliases = ctx.getTypeAliases();
  const scopeTerminals: Record<string, FlowNode> = {};
  for (const info of scopes) {
    const env: FlowEnvironment = { scope: info.scope, flowOf, typeAliases, memo };
    scopeTerminals[info.scopeKey] = buildFlowGraph(
      info.body,
      { kind: "start", scope: info.scope },
      env,
    );
  }
  const rootScope = scopes[0]?.scope ?? new Scope("global");
  ctx.flowEnv = { scope: rootScope, flowOf, typeAliases, memo, scopeTerminals };
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm exec vitest run lib/typeChecker/flowBuilder.test.ts lib/typeChecker/matchDivergence.test.ts 2>&1 | tee /tmp/dr-t2.txt`
Expected: PASS (purely additive — a new field, no behavior change).

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/flow.ts lib/typeChecker/flowBuilder.ts
git commit -F /tmp/dr-t2-msg.txt
```
`/tmp/dr-t2-msg.txt`:
```
feat(typechecker): record per-scope terminal flow nodes

buildFlowGraphs now stores the end-of-body flow node per scopeKey on
ctx.flowEnv.scopeTerminals (previously discarded), for definite-return checking.
`exit` = every path through that scope diverges.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 3: The definite-return check + config gate

**Files:**
- Create: `lib/typeChecker/definiteReturns.ts`
- Modify: `lib/typeChecker/index.ts` (register the pass), `lib/config.ts` (the knob)
- Test: `lib/typeChecker/definiteReturns.test.ts`

**Interfaces:**
- Produces: `export function checkDefiniteReturns(scopes: ScopeInfo[], ctx: TypeCheckerContext): void`.
- Consumes: `ctx.flowEnv.scopeTerminals` (Task 2), `ScopeInfo.returnType`, `VOID_T`.

- [ ] **Step 1: Write the failing tests**

Create `lib/typeChecker/definiteReturns.test.ts`. `typecheckSource` hardcodes an empty config, so add a small config-passing harness (copy its temp-file plumbing but forward `config` to `typeCheck`) to test the knob. Anchor the `misses` regex to the EXACT emitted message so an unrelated diagnostic can't match:

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";
import type { TypeCheckError } from "./types.js";

function check(src: string, config: AgencyConfig = {}): TypeCheckError[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-dr-"));
  try {
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, src);
    const parsed = parseAgency(src);
    if (!parsed.success) throw new Error("parse failed");
    const symbols = SymbolTable.build(file);
    const info = buildCompilationUnit(parsed.result, symbols, file, src);
    return typeCheck(parsed.result, config, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DR = /^Not all code paths return a value in '/;
const drDiags = (src: string, config: AgencyConfig = {}) =>
  check(src, config).filter((e) => DR.test(e.message));
const misses = (src: string, config: AgencyConfig = {}) => drDiags(src, config).length > 0;

describe("definite-return checking", () => {
  it("flags a typed function that misses the else path", () => {
    expect(misses(`def f(x: number): number { if (x > 0) { return 1 } }`)).toBe(true);
  });

  it("flags a straight-line body with no return", () => {
    expect(misses(`def f(): number { let x = 1 }`)).toBe(true);
  });

  it("accepts if/else where both branches return", () => {
    expect(misses(`def f(x: number): number { if (x > 0) { return 1 } else { return 0 } }`)).toBe(false);
  });

  it("accepts a straight-line return", () => {
    expect(misses(`def f(): number { return 1 }`)).toBe(false);
  });

  it("accepts nested if/else where every leaf returns", () => {
    expect(
      misses(`def f(a: bool, b: bool): number {
  if (a) { if (b) { return 1 } else { return 2 } } else { return 3 }
}`),
    ).toBe(false);
  });

  it("accepts a total match where every arm returns", () => {
    expect(misses(`def f(x: string): number { match (x) { "a" => return 1  _ => return 0 } }`)).toBe(false);
  });

  it("flags a match arm that falls through", () => {
    expect(misses(`def f(x: string): number { match (x) { "a" => return 1  _ => 0 } }`)).toBe(true);
  });

  it("exempts a function with no declared return type", () => {
    expect(misses(`def f(x: number) { if (x > 0) { return 1 } }`)).toBe(false);
  });

  it("exempts a void return type", () => {
    expect(misses(`def f(x: number): void { if (x > 0) { return } }`)).toBe(false);
  });

  it("exempts a never return type", () => {
    // `never` means "does not return normally"; not this check's concern.
    expect(misses(`effect e::x { }\ndef f(): never { raise e::x("m", {}) }`)).toBe(false);
  });

  it("exempts nodes", () => {
    expect(misses(`node main() { let x = 1 }`)).toBe(false);
  });

  it("flags a trailing raise with no return (documented: raise may resume)", () => {
    expect(misses(`effect e::x { }\ndef f(): number { raise e::x("m", {}) }`)).toBe(true);
  });

  it("checks each function independently (both offenders reported)", () => {
    const src = `def f(x: number): number { if (x > 0) { return 1 } }
def g(x: number): number { if (x > 0) { return 2 } }`;
    expect(drDiags(src).length).toBe(2);
  });

  // --- documented limitations, pinned ---
  it("LIMITATION: an infinite loop is flagged (flow model has no exit for while(true))", () => {
    expect(misses(`def f(): number { while (true) { let x = 1 } }`)).toBe(true);
  });

  it("LIMITATION: a total match with no `_` still returns exit (assume-totality)", () => {
    // All literal arms return; no `_`. Under assume-totality this is accepted.
    expect(misses(`def f(x: bool): number { match (x) { true => return 1  false => return 0 } }`)).toBe(false);
  });

  // --- config knob ---
  it("silent suppresses the diagnostic", () => {
    expect(misses(`def f(): number { let x = 1 }`, { typechecker: { definiteReturns: "silent" } })).toBe(false);
  });

  it("warn demotes to a warning", () => {
    const d = drDiags(`def f(): number { let x = 1 }`, { typechecker: { definiteReturns: "warn" } });
    expect(d.length).toBe(1);
    expect(d[0].severity).toBe("warning");
  });

  it("error emits a hard error", () => {
    const d = drDiags(`def f(): number { let x = 1 }`, { typechecker: { definiteReturns: "error" } });
    expect(d.length).toBe(1);
    expect(d[0].severity ?? "error").toBe("error");
  });
});
```

(If `bool`/`while (true)`/the exact effect syntax differs, confirm with `pnpm run ast` and adjust — the assertions are what matter.)

- [ ] **Step 2: Run — expect the "flags" tests to FAIL (check not wired)**

Run: `pnpm exec vitest run lib/typeChecker/definiteReturns.test.ts 2>&1 | tee /tmp/dr-t3-before.txt`
Expected: the `.toBe(true)` cases FAIL (no diagnostic yet).

- [ ] **Step 3: Implement the check**

Create `lib/typeChecker/definiteReturns.ts`:

```ts
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { VariableType } from "../types.js";

type Severity = "silent" | "warn" | "error";

/** A declared return type that requires a value on every path. Exempt: absent/
 *  `null` (nothing declared), `void` (nothing to return), and `never` (means
 *  "does not return normally" — the message would be misleading, and a `never`
 *  function returning a value is a separate return-type-mismatch check's job).
 *  Every other declared type — including `any` — must be reached only by
 *  diverging paths. */
function requiresReturn(rt: VariableType | null | undefined): boolean {
  if (!rt) return false;
  if (rt.type === "primitiveType" && (rt.value === "void" || rt.value === "never")) return false;
  return true;
}

/**
 * Diagnostic: a function that declares a non-void return type but whose body can
 * reach its end without `return`ing. Uses the flow graph's terminal node
 * (`ctx.flowEnv.scopeTerminals`): `exit` means every path diverges. Nodes and
 * the top-level scope are exempt (not value-returning functions). Config-gated
 * via `typechecker.definiteReturns`.
 */
export function checkDefiniteReturns(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  // Ships at "warn" for the first release (trailing-raise and infinite-loop
  // patterns can trip it — see Edge Cases); flip to "error" in a follow-up once
  // it has baked, mirroring the matchExhaustiveness trajectory.
  const severity = (ctx.config.typechecker?.definiteReturns ?? "warn") as Severity;
  if (severity === "silent") return;
  const terminals = ctx.flowEnv?.scopeTerminals;
  if (!terminals) return;

  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    if (ctx.nodeDefs[info.name]) continue; // nodes are exempt (bare-keyed — index.ts:88)
    if (!requiresReturn(info.returnType)) continue;
    const terminal = terminals[info.scopeKey];
    if (terminal && terminal.kind !== "exit") {
      ctx.errors.push({
        message: `Not all code paths return a value in '${info.name}'.`,
        severity: severity === "warn" ? "warning" : "error",
        // Point at the signature, not the first statement in the body.
        loc: ctx.functionDefs[info.name]?.loc,
      });
    }
  }
}
```

- [ ] **Step 4: Add the config knob**

In `lib/config.ts`: add `definiteReturns?: "silent" | "warn" | "error";` next to `matchExhaustiveness` in the `typechecker` interface (~line 221), and `definiteReturns: z.enum(["silent", "warn", "error"]),` to the zod object (~line 449).

- [ ] **Step 5: Register the pass in the pipeline**

In `lib/typeChecker/index.ts`, after `checkMatchExhaustiveness(scopes, ctx)` (step 6e), add:
```ts
    import { checkDefiniteReturns } from "./definiteReturns.js"; // (add to imports at top)
    // 6f. Definite-return: a typed function must return on every path.
    checkDefiniteReturns(scopes, ctx);
```
(Order after exhaustiveness so, when both fire on the same non-total match, exhaustiveness's message is the primary one; definite-return relies on Task-1 terminals which are built at buildFlowGraphs time regardless.)

- [ ] **Step 6: Run the definite-return tests**

Run: `pnpm exec vitest run lib/typeChecker/definiteReturns.test.ts 2>&1 | tee /tmp/dr-t3-after.txt`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/typeChecker/definiteReturns.ts lib/typeChecker/definiteReturns.test.ts lib/typeChecker/index.ts lib/config.ts
git commit -F /tmp/dr-t3-msg.txt
```
`/tmp/dr-t3-msg.txt`:
```
feat(typechecker): definite-return checking

A function declaring a non-void return type must `return` on every path, else
"Not all code paths return a value in 'f'." Reads the flow graph's per-scope
terminal node (exit = every path diverges). Nodes / void / untyped functions are
exempt. Config-gated via typechecker.definiteReturns (silent/warn/error).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 4: Measure blast radius, choose the default, docs, gate

**Files:**
- Modify: `docs/misc/config.md`, `docs/site/guide/basic-syntax.md` (or wherever functions/returns are documented), `lib/typeChecker/definiteReturns.ts` (default, if the sweep says `warn`).

- [ ] **Step 1: Measure — full typeChecker suite + fixtures**

Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/dr-sweep-unit.txt`
Run: `pnpm exec vitest run lib/typeChecker/fixtureTypeCheck.integration.test.ts 2>&1 | tee /tmp/dr-sweep-fixtures.txt`
Record failures. Unit-test failures that are functions genuinely missing a return in test fixtures are real finds (fix them). Note the count.

- [ ] **Step 2: Measure — execution-test `.agency` programs**

The fixture integration test covers only `tests/typescriptGenerator` + `stdlib`, NOT `tests/agency*`/`tests/integration` (which CI compiles). Scan them for the new diagnostic (typecheck only — no execution), at the `error` level so nothing is missed. Create a scratch test `__dr_scan.test.ts` at the package root (so vitest's `tests`-dir exclude doesn't skip it), modeled on the flip sweep (which discovered `discoverAgencyFiles` returns `{ name, filePath }`). It must:
- walk `["tests/agency", "tests/agency-js", "tests/integration"]` (resolved from cwd, existence-filtered);
- for each file: parse; if `parse.success === false` **`console.error` the file and count it** (don't silently skip — a "0 hits" verdict must not hide crashes); else `SymbolTable.build` → `buildCompilationUnit` → `typeCheck(parsed.result, { typechecker: { definiteReturns: "error" } }, info)` inside a try/catch that **`console.error`s the file on throw** and counts it;
- collect messages matching the EXACT regex `/^Not all code paths return a value in '/` (same as the Task-3 helper — keep them in sync);
- `console.error` the hit list + `scanned/parseFail/threw/hits` counts; `expect(scanned).toBeGreaterThan(0)`.

**Scratch-file discipline:** after running, `rm` the file, then `git status --short` and confirm it is gone before any commit (do NOT let `__dr_scan.test.ts` land in the tree).

- [ ] **Step 3: Confirm the warn-first default**

The check **ships at `warn`** (`?? "warn"`, Task 3) — a first release, because trailing-`raise` and infinite-loop patterns can trip it. The sweep's job here is two-fold: (a) confirm 0 crashes (parseFail/threw are all pre-existing/unrelated), and (b) surface genuine missing-return bugs to fix in Step 4. Record in `/tmp/dr-verdict.md`: the hit count, how many are genuine bugs vs documented-limitation false positives (trailing-raise/infinite-loop), and a recommendation on the eventual `warn → error` flip (a separate follow-up PR, once it has baked — same trajectory as matchExhaustiveness). Do NOT flip to `error` in this PR.

- [ ] **Step 4: Fix any genuine offenders**

For each real "missing return" the sweep found in stdlib/fixtures/execution programs, add the missing `return` (or correct the return type). These are real latent bugs. Do NOT silence them by weakening the check.

- [ ] **Step 5: Docs**

- `docs/misc/config.md`: add a `definiteReturns` entry mirroring `matchExhaustiveness` (`"silent" | "warn" | "error"`, **default `"warn"`**; explain it flags a typed function that can reach its end without returning; note the raise/infinite-loop edge cases and that a future release will flip the default to `"error"`).
- Function docs (e.g. `docs/site/guide/basic-syntax.md`): one line that a function with a return type must `return` on every path (no implicit returns).

- [ ] **Step 6: Structural lint + full suite (final gate)**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/dr-lint.txt`
Run: `pnpm exec vitest run lib/typeChecker 2>&1 | tee /tmp/dr-final-unit.txt`
Expected: clean / PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -F /tmp/dr-t4-msg.txt
```
`/tmp/dr-t4-msg.txt`:
```
test(typechecker): definite-return sweep, default, docs

Measured blast radius across stdlib/fixtures + execution-test programs; <fixed N
genuine missing-return bugs / none found>. Ships at "warn" (follow-up flips to
"error" after baking). Documented the knob and the no-implicit-returns rule.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Self-Review

**Spec coverage:** the goal (typed function must return on every path) → Task 3's check, fed by Task 2's terminals, made correct for `match` by Task 1. Config gate + measured default → Task 4. Edge cases (raise, infinite loop, nodes, void) enumerated and handled (flag / exempt) with tests for the load-bearing ones.

**Placeholder scan:** every code step shows real code; run steps have exact commands + expected results. Task 4 Step 2's scratch scan is described precisely (dirs, discovery fn shape, match regex) rather than hand-waved because it mirrors the just-completed flip sweep; the executor writes ~30 lines from that spec.

**Type consistency:** `checkDefiniteReturns(scopes: ScopeInfo[], ctx)` matches the other pass signatures. `ctx.flowEnv.scopeTerminals: Record<string, FlowNode>` is produced in Task 2 and consumed in Task 3 with that exact type. `requiresReturn(rt: VariableType | null | undefined): boolean`. Severity handling (`warn` → `"warning"`, else `"error"`) mirrors `matchExhaustiveness.ts:200`.

**Risk:** the one real risk is Task 1 — changing post-match flow from "incoming" to "merge of arm ends" could shift narrowing after a `match`. Task 1 Step 5 is the heavy gate with an explicit STOP-if-unsound instruction. It should be a strict improvement (more precise), but it must be verified against the full suite. Everything downstream is additive.
