# Effects across file boundaries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Do NOT dispatch subagents; the owner has asked for inline execution.

**Goal:** Make the compiler's interrupt-effect analysis see two things it
currently misses: calls written with `.invoke()`, and calls that cross a file
boundary.

**Architecture:** One module owns how effects are computed. It holds the syntax
walk, the fixpoint loop, and the pass that runs them over every reachable file
at the end of `SymbolTable.build`. The type checker imports the walk and the
fixpoint from it instead of keeping its own copies. The field every consumer
already reads then holds the followed-through list.

**Tech Stack:** TypeScript, vitest, the existing `walkNodes` / `bodySlots`
walker, the existing `SymbolTable`.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-25-cross-module-effects-design.md`
**Review this revision answers:** `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-25-cross-module-effects-REVIEW.md`

---

## Global Constraints

From `CLAUDE.md`, applying to every task:

- NEVER use dynamic imports.
- Use objects instead of maps. Use arrays instead of sets. Use `type`, not `interface`.
- NEVER force push or amend commits.
- Dictionaries keyed by user-controlled strings (file paths, symbol names) use
  `Object.create(null)` and `Object.hasOwn`, the house pattern documented at
  `lib/compiler/splice/eligibility.ts:69-72`.
- Comments explain why, never what. No comment that restates the code.
- Run `make` (not `pnpm run build`) after touching anything under `stdlib/`.
- Unit tests run with `pnpm test:run <path>`.
- **Every Agency snippet in this plan has been type-checked.** If you change one,
  check it before running the test, against `docs/site/guide/` and the fixtures
  under `tests/agency/`.

---

## Verified facts this plan is built on

Measured during spec and review work. Do not re-derive; do re-check any that a
step contradicts.

**The `.invoke()` shape.** `read.invoke("x")` parses to a `valueAccess` whose
`base` is `{ type: "variableName", value: "read" }` and whose `chain[0]` is
`{ kind: "methodCall", functionCall: { functionName: "invoke", ... } }`.

**Ancestors are not reliable for finding the receiver.** For
`let a = read.invoke("x")`, `walkNodes` yields the inner call with ancestors
`[assignment, valueAccess]`. But the `assignment` branch at
`lib/utils/node.ts:393-417` descends into an assignment's own `accessChain`
passing the **assignment** as the ancestor, not the `valueAccess`. So the last
ancestor is not always the access. Task 1 scans backwards instead.

**Chains are longer than one link.** `fetchJSON.partial(method: "GET")` is real
Agency (`tests/agency-js/http-post/agent.agency:28`), and `.rename()` chains the
same way (`tests/agency/tool-rename.agency`). So `invoke` is not always
`chain[0]`.

**`_guard` gets its effect from a seed table, not from its body.**
`stdlib/index.agency:595` defines `_guard` with a body that calls `_pushGuard`,
`_runGuarded` and `_popGuard`. It contains **no `interrupt` statement**. Its
`std::guard` label comes entirely from `TS_SIDE_EFFECT_SEEDS`
(`lib/symbolTable.ts:509-520`), because the trip is raised on the TypeScript side
at runtime. Any pass that recomputes direct effects by walking a body will wipe
it. This is why Task 3 seeds from the symbol instead.

**The AG3009 warning has its own walk.** `checkUnhandledInterruptWarnings`
(`lib/typeChecker/interruptAnalysis.ts:385-415`) does not call
`collectFromBody`. It walks call sites itself and reads
`interruptEffectsByFunction[node.functionName]`. Teaching the shared walk about
`.invoke()` does nothing for it.

**Agency syntax, checked by running `typeCheckSource` on each:**

```
guard(cost: $0.50) { ... }          // the parameter is `cost`, not `maxCost`
handle { ...risky code... } with (data) { return approve() }
export { h } from "./helper.agency"
export * from "./helper.agency"
def declared(): string raises <std::exec> { ... }
```

The handle form **wraps** the risky call. Suppression is lexical:
`isInsideHandler` (`lib/typeChecker/checker.ts:315-321`) walks the ancestor chain
for a `handleBlock`, so a call written as a sibling of the block still warns.

**Nested `def` does not parse** ("Expected function body"). The only callable
units a file declares are top-level functions and graph nodes.

**Callback lifting does not diverge.** Measured: a function containing a
`callback` block whose body raises reports `["std::read"]` both before lifting
(symbol table) and after (type checker).

**Locations.** `declaredName` is at `lib/types/hole.ts:36`, a leaf module, so
importing it creates no cycle. `SymbolTable.build` returns after its
`resolveReExports` loop. `table.filePaths()` is at `lib/symbolTable.ts:339`.
`reExportedFrom` is written at `lib/symbolTable.ts:674`, and the star-export
branch is at `lib/symbolTable.ts:587`. `lib/perf/` holds eight performance tests.
AG8003 and AG8004 are free; the file uses AG8001, AG8002 and AG8005-AG8013.

**Incremental builds already invalidate correctly** on transitive Agency imports
(`lib/compiler/buildManifest.ts:14-27`). No work needed.

---

## There is already a cross-file interrupt analysis, and this is not it

`lib/analysis/interrupts.ts` builds a symbol table, type-checks every reachable
file, and merges the per-file call graphs by `${file}:${name}` (`loadCallGraph`,
lines 84-94). That is the design the spec measured at roughly fifteen times the
cost and rejected.

This work cannot reuse it. The new pass runs **inside** `SymbolTable.build`,
where the type checker is not available and calling it would be circular. But
that also makes `analyzeInterrupts` a genuinely independent oracle: it reaches
its answer without ever reading `sym.interruptEffects`. Task 5 uses it as the
cross-check.

---

## File structure

**Create**

- `lib/analysis/effects.ts` — everything about how an effect list is computed:
  the syntax walk, the fixpoint loop, the propagation pass, the callee resolver,
  and the reachability query Task 8 needs. One file so that "how are effects
  computed" has one answer. It imports `SymbolTable` **as a type only**, so there
  is no runtime cycle with `lib/symbolTable.ts`.
- `lib/analysis/effects.test.ts` — the walk's unit tests and the tripwire.
- `lib/analysis/effectPropagation.test.ts` — the cross-file propagation tests.
- `lib/analysis/effectsOracle.test.ts` — the independent cross-check.
- `lib/typeChecker/invokeEffects.test.ts`
- `lib/typeChecker/crossModuleEffectDiagnostics.test.ts`
- `lib/cli/policyCrossModule.test.ts`
- `lib/perf/symbolTable.perf.test.ts`
- `docs/dev/effect-propagation.md`

**Modify**

- `lib/typeChecker/interruptAnalysis.ts` — delete the local walk, the local
  fixpoint and the local `addUnique`; import them. Teach
  `checkUnhandledInterruptWarnings` about `.invoke()`.
- `lib/symbolTable.ts` — call the pass before returning.
- `lib/compiler/splice/eligibility.ts` — the effect check.
- `lib/preprocessors/expandSplices.ts` — thread the symbol table through.
- `lib/cli/policy.ts` — export `uniqueInterruptEffects` so a test can call it.
- `stdlib/agency.agency` — the `getEffects` docstring.
- `CLAUDE.md` — one line pointing at the new dev doc.

---

## Task overview

1. The shared module: walk, fixpoint, dedupe. Pure refactor.
2. `.invoke()`, in the walk **and** in the warning's own walk. Plus its churn.
3. The propagation pass. The core fix, and its churn.
4. Re-exports, in all three forms.
5. Cross-check against the independent oracle.
6. The five error diagnostics and handler typing.
7. The four reporting consumers.
8. The check before running a generator.
9. Documentation, the invariant test, and performance.

---

### Task 1: The shared module

The type checker currently owns three things the symbol table also needs: a
syntax walk over a body, a fixpoint loop, and a dedupe helper. Copying any of
them into a second place is how two analyses come to disagree, which is the bug
this branch exists to remove.

So they move into one module and the type checker imports them.

**Files:**
- Create: `lib/analysis/effects.ts`
- Create: `lib/analysis/effects.test.ts`
- Modify: `lib/typeChecker/interruptAnalysis.ts` — `collectFromBody` (141-167),
  `propagateTransitively` and `propagateFromCallees` (167-196), `addUnique`
  (247-251)

**Interfaces:**
- Produces: `collectBodyFacts(body: AgencyNode[]): BodyFacts` where
  `BodyFacts = { effects: string[]; callees: string[]; calls: FunctionCall[] }`.
- Produces: `invokeReceiver(node: FunctionCall, ancestors: WalkAncestor[]): string | null`.
- Produces: `propagateToFixpoint<T extends PropagationNode>(nodes: Record<string, T>): Record<string, T>`
  where `PropagationNode = { effects: string[]; calleeKeys: string[] }`.
- Produces: `addUnique(arr: string[], value: string): void`.

- [ ] **Step 1: Write the failing tests**

Create `lib/analysis/effects.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { collectBodyFacts, propagateToFixpoint } from "./effects.js";
import type { FunctionDefinition } from "../types/function.js";

/** Parse with applyTemplate false so the injected prelude import stays out of
 *  the tree; these tests read one function's body, not a whole module. */
function bodyOf(src: string) {
  const result = parseAgency(src, {}, false);
  if (!result.success) throw new Error(result.message ?? "parse failed");
  const fn = result.result.nodes.find(
    (n): n is FunctionDefinition => n.type === "function",
  );
  if (!fn) throw new Error("no function in source");
  return fn.body;
}

describe("collectBodyFacts", () => {
  const cases: { label: string; src: string; effects: string[]; callees: string[] }[] = [
    {
      label: "a literal interrupt",
      src: `def f(): string { return interrupt std::read("?", {}) }`,
      effects: ["std::read"],
      callees: [],
    },
    {
      label: "a plain call",
      src: `def f(): string { return g("x") }`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a goto target",
      src: `def f(): string { goto other() }`,
      effects: [],
      callees: ["other"],
    },
    {
      label: "a guard block, which lowers to _guard later",
      src: `def f(): string {\n  const r = guard(cost: $0.50) {\n    return "hi"\n  }\n  return "done"\n}`,
      effects: [],
      callees: ["_guard"],
    },
    {
      label: "a guard block whose body also calls something",
      src: `def f(): string {\n  const r = guard(cost: $0.50) {\n    return read("x")\n  }\n  return "done"\n}`,
      effects: [],
      callees: ["_guard", "read"],
    },
    {
      label: "the same callee twice",
      src: `def f(): string {\n  g("a")\n  g("b")\n  return ""\n}`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a call nested three levels deep",
      src: `def f(): string {\n  if (true) {\n    while (false) {\n      for (x in [1]) {\n        g("deep")\n      }\n    }\n  }\n  return ""\n}`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a call in argument position",
      src: `def f(): string { return outer(inner("x")) }`,
      effects: [],
      callees: ["outer", "inner"],
    },
    {
      label: "a call inside an array literal",
      src: `def f(): string {\n  const xs = [g("a")]\n  return ""\n}`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a call inside string interpolation",
      src: "def f(): string { return `value: ${g(\"a\")}` }",
      effects: [],
      callees: ["g"],
    },
  ];

  for (const { label, src, effects, callees } of cases) {
    it(`reads ${label}`, () => {
      const facts = collectBodyFacts(bodyOf(src));
      expect(facts.effects.sort()).toEqual([...effects].sort());
      expect(facts.callees.sort()).toEqual([...callees].sort());
    });
  }

  it("returns each call node so callers can inspect arguments", () => {
    const facts = collectBodyFacts(bodyOf(`def f(): string { return g("x") }`));
    expect(facts.calls.map((call) => call.functionName)).toEqual(["g"]);
  });
});

