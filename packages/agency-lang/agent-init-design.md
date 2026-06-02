# Agent initialization design

## Problem statement

Agency promises that every run of an agent gets isolated state (each call to a node sees its own copy of globals). It also offers `static` vars that should initialize once per process and be shared across runs. The execution model docs describe these as if they're clean two-phase semantics, but the actual runtime is lazy in a way that creates several user-visible problems:

1. **Cross-module static dependencies silently produce `undefined`.** Example: foo.agency does `static const fooStatic = barStatic + "!"`, importing `barStatic` from bar.agency. Confirmed empirically that this prints `result1 = undefined!` — bar's static init never ran before foo's read it.
2. **Top-level bare function calls fire at unpredictable times.** A `logEvent("startup")` at the top of foo.agency runs whenever foo's `__initializeGlobals` first runs, not at any well-defined moment. If foo is the entry module, that's per-run; if foo is imported by another module, it's lazily on first call.
3. **There's no way to tell what runs when.** Side effects buried in imported modules can fire at startup or per-run, and users have no tool to inspect the order.
4. **There's no syntactic distinction between "run once" and "run every run" for bare statements.** Statics-as-declarations have it (`static const x = ...`); bare statements don't.

What we want:
- Predictable, well-defined "phase A" (once per process) and "phase B" (every run) semantics.
- Correct cross-module ordering, including when one module's static depends on another's.
- Compile-time errors for the cases we can catch statically; loud runtime errors for the ones we can't.
- A tool to see exactly what runs in each phase.
- Allow important patterns like cyclic imports for `goto` routing.

## Final design

### 1. Two-phase model

Conceptually two phases that span the entire import tree:

| Phase | When | What runs |
|---|---|---|
| **A — startup** | Once per process, before the first agent run | All `static const x = ...` declarations + all `static foo()` bare statements |
| **B — per-run** | Before every agent run's entry node body | All non-static `const`/`let` top-level decls + all non-static bare statements |

### 2. `static` keyword for bare statements

Today `static` applies only to `const` declarations. Extend it to bare top-level statements:

```agency
static logEvent("process startup")  // runs once per process
logEvent("agent run started")        // runs at the start of every run
```

This mirrors `static const` and makes intent visible at the source.

### 3. Per-variable topological sort across all modules

Rather than ordering modules by import edges (which deadlocks on cycles) or trying to walk call graphs (unsound in Agency due to dynamic dispatch), order **individual top-level declarations** by their direct free-variable references.

For each top-level declaration / bare statement across every module reachable from the entry file:
- Build a node in a dep graph keyed by `(moduleId, name)`.
- Edges = direct free-variable references in the initializer (or in the statement's expression).

Then:
- Run topological sort on this graph.
- If sort succeeds → emit a centralized init function (one per phase) that walks the sorted list and initializes each var / runs each statement in order.
- If sort fails (cycle in the variable graph) → **compile error** pointing at the offending pair of declarations.

```ts
// generated, one per compilation
async function __initializeAllStatics(ctx) {
  await initVar("bar.agency", "barStatic");
  await initVar("foo.agency", "fooStatic");
  await runStmt("foo.agency", 4 /* line */);  // static logEvent("startup")
}
async function __initializeAllGlobals(ctx) {
  // similar
}
```

### 4. Cyclic imports allowed; cyclic state forbidden

File-level import cycles are **permitted**. The router → code → router pattern is essential. The check is at the variable level, not the file level.

```
✅ foo.agency imports bar.agency, bar.agency imports foo.agency (cycle in import graph)
❌ foo.fooStatic depends on bar.barStatic AND bar.barStatic depends on foo.fooStatic (cycle in variable graph)
```

Because the dep graph operates on individual vars, a cyclic import pair with no shared top-level state has an empty (or fully sortable) variable graph and just works.

### 5. Runtime "read before init" trap

Static vars are currently plain `let` declarations that read as `undefined` before assignment. Wrap them so that reads before the corresponding `__initializeStatic` step throws a clear error:

```
RuntimeError: Tried to read `barStatic` from bar.agency before its static
initializer ran. This usually means a function called during static init
indirectly reads a static that hasn't been initialized yet. Likely a
cycle through function calls — break the cycle or move the read out of
the static initializer.
```

This is the safety net for the case static analysis can't soundly handle: a static initializer that calls a function which transitively reads another static. Direct deps are caught by the topsort; indirect-through-function-call deps fail loudly at runtime.

### 6. Keep the lazy `isInitialized` guards

Each function/node still has the `if (!__ctx.globals.isInitialized(moduleId)) await __initializeGlobals(__ctx)` guard at entry. With centralized init this should rarely fire (init runs upfront), but it remains as a safety net for cases where init was somehow skipped (direct stdlib calls, manual ctx manipulation, etc.).

### 7. `agency explain-init`

A new CLI command that prints the resolved init plan:

```
$ agency explain-init router.agency

Phase A (once per process):
  bar.agency:1   static const barStatic = "hello"
  foo.agency:2   static const fooStatic = barStatic + "!"
  foo.agency:5   static notifyOnStartup()

Phase B (every run):
  router.agency:3   const requestLog = []
  router.agency:6   logEvent("agent run started")

Variable dependency graph:
  bar.barStatic       (no deps)
  foo.fooStatic       depends on: bar.barStatic
  router.requestLog   (no deps)

Cyclic imports detected (allowed):
  router.agency ⇄ code.agency
  router.agency ⇄ research.agency
```

This is the answer to "I have no idea what's running at startup." It's also load-bearing for the design: bare top-level statements are only acceptable if users can easily see them.

### Implementation summary

1. Extend parser to accept `static` prefix on top-level expression statements.
2. Build the per-variable dep graph across the entry's full import closure.
3. Run topological sort; error on cycles in the variable graph.
4. Emit a single `__initializeAllStatics` and `__initializeAllGlobals` per compilation in the entry file (other files in the closure get re-exports of these so any file can be an entry point).
5. Replace plain static `let` decls with a getter that throws on read-before-init.
6. Add `agency explain-init` CLI command.
7. Emit phase-start / phase-end events into the trace log.

## Alternatives considered

### Alt 1: Today's lazy behavior (the status quo)

**What it does:** `__initializeGlobals` runs lazily for each module the first time one of its functions is called. Static vars init at the same time. Cross-module deps are not ordered.

**Why it's not good enough:** The motivating problems above. Specifically, the `fooStatic = barStatic + "!"` case produces `"undefined!"` silently. Top-level bare calls fire at unpredictable times.

### Alt 2: Restrict initialization to declarations only (no bare top-level statements)

**The idea:** Disallow bare `foo()` at module top level. Force side effects into nodes or into expressions inside declarations. Simplifies the model — no "phase A vs B" distinction for statements, no `static foo()` keyword, fewer surprises.

**Why it fails:** Trivially circumvented by `const _ = myToplevelFuncCall()`. The workaround:
- is one extra word to type
- obscures intent (reads like dead code)
- doesn't actually prevent the side effect

A restriction that's bypassable in one keystroke isn't a real restriction; it just gives users false comfort. Better to allow bare statements explicitly with clear semantics and good observability.

### Alt 3: Ban all circular imports as a hard error

**The idea:** Cycles are the source of most init-order pain. Just outlaw them. Tarjan SCC pass; any non-singleton SCC → compile error. Forces users into a clean DAG.

**Why it fails:** Breaks essential agent patterns. Specifically, the router pattern:

```agency
// router.agency
import { code } from "code.agency";
import { research } from "research.agency";
node router() {
  const userMsg = input();
  const category = llm(`Categorize "${userMsg}" as "code" or "research"`);
  if (category === "code")     { goto code(userMsg); }
  else if (category === "research") { goto research(userMsg); }
}

// code.agency
import { router } from "router.agency";
node code(userMsg) {
  const codeResult = llm(`Write code for: ${userMsg}`);
  output(codeResult);
  goto router();  // ← cyclic dep is real and useful
}

// research.agency
import { router } from "router.agency";
node research(userMsg) {
  const researchResult = llm(`Research: ${userMsg}`);
  output(researchResult);
  goto router();
}
```

This is the canonical multi-node router. Banning cycles forces users to either jam everything into one file or invent registry / dynamic-dispatch hacks. Both are worse than allowing the cycle.

The key insight: the cycle here is in `goto` transitions at runtime, not in top-level state initialization. The init-order problem only arises if files share **state**, not if they share node-graph membership.

### Alt 4: Deep static call-graph analysis

**The idea:** For each static initializer, transitively walk every function it calls (and every function those call, etc.) to compute the full set of statics it could read. Use that to drive topological sort with perfect precision, even through function indirection.

**Why it fails:** Agency is too dynamic to analyze soundly. The unanalyzable patterns include:
- Tools passed to LLMs (`llm("...", tools: [foo, bar])`) — runtime dispatches arbitrary one
- Callback registrations and `handle` blocks
- Partial function application (`someFunc.partial(...)`)
- `runBatch` and other higher-order primitives
- Function refs stored in arbitrary data structures

The sound conservative response to "I can't tell which function this calls" is "assume it could call any function in scope" — at which point your dep sets collapse to "everything depends on everything," giving you no benefit over the simpler module cascade.

Specific motivating examples this can't handle:

```agency
// PFA case
import { barStatic } from "bar.agency"
static const fooStatic = someFunc.partial(param: barStatic)

// Indirect-through-call case
import { qux } from "qux.agency";  // qux.agency reads barStatic internally
static const fooStatic = qux() + "!"
```

Even if foo.agency and bar.agency form a cycle, the static analysis can't tell that `qux()` reads `barStatic`. The check passes; the bug ships.

### Alt 5: File-level cascade via await chains

**The idea:** Each module's `__initializeStatic` does `await bar.__initializeStatic()` for each import, then runs its own body. The await chain implicitly implements topological sort.

**Why it fails:** Deadlocks on cycles. foo's promise pends awaiting bar's promise, which pends awaiting foo's promise → both stuck forever.

### Alt 6: File-level cascade + skip intra-SCC imports

**The idea:** Patch Alt 5 by computing SCCs first; emit awaits only for imports outside the current module's SCC. Cyclic imports get no cascade await; rely on lazy `isInitialized` guards instead.

**Why it's not great:** Works, but the mechanism is unprincipled — "we award correctness through one mechanism, and patch over the residual edge case with another." Also the granularity is wrong: we're checking SCCs at the file level when the actual constraint is on individual variables. Two files might have one cyclic var pair and dozens of fine ones; this approach can't distinguish.

The chosen design (per-variable topsort) does the same work with a cleaner unit of analysis.

### Alt 7: Per-variable topsort with full call-graph analysis

**The idea:** Combine the chosen design with Alt 4's call-graph analysis to get perfect static checking even through function indirection.

**Why it fails:** Same as Alt 4 — Agency's dynamism makes call-graph analysis unsound. We get the same conservative-analysis collapse, which would over-eagerly reject programs that actually work.

The chosen design uses the runtime "read before init" trap as the principled fallback. Cheaper to implement, gives loud errors with stack traces pointing at the actual offending read, and doesn't reject programs that don't actually have the problem.

## Worked examples

### Example 1: The original motivating bug (silent undefined)

```agency
// bar.agency
static const barStatic = "hello"

// foo.agency
import { barStatic } from "./bar.agency";
static const fooStatic = barStatic + "!"

node foo() { return fooStatic; }
```

**Today:** prints `"undefined!"` because foo's static body runs before bar's.

**Under new design:** Variable graph has `foo.fooStatic → bar.barStatic`. Topsort gives `[bar.barStatic, foo.fooStatic]`. Init runs in that order. `foo()` returns `"hello!"` correctly.

### Example 2: The function-call indirection

```agency
// bar.agency
static const barStatic = "hello"
def getBarStatic() { return barStatic; }

// foo.agency
import { getBarStatic } from "./bar.agency";
static const fooStatic = getBarStatic() + "!"
```

**Direct free vars of fooStatic:** `{ getBarStatic }`. `getBarStatic` is a `def`, not a value var — no runtime init needed. So foo.fooStatic has no value-dep edges.

**But this is acyclic at the file level** (foo → bar, bar doesn't → foo), and topsort over the *file* import DAG still gives `bar before foo` as a fallback ordering for vars without explicit deps. So bar's `barStatic` initializes first, foo's `fooStatic` calls `getBarStatic()` which reads the now-set `barStatic`. Works correctly.

**Note:** The implementation should use the file-import DAG as a tiebreaker for vars whose dep edges don't fully order them. This catches the common case of indirect deps within an acyclic file graph without needing call-graph analysis.

### Example 3: Indirect dep across a cycle (the residual unsound case)

```agency
// foo.agency
import { qux } from "qux.agency";
static const fooStatic = qux() + "!"
node foo() { return fooStatic; }

// bar.agency
import { somethingFromFoo } from "foo.agency";   // creates foo ↔ bar cycle
static const barStatic = "hello"

// qux.agency (not in the cycle)
import { barStatic } from "bar.agency";
def qux() { return barStatic; }
```

`fooStatic`'s direct free vars are `{ qux }`. Topsort doesn't see the indirect dep on `barStatic`. Depending on which module's init runs first within the foo ↔ bar SCC, `qux()` might read `barStatic` before bar's init has run.

**Under new design:** Per-variable topsort can't detect this statically. But the runtime "read before init" trap fires when `qux()` tries to read `barStatic` before bar's init completed:

```
RuntimeError: Tried to read `barStatic` from bar.agency before its static
initializer ran. ...
```

Loud, actionable error pointing at the actual problem, not silent `undefined`.

### Example 4: The router pattern (cyclic imports, no state cycle)

```agency
// router.agency: imports code, research
// code.agency: imports router
// research.agency: imports router
```

None of these files have top-level state. The variable graph is empty. Topsort trivially succeeds. The cyclic imports are completely irrelevant to init — they only matter for runtime `goto` dispatch, which uses the existing graph runtime.

`agency explain-init router.agency` would show:

```
Phase A: (no static decls)
Phase B: (no top-level decls)
Cyclic imports detected (allowed):
  router.agency ⇄ code.agency
  router.agency ⇄ research.agency
```

Pattern works without changes.

### Example 5: Direct state cycle (must be rejected)

```agency
// foo.agency
import { barStatic } from "./bar.agency"
static const fooStatic = barStatic + "!"

// bar.agency
import { fooStatic } from "./foo.agency"
static const barStatic = fooStatic + "?"
```

Variable graph has `foo.fooStatic → bar.barStatic` AND `bar.barStatic → foo.fooStatic`. Topsort fails. **Compile error**:

```
Error: Circular static dependency
  foo.fooStatic (foo.agency:2) depends on bar.barStatic
  bar.barStatic (bar.agency:2) depends on foo.fooStatic

Static vars cannot depend on each other in a cycle. Break the cycle by
extracting one of these into a third file, or compute one from a literal
instead of the other static.
```

### Example 6: Top-level bare call (per-run vs once)

```agency
// foo.agency
static logEvent("process startup")    // Phase A
logEvent("agent run started")          // Phase B

node foo() { ... }
```

Running `foo()` three times in one process produces:

```
process startup
agent run started   ← run 1
agent run started   ← run 2
agent run started   ← run 3
```

`static logEvent(...)` fires exactly once; the unprefixed one fires per run. `agency explain-init` shows both clearly.

### Example 7: The `const _ = ...` workaround (irrelevant under new design)

```agency
const _ = myToplevelFuncCall()
```

Under the chosen design, this is just a global declaration with a side-effecting initializer. It runs in Phase B every run, same as a bare `myToplevelFuncCall()` would. There's no need for the workaround because bare statements are first-class.

Users who actually want the once-per-process semantics write `static const _ = myToplevelFuncCall()` or, more naturally, `static myToplevelFuncCall()`.

### Example 8: Concurrent web server requests (motivating example from execution-model.md)

Five concurrent calls to a node, each getting state isolation, each getting their own initialized globals. This continues to work — Phase B runs at the start of each call against its own execCtx, so each call gets its own freshly initialized globals.

Phase A statics are shared across all calls (they're the same value per process); Phase B globals are per-call. Same semantics as today; just with deterministic, ordered init across the whole import tree instead of lazy.

## Open questions / future considerations

1. **What's banned inside `static` initializers?** Probably: `llm()`, `interrupt()`, anything that needs a per-run execCtx. Should error at compile time with a clear message.
2. **What about `static` mutation?** Statics are deep-frozen today. A `static foo()` that tries to mutate a static should fail loudly (it would anyway due to deepFreeze).
3. **What about `static` reading non-static globals?** Should be a compile error — Phase A runs before Phase B; the global doesn't exist yet.
4. **Re-exports of statics across cycles** — re-exports are still imports for dep-graph purposes; the per-var topsort handles them naturally.
5. **TS imports with side effects** — `import "./foo.js"` runs at JS module-load time, outside our control. Document that statics from TS modules are uncontrolled and may not participate in Phase A ordering.
6. **Lint warning** for unprefixed bare top-level statements? Could nudge users to think "did you mean `static`?" Optional; opt-in.
7. **Performance for very large import closures** — the topsort is O(V+E) where V is the number of top-level decls and E is direct-free-var edges. Negligible for any realistic agent. The Phase A initialization itself is paid once per process; Phase B is paid once per run (same total work as today, just deterministic order).