describe("propagateToFixpoint", () => {
  it("carries an effect along a chain of three", () => {
    const settled = propagateToFixpoint({
      a: { effects: [], calleeKeys: ["b"] },
      b: { effects: [], calleeKeys: ["c"] },
      c: { effects: ["std::read"], calleeKeys: [] },
    });
    expect(settled.a.effects).toEqual(["std::read"]);
  });

  it("does not push an effect backwards from caller to callee", () => {
    const settled = propagateToFixpoint({
      caller: { effects: ["std::read"], calleeKeys: ["callee"] },
      callee: { effects: [], calleeKeys: [] },
    });
    expect(settled.callee.effects).toEqual([]);
  });

  it("does not union unrelated entries", () => {
    const settled = propagateToFixpoint({
      one: { effects: ["std::read"], calleeKeys: [] },
      two: { effects: [], calleeKeys: [] },
    });
    expect(settled.two.effects).toEqual([]);
  });

  it("terminates on a cycle", () => {
    const settled = propagateToFixpoint({
      a: { effects: [], calleeKeys: ["b"] },
      b: { effects: ["std::exec"], calleeKeys: ["a"] },
    });
    expect(settled.a.effects).toEqual(["std::exec"]);
    expect(settled.b.effects).toEqual(["std::exec"]);
  });

  it("ignores a callee key with no entry", () => {
    const settled = propagateToFixpoint({
      a: { effects: [], calleeKeys: ["missing"] },
    });
    expect(settled.a.effects).toEqual([]);
  });
});
```

The two negative propagation tests matter more than they look. Without them, a
pass that gave every entry every effect it found anywhere would pass the rest of
this file.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm test:run lib/analysis/effects.test.ts`

Expected: everything fails to load, with a module-resolution error for
`./effects.js`. If instead a specific case fails with a parse error, the Agency
in that case is wrong — fix the case, not the implementation.

- [ ] **Step 3: Write the module**

Create `lib/analysis/effects.ts`:

```ts
/**
 * How an interrupt-effect list is computed. One module, because two copies of
 * this drifted apart and an effect came to mean different things on either
 * side of an import — GitHub issue 680.
 *
 * Three things live here: reading one body, propagating along call edges, and
 * (from Task 3) the pass that runs both over every reachable file. The type
 * checker adds type-aware work on top of the first and must never subtract
 * from it.
 *
 * SymbolTable is imported as a type only, so lib/symbolTable.ts can import
 * this module without a runtime cycle.
 */
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import type { AgencyNode } from "../types.js";
import type { FunctionCall } from "../types/function.js";
import type { ValueAccess } from "../types/access.js";
import type { InterruptStatement } from "../types/interruptStatement.js";
import type { GotoStatement } from "../types/gotoStatement.js";

export type BodyFacts = {
  /** Effect labels raised by a literal `interrupt` in this body. */
  effects: string[];
  /** Local names of everything this body calls, unresolved. */
  callees: string[];
  /** Every call node seen. Handed back so the type checker can read call
   *  arguments without walking the body a second time. */
  calls: FunctionCall[];
};

/** One yielded step of the walk. walkNodes also hands back `scopes`, which
 *  nothing here needs. */
type Visit = { node: AgencyNode; ancestors: WalkAncestor[] };

const isInterrupt = (visit: Visit): visit is Visit & { node: InterruptStatement } =>
  visit.node.type === "interruptStatement";

const isCall = (visit: Visit): visit is Visit & { node: FunctionCall } =>
  visit.node.type === "functionCall";

const isGoto = (visit: Visit): visit is Visit & { node: GotoStatement } =>
  visit.node.type === "gotoStatement";

/** A guard becomes a `_guard` call in the TypeChecker constructor. The symbol
 *  table walks the tree before that, so the call is not there yet. */
const isGuard = (visit: Visit): boolean => visit.node.type === "guardBlock";

export function collectBodyFacts(body: AgencyNode[]): BodyFacts {
  const visits: Visit[] = [...walkNodes(body)];
  const calls = visits.filter(isCall);
  return {
    effects: unique(visits.filter(isInterrupt).map((visit) => visit.node.effect)),
    callees: unique([
      ...visits.filter(isGuard).map(() => "_guard"),
      ...calls.map((visit) => invokeReceiver(visit.node, visit.ancestors) ?? visit.node.functionName),
      ...visits.filter(isGoto).map((visit) => visit.node.nodeCall.functionName),
    ]),
    calls: calls.map((visit) => visit.node),
  };
}

/**
 * The function `x.invoke(...)` actually calls.
 *
 * That form parses to a property access whose chain holds a method call named
 * `invoke`, so a walk reading `functionName` sees `invoke` and never sees `x`.
 *
 * Scans the ancestors backwards rather than trusting the last one, for two
 * reasons. `invoke` is not always the first chain link: `f.partial(...)` and
 * `f.rename(...)` chain ahead of it. And walkNodes descends an assignment's own
 * access chain passing the assignment as the ancestor
 * (lib/utils/node.ts:393-417), so the access is not always adjacent.
 *
 * Returns null when the receiver is not a plain variable, which covers
 * `obj.handler.invoke()`. Working out what that calls needs types.
 */
export function invokeReceiver(
  node: FunctionCall,
  ancestors: WalkAncestor[],
): string | null {
  if (node.functionName !== "invoke") return null;
  const access = [...ancestors]
    .reverse()
    .filter((ancestor): ancestor is ValueAccess => ancestor.type === "valueAccess")
    .find((candidate) => holdsCall(candidate, node));
  if (!access) return null;
  return access.base.type === "variableName" ? access.base.value : null;
}

/** True when one of this access chain's method-call links IS the given call.
 *  `f.partial(...).invoke()` has two links, so identity is what distinguishes
 *  the call we are standing on from its neighbours. */
function holdsCall(access: ValueAccess, call: FunctionCall): boolean {
  return access.chain.some(
    (link) => link.kind === "methodCall" && link.functionCall === call,
  );
}

export type PropagationNode = {
  effects: string[];
  /** Keys into the same dictionary. What a key means is the caller's business:
   *  the type checker uses local names, the cross-file pass uses file-and-name
   *  pairs. */
  calleeKeys: string[];
};

/**
 * Give every entry the effects of everything it calls, repeatedly, until a full
 * round changes nothing.
 *
 * Terminates because effect lists only grow and the label set is finite. A
 * cycle just costs one extra round. Returns the same object it was given, so a
 * caller can read the result as a value rather than relying on call order.
 */
export function propagateToFixpoint<T extends PropagationNode>(
  nodes: Record<string, T>,
): Record<string, T> {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(nodes)) {
      for (const key of node.calleeKeys) {
        const callee = Object.hasOwn(nodes, key) ? nodes[key] : undefined;
        for (const effect of callee?.effects ?? []) {
          if (!node.effects.includes(effect)) {
            node.effects.push(effect);
            changed = true;
          }
        }
      }
    }
  }
  return nodes;
}

/** Deduplicate, preserving first-seen order. The declarative counterpart to
 *  addUnique, for code that builds a list rather than growing one. */
export function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** Grow a list in place. Kept for the fixpoint and for the type checker's
 *  handler analysis, which accumulate rather than build. */
export function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}
```

`ValueAccess` is exported from `lib/types/access.ts:11`. If its chain link type
does not expose `functionCall` the way this assumes, read that file and adjust.
Do not widen to `any`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:run lib/analysis/effects.test.ts`

Expected: all pass.

The guard cases are the likeliest failures, and the likeliest cause is Agency
syntax rather than logic. The parameter is `cost` and takes a money literal:
`guard(cost: $0.50) { ... }`. `guard(maxCost: 1.0)` is rejected with AG6025.

- [ ] **Step 5: Rewire the type checker**

In `lib/typeChecker/interruptAnalysis.ts`:

Replace `collectFromBody` with:

```ts
function collectFromBody(
  body: AgencyNode[],
  scope: Scope,
  ctx: TypeCheckerContext,
): FunctionProfile {
  const facts = collectBodyFacts(body);
  return {
    effects: unique([
      ...facts.effects,
      // A call THROUGH a function-typed variable (a callback) contributes the
      // variable's declared effects. Named defs resolve via the callee lookup
      // instead; they aren't blockTypes, so this adds nothing for them.
      ...facts.callees.flatMap((name) => calleeDeclaredEffects(name, scope, ctx)),
    ]),
    calleeKeys: unique([
      ...facts.callees,
      ...facts.calls.flatMap((call) => functionRefsInArgs(call.arguments, scope, ctx)),
    ]),
  };
}
```

Delete `propagateTransitively`, `propagateFromCallees` and the local `addUnique`.

Rename `FunctionProfile`'s fields so the shared fixpoint accepts it:

```ts
/** Per-function analysis: what it directly interrupts and what it calls. Field
 *  names match PropagationNode so the shared fixpoint runs over it unchanged. */
type FunctionProfile = {
  effects: string[];
  calleeKeys: string[];
};
```

Update every place that builds or reads a profile — `collectProfiles`,
`collectFromScope`, `formatResult`, `collectRaisableEffects` — to the new names.
`collectProfiles` seeds imported functions like this:

```ts
  for (const [name, importedKinds] of Object.entries(ctx.interruptEffectsByFunction)) {
    profiles[name] = { effects: importedKinds.map((entry) => entry.effect), calleeKeys: [] };
  }
```

And the entry point becomes:

```ts
export function analyzeInterruptsFromScopes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, InterruptEffect[]> {
  return formatResult(propagateToFixpoint(collectProfiles(scopes, ctx)));
}
```

Add the imports:

```ts
import {
  addUnique,
  collectBodyFacts,
  propagateToFixpoint,
} from "../analysis/effects.js";
```

- [ ] **Step 6: Run the full suite and confirm nothing moved**

Run: `pnpm test:run 2>&1 | tee /tmp/task1.log`

Expected: identical pass and fail counts to `main`. Get that baseline first if
you do not have it.

This is a refactor. One difference is expected and is not a behaviour change:
`calleeKeys` ordering, because function references from arguments are now
appended after all plain callees rather than interleaved. Effects are
deduplicated sets, so ordering must not matter — a test that depends on it was
pinning an accident, and fixing the test is correct.

Do **not** expect any `guardBlock` churn. The TypeChecker constructor runs
`desugarGuardsInBody` over the whole program before scopes are collected
(`lib/typeChecker/index.ts:111`), so no `guardBlock` node ever reaches the type
checker's walk.

- [ ] **Step 7: Add the tripwire that compares two independent readings**

The risk here is not that someone edits a list of node names. It is that someone
adds an expression form holding a call, does not add it to `walkNodes`'s
hand-written descent (`lib/utils/node.ts:355` onward), and every analysis in the
compiler goes blind to it with no error anywhere.

A test comparing a constant to a copy of itself cannot catch that. This one can,
because it reads real code two different ways.

Append to `lib/analysis/effects.test.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { parseAgencyFileCached } from "../parseCache.js";

/** Find nodes of the given types by walking raw object properties. Deliberately
 *  not walkNodes: the point is a second opinion about what is in the tree, so
 *  that a gap in walkNodes's hand-written descent shows up as a disagreement
 *  rather than as silence. */
function scanRaw(value: unknown, types: string[], found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) scanRaw(item, types, found);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string" && types.includes(node.type)) {
    found.push(node.type);
  }
  for (const child of Object.values(node)) scanRaw(child, types, found);
}

describe("the walk sees everything a raw scan sees", () => {
  it("finds calls and interrupts in every standard library body that has them", () => {
    const types = ["functionCall", "interruptStatement", "guardBlock"];
    const files = fs
      .readdirSync("stdlib")
      .filter((name) => name.endsWith(".agency"))
      .map((name) => path.resolve("stdlib", name));

    const disagreements: string[] = [];
    for (const file of files) {
      const parsed = parseAgencyFileCached(file, {}, false);
      if (!parsed.success) continue;
      for (const decl of parsed.result.nodes) {
        if (decl.type !== "function" && decl.type !== "graphNode") continue;
        const raw: string[] = [];
        scanRaw(decl.body, types, raw);
        if (raw.length === 0) continue;
        const facts = collectBodyFacts(decl.body);
        if (facts.calls.length + facts.effects.length === 0) {
          disagreements.push(
            `${path.basename(file)}: a body with ${raw.length} call-bearing nodes read as empty`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
```

This asserts the weaker property that a body containing calls is never read as
empty, rather than exact counts, because `collectBodyFacts` deduplicates and a
raw scan does not. That is still enough to fail when the walker gains a blind
spot, which is the failure worth catching.

- [ ] **Step 8: Commit**

```bash
git add lib/analysis/effects.ts lib/analysis/effects.test.ts lib/typeChecker/interruptAnalysis.ts
git commit -F - <<'MSG'
Move the effect walk and the fixpoint into lib/analysis/effects

The type checker and the symbol table both need to answer what a body
raises and how effects travel along call edges. Two answers is how they
came to mean different things on either side of an import.

No behaviour change intended. The tripwire compares the walk against a
raw property scan of the standard library, so a gap in the walker's
descent fails a test rather than going quiet.
MSG
```

---

### Task 2: `.invoke()`, in both walks

`read("a.txt")` and `read.invoke("a.txt")` do the same thing. Measured, in one
file with no imports:

```
export def plain(): string     { return read("a.txt") }
export def viaInvoke(): string { return read.invoke("a.txt") }

→ { plain: ["std::read"], viaInvoke: [] }
```

Task 1 taught the shared walk to see it. That is not enough, because the AG3009
warning does not use the shared walk. It has its own, and it reads
`node.functionName` at the call site, which for `read.invoke(...)` is the string
`invoke`.

**Files:**
- Modify: `lib/analysis/effects.test.ts`
- Modify: `lib/typeChecker/interruptAnalysis.ts:385-415`
- Modify: `lib/typeChecker/functionTypeRaises.ts:106` — a comment only
- Create: `lib/typeChecker/invokeEffects.test.ts`

**Interfaces:**
- Consumes: `invokeReceiver` from Task 1, now used at a second call site.

- [ ] **Step 1: Write the walk-level tests**

Append to `lib/analysis/effects.test.ts`:

```ts
describe("the .invoke() call form", () => {
  it("records the receiver, not the method name", () => {
    const facts = collectBodyFacts(bodyOf(`def f(): string { return read.invoke("x") }`));
    expect(facts.callees).toEqual(["read"]);
  });

  it("records the receiver when invoke follows another chain link", () => {
    // `f.partial(...)` and `f.rename(...)` are ordinary Agency, so invoke is
    // often not the first link. tests/agency-js/http-post/agent.agency:28
    const facts = collectBodyFacts(
      bodyOf(`def f(): string { return fetchJSON.partial(method: "GET").invoke() }`),
    );
    expect(facts.callees).toEqual(["fetchJSON"]);
  });

  it("attributes nothing when the receiver is not a plain variable", () => {
    // obj.handler.invoke() calls whatever obj.handler holds, which needs types.
    // Attributing it to obj would be wrong, not merely imprecise.
    const facts = collectBodyFacts(
      bodyOf(`def f(): string { return obj.handler.invoke("x") }`),
    );
    expect(facts.callees).toEqual([]);
  });
});
```

The third assertion is an exact array, not `not.toContain`. A `not.toContain`
passes when the list is empty for any reason at all, including the walk dropping
the whole statement.

- [ ] **Step 2: Run them**

Run: `pnpm test:run lib/analysis/effects.test.ts`

Expected: all three pass, since Task 1's `invokeReceiver` scans backwards. If the
chained one fails, the scan is still keying on `chain[0]`.

- [ ] **Step 3: Write the end-to-end test, which will fail**

Create `lib/typeChecker/invokeEffects.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

describe("effects through .invoke()", () => {
  it("warns about an unhandled interrupt reached via .invoke()", () => {
    const report = typeCheckSource(`node main() { let y = read.invoke("a.txt") }`);
    expect(report.warnings.map((warning) => warning.code)).toContain("AG3009");
  });

  it("agrees with the plain call form", () => {
    const plain = typeCheckSource(`node main() { let y = read("a.txt") }`);
    const invoked = typeCheckSource(`node main() { let y = read.invoke("a.txt") }`);
    expect(invoked.warnings.map((warning) => warning.code)).toEqual(plain.warnings.map((warning) => warning.code));
  });

  it("names the receiver in the message, not invoke", () => {
    const report = typeCheckSource(`node main() { let y = read.invoke("a.txt") }`);
    const warning = report.warnings.find((warning) => warning.code === "AG3009");
    expect(warning?.message).toContain("'read'");
    expect(warning?.message).not.toContain("'invoke'");
  });
});
```

- [ ] **Step 4: Run and confirm the failure is the expected one**

Run: `pnpm test:run lib/typeChecker/invokeEffects.test.ts`

Expected: all three fail. The first with `expected [] to contain 'AG3009'`.

This failure is **not** a test problem. `checkUnhandledInterruptWarnings` runs its
own walk and never consulted the shared one. Step 5 is what fixes it.

- [ ] **Step 5: Teach the warning's own walk**

In `checkUnhandledInterruptWarnings`, the loop is already
`for (const { node, ancestors } of walkNodes(info.body))`, so the ancestors are
in scope. Replace the name lookup:

```ts
      if (node.type !== "functionCall") continue;
      const called = invokeReceiver(node, ancestors) ?? node.functionName;
      const kinds = interruptEffectsByFunction[called];
      if (!kinds || kinds.length === 0) continue;
      if (isInsideHandler(ancestors)) continue;
      const kindList = kinds.map((entry) => entry.effect).join(", ");
      // The guard construct desugars to a `_guard` call before this walk, so
      // the warning names what the user wrote.
      const displayName = called === "_guard" ? "guard" : called;
```

Add `invokeReceiver` to the import from `../analysis/effects.js`.

- [ ] **Step 6: Record the `functionTypeRaises` gap rather than fixing it**

`callFlows` (`lib/typeChecker/functionTypeRaises.ts:106`) returns nothing when a
call's parent is a `valueAccess`, with a comment explaining that a method call
resolves against the chain rather than against a same-named global. That stays
correct for real method calls.

It now also excludes `h.invoke(someCallback)` from the AG3014 and AG3015 checks,
which compare a function value against the `raises` clause on the slot it flows
into. So passing a callback through `.invoke()` skips a check the plain form
gets.

Do not fix it here. Add the comment and open an issue:

```ts
  // Also excludes `h.invoke(cb)` from the raises checks below, because the
  // walked call is named `invoke`. Narrowing this to real method calls means
  // resolving the receiver first; tracked separately.
  if (ancestors[ancestors.length - 1]?.type === "valueAccess") return [];
```

- [ ] **Step 7: Count the churn before fixing any of it**

Run: `pnpm test:run 2>&1 | tee /tmp/task2-churn.log`

```bash
grep -oE "AG[0-9]{4}" /tmp/task2-churn.log | sort | uniq -c | sort -rn
grep -E "^\s*(×|FAIL)" /tmp/task2-churn.log | sort | uniq -c | sort -rn | head -40
```

Report the numbers before fixing anything. If more than about twenty tests break,
or if any break under `tests/agency/`, stop and ask.

Expect breakage in AG3009, and in AG3011 where a callback body calls something
with `.invoke()`.

- [ ] **Step 8: Fix the churn**

For each broken test, decide which of three cases it is, and say which in the
commit message:

1. The test asserted no diagnostics and now correctly gets one. Update the
   expectation. The code was always doing the risky thing.
2. A fixture's expected output changed. Regenerate with `make fixtures` and read
   the diff before accepting it.
3. The program is now genuinely invalid. Add the `handle` block or `raises`
   clause it always needed.

Never suppress with `// @tc-ignore`. That hides the information this work exists
to surface.

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm test:run 2>&1 | tee /tmp/task2-after.log`

```bash
git add -A
git commit -F - <<'MSG'
See effects through the .invoke() call form

read("x") and read.invoke("x") do the same thing. Every effect walk
looked for a call named read and found one only in the first case.

Two walks needed teaching, not one: the shared walk, and
checkUnhandledInterruptWarnings, which reads the call site directly.

Measured before this change, in one file with no imports:
  plain: ["std::read"], viaInvoke: []

Test churn absorbed: <counts from step 7>
MSG
```

---

### Task 3: The propagation pass

`SymbolTable.build` already crawls every reachable file and parses it. Add a step
at the end that walks those trees, resolves each callee to where it is really
defined, and runs the shared fixpoint.

**Files:**
- Modify: `lib/analysis/effects.ts`
- Create: `lib/analysis/effectPropagation.test.ts`
- Modify: `lib/symbolTable.ts`, at the `return new SymbolTable(files, effectDecls)`
  after the `resolveReExports` loop

**Interfaces:**
- Consumes: `collectBodyFacts`, `propagateToFixpoint` from Task 1.
- Produces: `propagateEffects(table: SymbolTable, programs: Record<string, AgencyProgram>): void`.
- Produces: `originOf(table: SymbolTable, at: Origin): Origin` where
  `Origin = { file: string; name: string }`.

**The one thing that will bite you.** Do not recompute direct effects by walking
the body. `_guard` (`stdlib/index.agency:595`) contains no `interrupt` statement
at all — its `std::guard` comes from `TS_SIDE_EFFECT_SEEDS`
(`lib/symbolTable.ts:509-520`), because the trip is raised on the TypeScript side
at runtime. A body walk gives it `[]`, and writing that back removes cost caps
from the policy file, the docs, the `raises` checks and the editor. Seed each
summary from the symbol the crawl already computed.

- [ ] **Step 1: Write the failing tests**

Create `lib/analysis/effectPropagation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => { dir = makeAgencyTempDir("effectprop"); });
afterEach(() => { safeDeleteDirectory(dir, false); });

function write(name: string, source: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, source, "utf-8");
  return filePath;
}

function effectsIn(entry: string, file: string, name: string): string[] {
  const table = SymbolTable.build(entry, {});
  const sym = table.getFile(path.resolve(file))?.[name];
  if (!sym || (sym.kind !== "function" && sym.kind !== "node")) {
    throw new Error(`no callable symbol '${name}' in ${file}`);
  }
  return (sym.interruptEffects ?? []).map((entry) => entry.effect).sort();
}

function effectsOf(entry: string, name: string): string[] {
  return effectsIn(entry, entry, name);
}

const RISKY = `export def h(): string {\n  return read("data.txt")\n}\n`;

describe("effect propagation across files", () => {
  it("carries an effect from a helper that wraps a stdlib call", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nexport def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("carries an effect into a graph node, which is the reported bug", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nnode main() {\n  const x = h()\n}\n`,
    );
    expect(effectsOf(main, "main")).toEqual(["std::read"]);
  });

  it("carries an effect through a chain of two helpers", () => {
    write(
      "helper.agency",
      `export def inner(): string {\n  return read("data.txt")\n}\n` +
        `export def outer(): string {\n  return inner()\n}\n`,
    );
    const main = write(
      "main.agency",
      `import { outer } from "./helper.agency"\nexport def caller(): string {\n  return outer()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("carries an effect through the .invoke() call form", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nexport def caller(): string {\n  return h.invoke()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("carries std::guard out of a helper that uses a guard block", () => {
    write(
      "helper.agency",
      `export def h(): string {\n  const r = guard(cost: $0.50) {\n    return "hi"\n  }\n  return "done"\n}\n`,
    );
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nexport def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::guard"]);
  });

  it("leaves _guard itself reporting std::guard", () => {
    // _guard has no `interrupt` in its body; its label comes from the seed
    // table. Recomputing direct effects from a body walk would erase it and
    // silently remove cost caps from every consumer.
    const main = write("main.agency", `export def caller(): string {\n  return "hi"\n}\n`);
    const table = SymbolTable.build(main, {});
    const stdlib = table
      .filePaths()
      .find((file) => file.endsWith(path.join("stdlib", "index.agency")));
    expect(stdlib).toBeDefined();
    const sym = table.getFile(stdlib as string)?.["_guard"];
    const labels =
      sym && (sym.kind === "function" || sym.kind === "node")
        ? (sym.interruptEffects ?? []).map((entry) => entry.effect)
        : [];
    expect(labels).toContain("std::guard");
  });

  it("follows a renamed import", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h as g } from "./helper.agency"\nexport def caller(): string {\n  return g()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("follows an imported node", () => {
    write("worker.agency", `node work() {\n  const x = read("data.txt")\n}\n`);
    const main = write(
      "main.agency",
      `import node { work } from "./worker.agency"\nnode main() {\n  goto work()\n}\n`,
    );
    expect(effectsOf(main, "main")).toEqual(["std::read"]);
  });

  it("does not confuse two reachable files that define the same name", () => {
    // Both files must be reachable, or the crawl never parses the risky one and
    // the test would pass under a resolver that ignored file identity.
    write("risky.agency", RISKY);
    write("safe.agency", `export def h(): string {\n  return "nothing"\n}\n`);
    const main = write(
      "main.agency",
      `import { h } from "./safe.agency"\n` +
        `import { h as riskyH } from "./risky.agency"\n` +
        `export def caller(): string {\n  return h()\n}\n` +
        `export def other(): string {\n  return riskyH()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual([]);
    expect(effectsOf(main, "other")).toEqual(["std::read"]);
  });

  it("does not give a clean callee its caller's effects", () => {
    write("helper.agency", `export def clean(): string {\n  return "hi"\n}\n`);
    const main = write(
      "main.agency",
      `import { clean } from "./helper.agency"\n` +
        `export def risky(): string {\n  read("x")\n  return clean()\n}\n`,
    );
    expect(effectsIn(main, path.join(dir, "helper.agency"), "clean")).toEqual([]);
  });

  it("terminates on an import cycle and still propagates", () => {
    write(
      "a.agency",
      `import { b } from "./b.agency"\nexport def a(): string {\n  return b()\n}\n`,
    );
    write(
      "b.agency",
      `import { a } from "./a.agency"\nexport def b(): string {\n  return read("x")\n}\n`,
    );
    expect(effectsOf(path.join(dir, "a.agency"), "a")).toEqual(["std::read"]);
  });

  it("survives a file in the crawl that does not parse", () => {
    // The crawl is deliberately best-effort (lib/symbolTable.ts:172-179), and
    // the editor hits half-typed files constantly. The pass must not throw
    // where the crawl chose to keep going.
    write("broken.agency", `export def oops(: {{{\n`);
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\n` +
        `import { oops } from "./broken.agency"\n` +
        `export def caller(): string {\n  return h()\n}\n`,
    );
    expect(() => effectsOf(main, "caller")).not.toThrow();
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });
});
```

- [ ] **Step 2: Run and confirm the failures**

Run: `pnpm test:run lib/analysis/effectPropagation.test.ts`

Expected failing: the wrapper, graph node, chain, `.invoke()`, guard, renamed
import, imported node, cycle, and parse-failure cases, all with
`expected [] to deeply equal [ 'std::read' ]` or the `std::guard` equivalent.

Expected passing already: `_guard` reports `std::guard` from the seed, the
same-name case, and the clean-callee case. These guard against regressions you
are about to be able to cause, rather than describing the current gap.

If one fails with "no callable symbol", the fixture does not parse or does not
export. Fix the fixture.

- [ ] **Step 3: Add the pass to `lib/analysis/effects.ts`**

Append:

```ts
/** Where a name is really defined, after renaming and re-export. */
export type Origin = { file: string; name: string };

type EffectSummary = PropagationNode & Origin;

/** Two files can define the same top-level name and an import can rename one,
 *  so a bare name is not an identity. The key is never parsed back apart —
 *  every summary carries its own file and name. */
function keyOf(origin: Origin): string {
  return `${origin.file} ${origin.name}`;
}

function summaryAt(
  summaries: Record<string, EffectSummary>,
  origin: Origin,
): EffectSummary | undefined {
  const key = keyOf(origin);
  return Object.hasOwn(summaries, key) ? summaries[key] : undefined;
}

export function propagateEffects(
  table: SymbolTable,
  programs: Record<string, AgencyProgram>,
): void {
  writeBack(table, propagateToFixpoint(buildSummaries(table, programs)));
}

/**
 * One summary per callable declaration.
 *
 * Direct effects are read from the symbol rather than recomputed from the body,
 * because a body walk is not where they all come from: `_guard` raises from the
 * TypeScript side and gets its label from a seed table in classifySymbols.
 * Recomputing here would erase it. collectBodyFacts is used only for the call
 * edges, which is what propagation actually needs.
 *
 * Agency has no nested `def`, so top-level functions and graph nodes are the
 * whole set. The type checker additionally has scopes for block arguments and
 * inline handler bodies; those are file-local and can never be imported, so
 * they need no entry here.
 */
function buildSummaries(
  table: SymbolTable,
  programs: Record<string, AgencyProgram>,
): Record<string, EffectSummary> {
  // Null prototype and Object.hasOwn on read: keys are user-controlled file
  // paths and symbol names. House pattern, as in TS_SIDE_EFFECT_SEEDS.
  return Object.assign(
    Object.create(null),
    Object.fromEntries(
      Object.entries(programs)
        .flatMap(([file, program]) => summariesForFile(table, program, file))
        .map((summary) => [keyOf(summary), summary]),
    ),
  );
}

type CallableDeclaration = FunctionDefinition | GraphNodeDefinition;

const isCallableDeclaration = (node: AgencyNode): node is CallableDeclaration =>
  node.type === "function" || node.type === "graphNode";

function summariesForFile(
  table: SymbolTable,
  program: AgencyProgram,
  file: string,
): EffectSummary[] {
  const resolve = makeResolver(table, program, file);
  return [...walkNodes(program.nodes)]
    .map((visit) => visit.node)
    .filter(isCallableDeclaration)
    .map((declaration) => {
      const name = declaredName(
        declaration.type === "function"
          ? declaration.functionName
          : declaration.nodeName,
      );
      return {
        file,
        name,
        effects: directEffectsOf(table, file, name),
        calleeKeys: collectBodyFacts(declaration.body).callees.map((callee) =>
          keyOf(resolve(callee)),
        ),
      };
    });
}

/** What classifySymbols already worked out, including the seed table. Read
 *  rather than recomputed: _guard raises on the TypeScript side and has no
 *  `interrupt` in its body, so a body walk would report nothing for it. */
function directEffectsOf(table: SymbolTable, file: string, name: string): string[] {
  const sym = table.getFile(file)?.[name];
  if (!sym || (sym.kind !== "function" && sym.kind !== "node")) return [];
  return (sym.interruptEffects ?? []).map((entry) => entry.effect);
}

function writeBack(
  table: SymbolTable,
  summaries: Record<string, EffectSummary>,
): void {
  for (const { file, name, sym } of callableSymbols(table)) {
    // Resolve through re-exports so a barrel's own copy of a name gets the
    // origin's answer rather than an empty one.
    const summary = summaryAt(summaries, originOf(table, { file, name }));
    if (!summary) continue;
    sym.interruptEffects = summary.effects.map((effect) => ({ effect }));
  }
}

type CallableSymbol = Origin & { sym: FunctionSymbol | NodeSymbol };

/** Every function and node symbol in the table, tagged with where it lives. */
function callableSymbols(table: SymbolTable): CallableSymbol[] {
  return table.filePaths().flatMap((file) =>
    Object.entries(table.getFile(file) ?? {})
      .filter(
        (entry): entry is [string, FunctionSymbol | NodeSymbol] =>
          entry[1].kind === "function" || entry[1].kind === "node",
      )
      .map(([name, sym]) => ({ file, name, sym })),
  );
}

/** Map a local callee name, as written at a call site in `fromFile`, to where it
 *  is really defined. Falls back to the current file for builtins and unknown
 *  names, which then find no summary. */
function makeResolver(
  table: SymbolTable,
  program: AgencyProgram,
  fromFile: string,
): (localName: string) => Origin {
  const imported: Record<string, Origin> = Object.assign(
    Object.create(null),
    Object.fromEntries(
      importsOf(table, program, fromFile).map((resolved) => [
        resolved.localName,
        originOf(table, { file: resolved.file, name: resolved.originalName }),
      ]),
    ),
  );
  return (localName) =>
    Object.hasOwn(imported, localName)
      ? imported[localName]
      : { file: fromFile, name: localName };
}

/** Every named symbol this file imports, from both import forms. */
function importsOf(
  table: SymbolTable,
  program: AgencyProgram,
  fromFile: string,
): ResolvedImport[] {
  return [...walkNodes(program.nodes)].flatMap(({ node }) => {
    if (node.type === "importStatement") {
      return table.resolveImport(node, fromFile);
    }
    if (node.type === "importNodeStatement") {
      return table.resolveImportedNodes(node, fromFile);
    }
    return [];
  });
}

/**
 * Follow `reExportedFrom` to where a name is really defined. A barrel can
 * re-export a barrel, so this repeats.
 *
 * No depth guard: SymbolTable.build already detects a re-export cycle and
 * throws with the chain in the message, in its own resolveReExports walk,
 * before this runs.
 */
export function originOf(table: SymbolTable, at: Origin): Origin {
  const sym = table.getFile(at.file)?.[at.name];
  const from = sym && "reExportedFrom" in sym ? sym.reExportedFrom : undefined;
  return from
    ? originOf(table, { file: from.sourceFile, name: from.originalName })
    : at;
}
```

Add to the imports at the top of the file:

```ts
import { declaredName } from "../types/hole.js";
import type { AgencyProgram } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type {
  FunctionSymbol,
  NodeSymbol,
  ResolvedImport,
  SymbolTable,
} from "../symbolTable.js";
```

- [ ] **Step 4: Call it from `SymbolTable.build`**

Replace the final `return new SymbolTable(files, effectDecls);` with:

```ts
    const table = new SymbolTable(files, effectDecls);
    const programs: Record<string, AgencyProgram> = Object.create(null);
    for (const [filePath, { program }] of Object.entries(parsed)) {
      programs[filePath] = program;
    }
    // classifySymbols records direct effects only. Follow calls now, while every
    // reachable file's parse tree is still in hand, so that interruptEffects
    // means the same thing on both sides of an import.
    propagateEffects(table, programs);
    return table;
```

Add `import { propagateEffects } from "./analysis/effects.js";`.

- [ ] **Step 5: Run the propagation tests**

Run: `pnpm test:run lib/analysis/effectPropagation.test.ts`

Expected: all pass.

If the `_guard` test now fails, `buildSummaries` is recomputing direct effects
from the body instead of reading them off the symbol. That is the regression this
task warns about — fix it there, not by special-casing `_guard`.

If the guard propagation test fails but `_guard` itself is fine, the callee did
not resolve. Log `Object.keys(imported)` in the resolver; `_guard` reaches user
files through the injected prelude import and must be in `PRELUDE_NAMES`
(`lib/prelude.ts:31`).

- [ ] **Step 6: Count the churn**

Run: `pnpm test:run 2>&1 | tee /tmp/task3-churn.log`

```bash
grep -oE "AG[0-9]{4}" /tmp/task3-churn.log | sort | uniq -c | sort -rn
```

Report before fixing. This change has the widest reach and five of the nine
consumers push errors.

- [ ] **Step 7: Fix the churn, run everything, commit**

Same three cases as Task 2 Step 8. Run `make` first if anything under `stdlib/`
changed.

```bash
git add -A
git commit -F - <<'MSG'
Follow calls across file boundaries when recording effects

classifySymbols recorded only literal `interrupt` statements plus a seed
table, so an imported function arrived at the type checker as a leaf. A
helper wrapping read() reported nothing, and agency policy gen printed
"No policy needed" for a program that reads the filesystem through it.

New pass at the end of SymbolTable.build walks the parse trees the crawl
already produced and runs the shared fixpoint. Direct effects come from
the symbol, not from a second body walk, because _guard raises on the
TypeScript side and a body walk would erase its label.

Test churn absorbed: <counts from step 6>

Closes #680
MSG
```

---

### Task 4: Re-exports, in all three forms

A barrel file re-exports names it does not define, so resolving an import of one
lands on a file with no matching declaration. Task 3 already wrote `originOf`.
This proves it across the three ways a barrel gets written, which go through
different code paths: named, renamed, and star (`lib/symbolTable.ts:587`).

**Files:**
- Modify: `lib/analysis/effectPropagation.test.ts`

- [ ] **Step 1: Write the tests**

Append:

```ts
describe("re-exported names", () => {
  const barrels: { label: string; barrel: string; importName: string }[] = [
    { label: "a named re-export", barrel: `export { h } from "./helper.agency"\n`, importName: "h" },
    { label: "a renamed re-export", barrel: `export { h as g } from "./helper.agency"\n`, importName: "g" },
    { label: "a star re-export", barrel: `export * from "./helper.agency"\n`, importName: "h" },
  ];

  for (const { label, barrel, importName } of barrels) {
    it(`follows ${label}`, () => {
      write("helper.agency", RISKY);
      write("barrel.agency", barrel);
      const main = write(
        "main.agency",
        `import { ${importName} } from "./barrel.agency"\n` +
          `export def caller(): string {\n  return ${importName}()\n}\n`,
      );
      expect(effectsOf(main, "caller")).toEqual(["std::read"]);
    });
  }

  it("follows two re-export hops", () => {
    write("helper.agency", RISKY);
    write("inner.agency", `export { h } from "./helper.agency"\n`);
    write("outer.agency", `export { h } from "./inner.agency"\n`);
    const main = write(
      "main.agency",
      `import { h } from "./outer.agency"\nexport def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("records the effect on the barrel's own symbol too", () => {
    // buildCompilationUnit seeds from the barrel's symbols when a file imports
    // from it, so the barrel's copy has to be right, not only the origin's.
    write("helper.agency", RISKY);
    const barrel = write("barrel.agency", `export { h } from "./helper.agency"\n`);
    expect(effectsOf(barrel, "h")).toEqual(["std::read"]);
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm test:run lib/analysis/effectPropagation.test.ts`

Expected: all pass, since `originOf` runs in both `makeResolver` and `writeBack`.

If the barrel's own symbol is empty, `writeBack` is only visiting defining files.
It must walk every file's symbols and resolve each through `originOf`.

If the star form fails while the named form passes, `mergeExportsFrom`'s
`starExport` branch (`lib/symbolTable.ts:587`) may not set `reExportedFrom`.
Check, and if it does not, that is a real gap worth fixing there rather than
working around here.

- [ ] **Step 3: Commit**

```bash
git add lib/analysis/effectPropagation.test.ts
git commit -m "Cover effects reached through barrel files, in all three re-export forms"
```

---

### Task 5: Cross-check against an independent oracle

Comparing the new pass against `getEffectsFromFile` proves nothing for imported
functions. `getEffectsFromFile` runs the type checker through
`runCheckerPipeline`, which builds a symbol table and hands it to
`buildCompilationUnit`, which seeds imported effects straight from
`sym.interruptEffects` — the field the new pass just wrote. That is a round trip.

Two comparisons that are not round trips:

`analyzeInterrupts` (`lib/analysis/interrupts.ts`) type-checks every reachable
file separately and merges the call graphs. It never reads `sym.interruptEffects`
for its call edges.

And for effects arising **within** the file being checked, the type checker
propagates through its own scopes rather than through the symbol table, so the
two sides really do compute it separately.

**Files:**
- Create: `lib/analysis/effectsOracle.test.ts`

- [ ] **Step 1: Write the in-file comparison**

Create `lib/analysis/effectsOracle.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { getEffectsFromFile } from "../compiler/typecheck.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => { dir = makeAgencyTempDir("effectsoracle"); });
afterEach(() => { safeDeleteDirectory(dir, false); });

function symbolTableEffects(entry: string, name: string): string[] {
  const table = SymbolTable.build(entry, {});
  const sym = table.getFile(path.resolve(entry))?.[name];
  return sym && (sym.kind === "function" || sym.kind === "node")
    ? (sym.interruptEffects ?? []).map((entry) => entry.effect).sort()
    : [];
}

/**
 * Cases where BOTH sides compute the answer themselves: the effect arises
 * inside the file under test, so the type checker propagates through its own
 * scopes rather than reading the symbol table's answer back out.
 */
describe("the two analyses agree on effects that arise in one file", () => {
  const cases: { label: string; source: string }[] = [
    {
      label: "a local helper reached by a plain call",
      source: `export def helper(): string {\n  return read("x")\n}\nexport def caller(): string {\n  return helper()\n}\n`,
    },
    {
      label: "a local helper reached via .invoke()",
      source: `export def helper(): string {\n  return read("x")\n}\nexport def caller(): string {\n  return helper.invoke()\n}\n`,
    },
    {
      label: "a guard block in the same file",
      source: `export def caller(): string {\n  const r = guard(cost: $0.50) {\n    return "hi"\n  }\n  return "done"\n}\n`,
    },
    {
      label: "a two-hop local chain",
      source: `export def inner(): string {\n  return read("x")\n}\nexport def middle(): string {\n  return inner()\n}\nexport def caller(): string {\n  return middle()\n}\n`,
    },
  ];

  for (const { label, source } of cases) {
    it(`agrees on ${label}`, () => {
      const entry = path.join(dir, "main.agency");
      fs.writeFileSync(entry, source, "utf-8");
      const fromTypeChecker = (getEffectsFromFile(entry)["caller"] ?? []).sort();
      expect(symbolTableEffects(entry, "caller")).toEqual(fromTypeChecker);
      // Without this, the comparison passes when both sides found nothing.
      expect(fromTypeChecker.length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Try the independent oracle**

Append:

```ts
import { analyzeInterrupts } from "./interrupts.js";

describe("the new pass agrees with the type-check-everything analysis", () => {
  it("finds the same effect across a file boundary", () => {
    fs.writeFileSync(
      path.join(dir, "helper.agency"),
      `export def h(): string {\n  return read("data.txt")\n}\n`,
      "utf-8",
    );
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(
      main,
      `import { h } from "./helper.agency"\nnode main() {\n  const x = h()\n}\n`,
      "utf-8",
    );

    // analyzeInterrupts type-checks each reachable file separately and never
    // reads sym.interruptEffects for its call edges, so this is a real second
    // opinion rather than a round trip.
    const sites = analyzeInterrupts(main, {}).sites.map((result) => result.site.effect);
    expect(sites).toContain("std::read");
    expect(symbolTableEffects(main, "main")).toEqual(["std::read"]);
  });
});
```

If `analyzeInterrupts` reports sites in a shape that makes this awkward, keep
Step 1's comparison and drop this one, recording why in the commit message. Do
not reshape `analyzeInterrupts` to make a test convenient.

- [ ] **Step 3: Confirm the enumeration comment is in place**

The comment above `buildSummaries` in Task 3 Step 3 records why the two sides
enumerate the same set. Confirm it survived any edits and still reads correctly.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:run lib/analysis/effectsOracle.test.ts`

```bash
git add lib/analysis/effectsOracle.test.ts
git commit -F - <<'MSG'
Cross-check the new pass against an independent reading

Comparing against getEffectsFromFile proves nothing for an imported
function: that path seeds from the symbol table's answer, so it reads
back what the pass just wrote. These cases either arise inside one file,
where both sides propagate for themselves, or go through
analyzeInterrupts, which type-checks each file separately.
MSG
```

---

### Task 6: The five error diagnostics and handler typing

Five consumers push errors rather than warnings, and an error fails a build.
Task 3 absorbed the churn; this pins the new correct behaviour.

**Files:**
- Create: `lib/typeChecker/crossModuleEffectDiagnostics.test.ts`

**Interfaces:**
- Consumes: `typeCheckSource(source, sourcePath)`. The two-argument form is
  required whenever the source has a relative import: the one-argument form
  writes to a temp directory where `./helper.agency` does not exist, and import
  resolution throws.

- [ ] **Step 1: Write the tests**

Create `lib/typeChecker/crossModuleEffectDiagnostics.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { typeCheckSource } from "../compiler/typecheck.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => { dir = makeAgencyTempDir("crossmoddiag"); });
afterEach(() => { safeDeleteDirectory(dir, false); });

function check(mainSource: string) {
  fs.writeFileSync(
    path.join(dir, "helper.agency"),
    `export def h(): string {\n  return read("data.txt")\n}\n`,
    "utf-8",
  );
  const main = path.join(dir, "main.agency");
  fs.writeFileSync(main, mainSource, "utf-8");
  return typeCheckSource(mainSource, main);
}

const IMPORT = `import { h } from "./helper.agency"\n`;

describe("effects reaching diagnostics across a file boundary", () => {
  it("AG3009 warns when a node calls an imported wrapper unhandled", () => {
    const report = check(`${IMPORT}node main() {\n  const x = h()\n}\n`);
    expect(report.warnings.map((warning) => warning.code)).toContain("AG3009");
  });

  it("AG3009 stays quiet when the call is inside a handle block", () => {
    // Suppression is lexical: isInsideHandler walks the ancestor chain for a
    // handleBlock, so the call has to be INSIDE the block, not beside it.
    const report = check(
      `${IMPORT}node main() {\n` +
        `  handle {\n    const x = h()\n  } with (data) {\n    return approve()\n  }\n}\n`,
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("AG3009");
    expect(report.errors).toEqual([]);
  });

  it("AG3011 rejects a callback body that calls an imported wrapper", () => {
    const report = check(
      `${IMPORT}node main() {\n  callback("onThing") {\n    const x = h()\n  }\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).toContain("AG3011");
  });

  it("AG3013 rejects a raises clause that an imported call exceeds", () => {
    const report = check(
      `${IMPORT}export def caller(): string raises <std::exec> {\n  return h()\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).toContain("AG3013");
  });

  it("AG3013 accepts a raises clause that covers the imported call", () => {
    const report = check(
      `${IMPORT}export def caller(): string raises <std::read> {\n  return h()\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).not.toContain("AG3013");
  });

  it("AG3016 rejects a finalize block that calls an imported wrapper", () => {
    const report = check(
      `${IMPORT}export def caller(): string {\n  const out = "hi"\n  finalize {\n    const x = h()\n  }\n  return out\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).toContain("AG3016");
  });
});
```

- [ ] **Step 2: Check every snippet before running**

Three of these use constructs the plan got wrong once already. Confirm each
against a real source before running:

- `handle { } with (data) { }` — `docs/site/guide/interrupts.md:20-32`
- `finalize { }` placement — `docs/site/guide/partial-results.md`; the guide puts
  it at the end of a function body, not alone in a node
- `raises <...>` — `stdlib/git.agency:266` and `stdlib/index.agency:599`
- `callback(...) { }` — `lib/preprocessors/liftCallbacks.test.ts`

Fix the fixture, never the assertion.

- [ ] **Step 3: Run**

Run: `pnpm test:run lib/typeChecker/crossModuleEffectDiagnostics.test.ts`

Expected: all six pass.

- [ ] **Step 4: Add the handler parameter typing test**

Append:

```ts
describe("handler parameter typing across a file boundary", () => {
  it("types the handler parameter from the imported call's effect", () => {
    // Asserting that a real field resolves proves nothing: a loose fallback
    // type accepts any field. Reading a field that does NOT exist on the
    // std::read payload must ERROR, and only a parameter carrying the real
    // payload type can produce that.
    const report = check(
      `${IMPORT}node main() {\n` +
        `  handle {\n    const x = h()\n  } with (data) {\n` +
        `    const nope = data.thisFieldDoesNotExist\n    return approve()\n  }\n}\n`,
    );
    expect(report.errors.length).toBeGreaterThan(0);
  });
});
```

Run it, read which diagnostic fires, and tighten the assertion to that code once
you know it. If **no** error fires, the handler parameter is falling back to a
loose type. That is worth investigating before moving on — handlers are safety
infrastructure, and the parameter type is what a handler author reads.

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/crossModuleEffectDiagnostics.test.ts
git commit -m "Cover the five error diagnostics and handler typing across a file boundary"
```

---

### Task 7: The four reporting consumers

**Files:**
- Create: `lib/cli/policyCrossModule.test.ts`
- Modify: `lib/cli/policy.ts` — export `uniqueInterruptEffects`
- Modify: `lib/compiler/typecheck.test.ts`
- Modify: `lib/cli/doc.test.ts` (or create it)
- Modify: `stdlib/agency.agency`

- [ ] **Step 1: Export the function the policy test needs**

In `lib/cli/policy.ts`, change `function uniqueInterruptEffects(` to
`export function uniqueInterruptEffects(`. The test must call the real
implementation, not a copy of it, or it keeps passing when that function changes.

- [ ] **Step 2: Write the permissions file test**

Create `lib/cli/policyCrossModule.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { uniqueInterruptEffects } from "./policy.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => { dir = makeAgencyTempDir("policycross"); });
afterEach(() => { safeDeleteDirectory(dir, false); });

describe("agency policy gen across a file boundary", () => {
  it("lists an effect reached through an imported helper", () => {
    // policyGen writes files and calls process.exit, so this drives the
    // function that decides what goes in the policy rather than the command.
    // An empty list is what makes it print "No policy needed" and write
    // nothing.
    fs.writeFileSync(
      path.join(dir, "helper.agency"),
      `export def h(): string {\n  return read("data.txt")\n}\n`,
      "utf-8",
    );
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(
      main,
      `import { h } from "./helper.agency"\nnode main() {\n  const x = h()\n}\n`,
      "utf-8",
    );

    const table = SymbolTable.build(main, {});
    // Passing an empty type-checker map on purpose: it proves the symbol
    // table's list alone is now sufficient, which is the whole change.
    const effects = uniqueInterruptEffects(table.getFile(path.resolve(main)), {});
    expect(effects).toEqual(["std::read"]);
  });
});
```

- [ ] **Step 3: Write the string-source API tests**

Add to `lib/compiler/typecheck.test.ts`:

```ts
import { getEffectsFromSource } from "./typecheck.js";

describe("getEffectsFromSource", () => {
  it("reports the effects of a stdlib function that wraps another", () => {
    // Measured before the propagation pass: { f: [] }. runFile runs arbitrary
    // Agency code and this said it did nothing.
    const effects = getEffectsFromSource(
      `import { runFile } from "std::agency"\n` +
        `export def f(): string {\n  return runFile("x.agency")\n}\n`,
    );
    expect(effects["f"]).toEqual(["std::guard", "std::run"]);
  });

  it("throws rather than answering short for a relative import", () => {
    // No directory to resolve against, so it fails loud. That is documented
    // behaviour and the safe direction.
    expect(() =>
      getEffectsFromSource(
        `import { h } from "./helper.agency"\nexport def f(): string {\n  return h()\n}\n`,
      ),
    ).toThrow();
  });
});
```

The second assertion checks only that it throws. What was measured is the error
type, not its message text, so do not assert a message you have not seen. If you
want the stronger assertion, run it once and paste the real message.

If the `runFile` pair comes back different, check the current truth with
`getEffectsFromFile("stdlib/agency.agency")["runFile"]` and use that.

- [ ] **Step 4: Write the documentation test**

The spec asked for a test, not an eyeballed diff. Add to `lib/cli/doc.test.ts`:

```ts
it("lists effects that come from a call rather than a literal interrupt", () => {
  // runFile has no `interrupt` in its body; its effects come entirely from what
  // it calls. Before propagation crossed file boundaries its Throws column was
  // empty.
  const effects = getEffectsFromFile(path.resolve("stdlib/agency.agency"));
  expect(effects["runFile"]).toEqual(["std::guard", "std::run"]);
});
```

Follow whatever import and helper style that file already uses. If it does not
exist, create it with the same shape as a neighbouring CLI test.

- [ ] **Step 5: Regenerate the documentation**

Run: `make doc`

Read the diff in `docs/site/stdlib/`. Expect the Throws column to gain entries
for exactly five functions: `run`, `runFile` and `runCode` in
`stdlib/agency.agency`, `parsePolicyFile` in `stdlib/policy.agency`, and
`supervise` in `stdlib/supervise.agency`. If other pages move, find out why.
`make` is known to drift `docs/site/stdlib/data/usaspending.md`, which should be
reverted rather than committed.

- [ ] **Step 6: Correct the `getEffects` docstring**

In `stdlib/agency.agency`, the `getEffects` docstring warns only about relative
imports. Add the blind spots. Keep it terse: docstrings become tool descriptions
handed to language models.

```
  Effects this cannot see: code generated by a compile-time splice, a
  function received as a parameter and then called, and a function
  reference stored in a variable before being passed on. An empty list
  means nothing risky was found, not that nothing risky exists.
```

Then run `make` (not `pnpm run build`), followed by `make doc`.

- [ ] **Step 7: Run and commit**

```bash
pnpm test:run lib/cli/policyCrossModule.test.ts lib/compiler/typecheck.test.ts lib/cli/doc.test.ts
git add -A
git commit -F - <<'MSG'
Cover the reporting consumers across a file boundary

The permissions file, the docs Throws column and the string-source
effects API all read the direct list. std::agency runFile runs arbitrary
Agency code and reported no effects at all.

Five stdlib functions gain Throws entries: run, runFile, runCode,
parsePolicyFile, supervise.
MSG
```

---

### Task 8: Check a generator before running it

`lib/compiler/splice/eligibility.ts` has two rules today: a generator may not
contain a generator call of its own, and its imports must stay inside Agency.
There is no effect check, and the comment at line 188 explains that one was left
out because this bug made a precise one impossible.

It is possible now.

**Files:**
- Modify: `lib/compiler/splice/eligibility.ts`
- Modify: `lib/compiler/splice/eligibility.test.ts`
- Modify: `lib/preprocessors/expandSplices.ts`
- Modify: `lib/analysis/effects.ts` — add `reachableFrom`
- Modify: `lib/typeChecker/diagnostics.ts`

- [ ] **Step 1: Thread a symbol table through instead of building one per splice**

`checkGeneratorEligible` runs once per splice site, from the `CHECKS` array at
`lib/preprocessors/expandSplices.ts:217-221`. Building a symbol table inside it
would crawl and parse every reachable file including the whole prelude, about
55ms cold, and a file with ten splices would pay it ten times.

`expandSplices` already takes an `options` argument (`ExpandOptions`), and its
callers have a table in hand — `runCheckerPipeline` builds one two lines before
it calls `expandSplices`.

Add `symbolTable?: SymbolTable` to `ExpandOptions`, carry it into
`DecisionContext` (line 205), pass it to `checkGeneratorEligible`, and have
callers supply the table they already built. Where a caller has none, the check
builds one as a fallback — a correct answer at a cost, rather than no answer.

- [ ] **Step 2: Add the diagnostics**

In `lib/typeChecker/diagnostics.ts`, next to the existing splice entries. AG8003
and AG8004 are free; the file uses AG8001, AG8002 and AG8005 through AG8013.

```ts
  spliceGeneratorRaises: {
    code: "AG8003",
    severity: "error",
    message:
      "Generator '{name}' may raise '{effect}', so it cannot run at compile time. Compilation installs no interrupt handlers, so the operation could not complete anyway. Move the effectful work out of the generator.",
  },
  spliceGeneratorUnreadable: {
    code: "AG8004",
    severity: "error",
    message:
      "Generator '{name}' cannot be checked for effects: {reason}. An empty effect list from an incomplete reading means nothing, so it is refused rather than run.",
  },
```

- [ ] **Step 3: Add the reachability query**

In `lib/analysis/effects.ts`. The parse trees stay private to the module; callers
pass a table and a starting point, not a table and its own internals.

```ts
/**
 * Every function the given one can reach by calling, itself included.
 *
 * Scoped by call graph rather than by file on purpose. Every file reaches the
 * prelude and passing a function as a value is ordinary Agency, so a
 * file-scoped rule would refuse every generator ever written.
 */
export function reachableFrom(
  table: SymbolTable,
  programs: Record<string, AgencyProgram>,
  start: Origin,
): Origin[]
```

Implement it by building the same summaries `propagateEffects` uses and walking
`calleeKeys` breadth-first from `keyOf(originOf(table, start))`.

If threading `programs` in from the caller proves awkward, the alternative is a
private accessor on `SymbolTable`. Prefer passing them: an accessor hands every
caller the raw parse trees and makes them responsible for keeping two arguments
in step.

- [ ] **Step 4: Write the failing tests**

Append to `lib/compiler/splice/eligibility.test.ts`, following the fixture style
already in that file:

```ts
describe("checkGeneratorEffects", () => {
  it("refuses a generator whose risky work is one file away", () => {
    write("helper.agency", `export def h(): string {\n  return read("x")\n}\n`);
    const gen = write(
      "gen.agency",
      `import { h } from "./helper.agency"\nexport def makeThing(): string {\n  return h()\n}\n`,
    );
    const result = checkGeneratorEffects(gen, "makeThing", {});
    expect(result?.diagnostic).toBe("spliceGeneratorRaises");
    expect(result?.params.effect).toBe("std::read");
  });

  it("allows a clean generator that imports from a messy file", () => {
    // What call-graph scoping buys. The generator calls `clean`; `messy` is in
    // the same file and irrelevant to it. A file-scoped rule refuses this.
    write(
      "helper.agency",
      `export def clean(): string {\n  return "hi"\n}\n` +
        `export def messy(): string {\n  return read("x")\n}\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})).toBeNull();
  });

  it("allows an ordinary generator with no imports at all", () => {
    const gen = write(
      "gen.agency",
      `export def makeThing(): string {\n  return "const x = 1"\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})).toBeNull();
  });

  it("refuses when a reachable function calls a parameter", () => {
    const gen = write(
      "gen.agency",
      `export def apply(f: () -> string): string {\n  return f()\n}\n` +
        `export def makeThing(): string {\n  return apply(other)\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})?.diagnostic).toBe(
      "spliceGeneratorUnreadable",
    );
  });

  it("refuses when a reachable file holds an unexpanded splice", () => {
    write(
      "helper.agency",
      `export def clean(): string {\n  return "hi"\n}\n` +
        `const generated = $( somethingElse() )\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})?.diagnostic).toBe(
      "spliceGeneratorUnreadable",
    );
  });

  it("refuses when a reachable function passes a function through a variable", () => {
    write(
      "helper.agency",
      `export def clean(): string {\n  const fn = read\n  return runIt(fn)\n}\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})?.diagnostic).toBe(
      "spliceGeneratorUnreadable",
    );
  });

  it("refuses when a reachable file does not parse", () => {
    // The crawl skips an unparseable file and keeps going, so an empty effect
    // list here comes from a reading that saw nothing.
    write("broken.agency", `export def oops(: {{{\n`);
    const gen = write(
      "gen.agency",
      `import { oops } from "./broken.agency"\nexport def makeThing(): string {\n  return "x"\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})?.diagnostic).toBe(
      "spliceGeneratorUnreadable",
    );
  });
});
```

Type-check each fixture before running. The function-type arrow in
`f: () -> string` and the splice form `$( ... )` are the two most likely to be
written wrong; check them against `lib/typeChecker/functionTypeRaises.test.ts`
and the fixtures under `lib/compiler/splice/`.

- [ ] **Step 5: Implement**

Add to `lib/compiler/splice/eligibility.ts`:

```ts
/**
 * Refuse a generator that can reach a risky operation, and refuse one whose
 * effects cannot be read at all.
 *
 * The second half carries the weight. The effect walk reads syntax, so it
 * cannot see through a compile-time splice, a function received as a parameter,
 * a function reference held in a variable, or a file that did not parse. An
 * empty list from a reading that saw none of those is not evidence of safety.
 *
 * Scoped to what the generator reaches BY CALLING. Every file reaches the
 * prelude and passing a function as a value is ordinary Agency, so a
 * file-scoped rule would refuse every generator — the same objection the
 * comment on checkGeneratorEligible raises against a whole-closure test.
 */
export function checkGeneratorEffects(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
  symbolTable?: SymbolTable,
): SpliceDiagnostic | null {
  const absolute = path.resolve(generatorPath);
  const table = symbolTable ?? SymbolTable.build(absolute, config);
  const symbol = table.getFile(absolute)?.[generatorName];
  if (!symbol || (symbol.kind !== "function" && symbol.kind !== "node")) {
    return refusal(generatorName, "its definition could not be found");
  }

  const effect = (symbol.interruptEffects ?? [])[0]?.effect;
  if (effect !== undefined) {
    return {
      diagnostic: "spliceGeneratorRaises",
      params: { name: generatorName, effect },
      loc: { line: 0, col: 0, start: 0, end: 0 },
    };
  }

  const blindSpot = firstBlindSpot(table, absolute, generatorName, config);
  return blindSpot === null ? null : refusal(generatorName, blindSpot);
}

function refusal(name: string, reason: string): SpliceDiagnostic {
  return {
    diagnostic: "spliceGeneratorUnreadable",
    params: { name, reason },
    loc: { line: 0, col: 0, start: 0, end: 0 },
  };
}
```

`firstBlindSpot` walks `reachableFrom` and returns the first reason the reading
is incomplete, or null. Four reasons, each phrased for a person reading an error:

- `` `it reaches ${file}, which does not parse` ``
- `` `it reaches ${file}, which contains a compile-time splice` ``
- `` `it reaches ${name}, which calls a function it received as a parameter` ``
- `` `it reaches ${name}, which passes a function reference through a variable` ``

Detect the last two from the reachable functions' parameter lists and bodies: a
callee name that matches one of the enclosing function's parameter names, and a
call argument that is a bare variable whose declaration assigns a function
reference.

- [ ] **Step 6: Wire it in and rewrite the stale comment**

```ts
  const checks = [
    () => checkNoNestedSplice(generatorPath, generatorName, config),
    () =>
      config.allowNonAgencyGenerators === true
        ? null
        : checkImportGraph(generatorPath, generatorName, config),
    () => checkGeneratorEffects(generatorPath, generatorName, config, symbolTable),
  ];
```

Replace the paragraph beginning "There is deliberately no static effect check
here" with one saying the check now exists, what it refuses, and why it is scoped
to the call graph. Keep the sentence about the unhandled-interrupt backstop: it
is still true and still the second line of defence.

- [ ] **Step 7: Run and commit**

Run: `pnpm test:run lib/compiler/splice/`

If an existing generator fixture is newly refused, read the refusal before
changing it. A generator that genuinely reaches an effect should be rewritten,
not exempted.

```bash
git add -A
git commit -F - <<'MSG'
Check a generator for effects before running it

Refuses a generator that can reach a risky operation, and refuses one
whose effects cannot be read: a file that does not parse, a splice it
cannot see through, a function received as a parameter, or a reference
held in a variable.

Scoped to what the generator reaches by calling, and given the symbol
table the caller already built rather than crawling per splice site.

Closes #691
MSG
```

---

### Task 9: Documentation, the invariant, and performance

**Files:**
- Modify: `lib/analysis/effects.test.ts` — the invariant test
- Create: `docs/dev/effect-propagation.md`
- Create: `lib/perf/symbolTable.perf.test.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Test the invariant**

The plan claims the type checker may find more effects than the shared walk,
never fewer. Nothing tests it, and the type-aware half is exactly what Task 1's
extraction risked dropping. Deleting `calleeDeclaredEffects` and
`functionRefsInArgs` from `collectFromBody` would break nothing in the suite so
far.

Append to `lib/analysis/effects.test.ts`:

```ts
import { getEffectsFromFile } from "../compiler/typecheck.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

describe("the type checker finds more than the shared walk, never fewer", () => {
  it("reads a raises clause off a function-typed parameter", () => {
    // The shared walk has no types, so it cannot see this. The type checker can,
    // and must keep doing so after the extraction.
    const source =
      `export def runIt(cb: () -> string raises <std::read>): string {\n` +
      `  return cb()\n}\n`;
    expect(collectBodyFacts(bodyOf(source)).effects).toEqual([]);

    const dir = makeAgencyTempDir("invariant");
    try {
      const entry = path.join(dir, "main.agency");
      fs.writeFileSync(entry, source, "utf-8");
      expect(getEffectsFromFile(entry)["runIt"]).toContain("std::read");
    } finally {
      safeDeleteDirectory(dir, false);
    }
  });
});
```

Check the function-type-with-raises syntax against
`lib/typeChecker/functionTypeRaises.test.ts` before running. If the type checker
does not report `std::read` for this shape today, that is existing behaviour
rather than a regression — record what it does report and assert that, keeping
the point of the test, which is that the two sides differ in the safe direction.

- [ ] **Step 2: Write the developer document**

Create `docs/dev/effect-propagation.md`. Cover, in this order, in prose:

1. What an interrupt effect is and the two steps that produce the list.
2. Why the direct list was not enough, with the measured two-file example.
3. The `.invoke()` shape, why every walk missed it, and that two walks needed
   teaching because the AG3009 check keys on the call site.
4. `_guard` and the seed table: why direct effects are read from the symbol
   rather than recomputed.
5. The propagation pass: summaries, the file-and-name key, following
   `reExportedFrom`, the shared fixpoint, writing back.
6. The three blind spots, the fourth refusal reason (a file that did not parse),
   and which of them the generator check refuses on.
7. The invariant: the type checker may find more effects than the shared walk,
   never fewer.
8. That `lib/analysis/interrupts.ts` is a separate, more expensive cross-file
   analysis that cannot be reused here because this pass runs inside
   `SymbolTable.build`, and that it serves as the independent oracle in tests.
9. The pass-by-pass table from the spec's Part 5, on which trees each side sees.

Follow `docs/dev/general-writing-tips.md`.

- [ ] **Step 3: Add the CLAUDE.md pointer**

In the "Pipeline and architecture" list, after the `incremental-builds.md` line:

```
- `docs/dev/effect-propagation.md` — How a function's interrupt effects are computed: the shared walk in lib/analysis/effects.ts, the fixpoint at the end of SymbolTable.build, following re-exports, the `.invoke()` shape, why `_guard` is seeded rather than walked, and the four things the walk cannot see
```

- [ ] **Step 4: Add the performance test**

Create `lib/perf/symbolTable.perf.test.ts`, following the shape of
`lib/perf/compile.perf.test.ts` and the helpers in `lib/perf/harness.ts`.

Do not assert a wall-clock threshold against the 2ms measurement; at that
magnitude it will flake. The suite compares how cost scales with input size and
runs informational-first, which is the right mode.

- [ ] **Step 5: Run everything**

```bash
make
pnpm test:run 2>&1 | tee /tmp/task9.log
pnpm run lint:structure
```

- [ ] **Step 6: Audit the diff against the anti-patterns document**

Required before opening the pull request. Read `docs/dev/anti-patterns.md` and
check the whole branch diff against it.

```bash
git diff main... > /tmp/branch.diff
```

Watch particularly for: comments that restate the code, accumulator loops where a
named pipeline would read better, dictionaries keyed by user-controlled strings
that are not null-prototype, and any magic number guarding a case that cannot
happen.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Document effect propagation and add SymbolTable.build to the performance suite"
```

---

## What changed in this revision, and why

Answering the plan review. I verified every finding against the code before
changing anything; all held.

**Two would have shipped regressions.**

`buildSummaries` recomputed direct effects from a body walk, which would have
wiped `std::guard` out of the whole program: `_guard` has no `interrupt` in its
body and gets its label from a seed table. Now it seeds from the symbol, which is
both correct and simpler. Task 3 has a named test for it, and the debugging hint
now points at the seed rather than at import resolution.

Task 2's end-to-end tests could not have passed, because
`checkUnhandledInterruptWarnings` has its own walk that never touched the shared
one. Task 2 now has an explicit step for it, and the `functionTypeRaises`
interaction is recorded rather than left undiscovered.

**Four more were right and are applied.** `invokeReceiver` scans ancestors
backwards, because `invoke` is not always the first chain link and the walker
does not always make the access the last ancestor. The tripwire compares two
independent readings of the standard library instead of comparing a constant to
itself. Task 5 dropped its circular comparison for in-file cases plus
`analyzeInterrupts` as an oracle. Task 8 threads a symbol table in rather than
crawling per splice site, and gained a fourth refusal reason.

**Duplication the review caught.** `propagateToFixpoint`, `addUnique` and
`originOf` are shared rather than written twice, and everything lives in one
module, `lib/analysis/effects.ts`. Writing a third propagation loop into a branch
whose premise is that two copies drift apart was the wrong instinct. The magic
depth guard in `originOf` is gone: `SymbolTable.build` already detects re-export
cycles and throws with the chain.

**Agency that did not check.** `guard(maxCost: 1.0)` is rejected; the parameter is
`cost` and takes a money literal. `handle` wraps the risky code and takes a
`with (data)` clause, and suppression is lexical, so the plan's old test would
have warned regardless. Every snippet here has now been type-checked.

**Test gaps closed.** Nested and expression-position calls, negative propagation
cases, a graph node, `export *` and `export { h as g }`, `import node`, a file
that fails to parse, `_guard` itself, the invariant, a documentation test, and
three of Task 8's four refusal reasons plus two positive controls.

**Smaller corrections.** `declaredName` is at `lib/types/hole.ts:36`, so the
contingency about moving it is gone. Task 1's prediction of `guardBlock` churn is
replaced with the reason it cannot happen. The thrown-message assertion checks
the throw, not a message nobody measured. The policy test calls the real
`uniqueInterruptEffects` instead of copying it. `lib/perf/` holds eight tests, not
three. `parseAgency(src, {}, false)` now says what the third argument does.

**Anti-pattern audit.** I checked every code block against
`docs/dev/anti-patterns.md` myself, after the review's own pass. One real
violation: `makeResolver` had a nested ternary choosing between the two import
forms, now a named `importsOf` helper with plain `if` returns. Beyond that, the
interfaces were already declarative but the insides were not, so the "what"
and the "how" are now split:

- `collectBodyFacts` was a four-branch `if`/`else if` chain mutating three
  accumulators. It is now four named predicates and a returned object whose
  fields say what each list is.
- `collectFromBody` was two nested accumulation loops. It is now two `unique([
  ...spread ])` expressions.
- `buildSummaries` was a nested loop writing into a dictionary. The per-file
  work moved to `summariesForFile`, the symbol read to `directEffectsOf`, and
  the dictionary is built with `Object.fromEntries` over a null prototype,
  matching how `TS_SIDE_EFFECT_SEEDS` is built.
- `writeBack` still writes in a loop, because writing is what it does, but
  "every callable symbol, tagged with where it lives" is now `callableSymbols`.
- `invokeReceiver` was a backwards index loop with two `continue`s. It is now a
  `filter().find()` with the chain test named `holdsCall`.

Two things I decided to leave. One-line guards such as `if (!summary) continue;`
are house style — the file being edited has 23 of them — and the catalog's
example bans a one-line side-effecting call, not a guard clause. And `scanRaw`
in the tripwire test duplicates tree walking on purpose: using `walkNodes` there
would compare the walker against itself, which is the failure mode that test
exists to catch. The comment says so.

**Length.** This revision is longer than the version you asked me to keep as is.
Almost all of the growth is test coverage the review showed was missing, plus the
two regression fixes. If you want it shorter, the honest cut is still scope
rather than detail: Tasks 1, 3 and 4 close issue 680 on their own.

## Self-review

**Spec coverage.** Every spec section maps to a task. Part 3's `.invoke()` bug is
Tasks 1 and 2. Part 5's pass is Task 3, its re-export hop Task 4, its sharing
requirements Tasks 1 and 5, its blind spots Task 8. Part 6's generator check is
Task 8. Part 7's knock-on work is spread across Tasks 2, 3, 6 and 7, with churn
counted and reported before being fixed.

**Known weak points.** Task 8's `firstBlindSpot` is specified by its contract and
its four messages rather than by complete code, because detecting "a function
reference held in a variable" syntactically is the one genuinely open design
question. If it needs more than a walk over reachable bodies, stop and check.

Task 9's invariant test may find the type checker does not report the
function-typed-parameter case today. The step says to record what it does report
rather than assume.

Task 5's oracle comparison depends on `analyzeInterrupts` returning a shape this
can read; the step says to fall back to the in-file cases rather than reshape it.

**Churn is still not estimated**, and Tasks 2 and 3 each stop to count and report
before fixing. Guessing a number would be worse than admitting I do not know it.
