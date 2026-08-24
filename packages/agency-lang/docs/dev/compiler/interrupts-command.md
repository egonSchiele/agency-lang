# `agency interrupts` — Static Handler-Set Analysis

## What it does

`agency interrupts <file>` statically prints, for every `interruptStatement` reachable in the import tree rooted at `<file>`, the set of `handle` blocks that could enclose it on the active stack.

The motivating debugging story: you wrap a call in `with approve` expecting auto-approval, but the interrupt still surfaces to the user. The command lists every handler that could intercept the interrupt — your `with approve` plus anything else higher on the stack. The "anything else" is the culprit.

## CLI surface

```
agency interrupts <file>
```

- One positional arg, no flags in v1. The command is registered `hidden`
  in `scripts/agency.ts`, so it does not appear in `agency --help`.
- Plain text output to stdout. Errors (file not found, parse errors) go to stderr with exit code 1.
- No color, no JSON, no policy filtering. See "Out of scope" below.

Example output:

```
src/agent.agency:42  interrupt of effect std::read
  Possible enclosing handlers:
    handle block at src/main.agency:10
    handle via fn approveReads at src/main.agency:18

src/agent.agency:67  interrupt
  Possible enclosing handlers:
    (none)
```

- The `of effect <Effect>` clause is omitted when the site's `effect` is `"unknown"`, which is the bare `interrupt(...)` form.
- Inline handlers render as `handle block at <file>:<line>`.
- `functionRef` handlers render as `handle via fn <name> at <file>:<line>`.
- `(none)` appears under any site with an empty handler set.
- Sites are sorted by `(file, line)`; handlers within a site are sorted the same way.

## Pipeline overview

```diagram
╭─────────────────────╮     ╭──────────────────────────╮
│ parse + SymbolTable │────▶│ buildCompilationUnit     │
╰─────────────────────╯     │ (per file)               │
                            ╰─────────┬────────────────╯
                                      ▼
                            ╭──────────────────────────╮
                            │ typeCheck                │
                            │  → interruptCallGraph    │
                            ╰─────────┬────────────────╯
                                      ▼
                            ╭──────────────────────────╮
                            │ analyzeInterrupts        │
                            │  worklist fixed-point    │
                            ╰─────────┬────────────────╯
                                      ▼
                            ╭──────────────────────────╮
                            │ renderInterrupts → stdout│
                            ╰──────────────────────────╯
```

Three layers, three files:

| Layer | Module | Responsibility |
|-------|--------|----------------|
| Typechecker call graph | [lib/typeChecker/interruptAnalysis.ts](../../../lib/typeChecker/interruptAnalysis.ts) | `buildInterruptCallGraph(scopes, ctx)` records, per function, every call edge and every `interruptStatement` along with its lexically enclosing `handle` blocks. Purely structural, with no propagation. |
| Handler-set analyzer | [lib/analysis/interrupts.ts](../../../lib/analysis/interrupts.ts) | `analyzeInterrupts(rootFile, config)` runs the typechecker on every reachable `.agency` file, merges the call graphs, and runs a worklist fixed-point to compute per-site handler sets. |
| CLI shim | [lib/cli/interrupts.ts](../../../lib/cli/interrupts.ts) | `renderInterrupts(result)` plus the Commander `action` that reads the file and writes stdout. |

## Layer 1: the interrupt call graph

`buildInterruptCallGraph` walks `scopes` (the same `ScopeInfo[]` the rest of the typechecker uses). For each non-top-level scope it visits every node and records:

- **Interrupt sites.** For every `interruptStatement` node, store the AST node plus the list of `handle` blocks in `ancestors` that lexically enclose it.
- **Call edges.** For every `functionCall`, store the callee name plus the same enclosing-handlers list. Function references appearing as arguments of any call, such as `llm(..., { tools: [deploy] })`, are added as synthetic call edges via `functionRefsInArgs`. That is the same code path the transitive-effects analyzer uses. `gotoStatement` targets are also recorded as call edges.

Every edge also carries a `calleeKey`, the callee's `${file}:${name}` `QualifiedKey`. `makeCalleeResolver` produces it: a locally defined name resolves against the current file, an imported name resolves to its origin file and original name, and anything else falls back to the current file so the edge is at least keyed consistently.

Each handler is a `TaggedHandler = { block: HandleBlock; file: string }`. The file tag is the file the *enclosing function* lives in, looked up via `SymbolTable.findFileForName(name)`. This is essential because `SourceLocation` carries only `{line, col, start, end}` — there is no `loc.file`, so the file has to be threaded explicitly through every level of the analysis.

The output:

```ts
type QualifiedKey = string; // `${file}:${name}`
type CallEdge = {
  calleeName: string;
  calleeKey: QualifiedKey;
  enclosingHandlers: TaggedHandler[];
};
type CallGraphFunction = {
  name: string;
  file: string;
  callEdges: CallEdge[];
  interruptSites: {
    site: InterruptStatement;
    file: string;
    enclosingHandlers: TaggedHandler[];
  }[];
};
type InterruptCallGraph = Record<QualifiedKey, CallGraphFunction>;
```

This lives on `TypeCheckResult.interruptCallGraph` alongside the existing `interruptEffectsByFunction`. The two analyses are intentionally independent. This one records exact handler identities, the other propagates effect sets.

## Layer 2: the handler-set analyzer

`analyzeInterrupts(rootFile, config)` is a five-phase declarative pipeline:

```ts
const cg               = loadCallGraph(rootFile, config);
const sites            = collectAllSites(cg);
const reachableHandlers = propagateHandlers(cg);
const perSite          = unionAcrossEntries(reachableHandlers, collectEntries(cg));
return buildResult(sites, perSite);
```

### Phase 1: load (multi-file)

The typechecker only knows about one file's local definitions at a time — `scopes` is built from the entry file's `CompilationUnit.functionDefinitions` and `graphNodes`. Imported functions appear as signatures in `importedFunctions` but their **bodies** are not in `scopes`, so they contribute zero interrupt sites and zero call edges when only the entry file is typechecked.

To analyze the whole import closure, `loadCallGraph` builds the symbol table once and then runs the typechecker on **every** `.agency` file in `symbolTable.filePaths()`, calling `Object.assign(merged, cg)` to merge the per-file call graphs into one. The merge is collision-free because every key is a `QualifiedKey` of the form `${file}:${name}`. Two files declaring the same top-level name produce distinct entries.

`analyzeOneFile` parses the file, expands splices, and lifts callback blocks before building the compilation unit. Splice expansion is best-effort here: if a splice fails to expand, the analysis runs over the unexpanded program rather than refusing to report anything.

### Phase 2: collect sites

`collectAllSites(cg)` flattens every `interruptSite` from every function into a `Map<SiteId, SiteRecord>`, keyed by `${file}:${line}:${col}`. Multiple paths reaching the same site collapse into one map entry.

### Phase 3: worklist fixed-point

This is the heart. For each function `f` and each site `s` reachable from `f`, we maintain the set of `handle` blocks that could be on the active stack when `s` is reached starting from `f`. Inner set keyed by `HandleBlock` object identity for dedup:

```ts
type HandlerSet = Map<unknown, TaggedHandler>;
type ReachableHandlers = Record<string, Record<SiteId, HandlerSet>>;
```

**Seed.** For each function with a direct `interruptStatement` site `s`, initialize `state[f][s] = handlers in f enclosing s`.

**Propagation rule.** For each call edge `f --call(H)--> g` (where `H` is the set of `handle` blocks in `f` enclosing the call):

```
for every site s in state[g]:
    state[f][s] ∪= state[g][s] ∪ H
```

**Growth detection.** A pass reports "grew" if any of the following changed:

- A *new* site key was added to `state[f]` (we previously didn't know `f` could reach `s`). This is critical: a chain like `main → a1 → shared` where `shared`'s site has no enclosing handlers in `a1` would never propagate if we only tracked handler-set-size growth. The empty handler set still *carries the site*.
- The handler set's size grew for an existing site.

This runs in `O(iterations × edges × sites)` with the fixed point bounded by the total number of (function, site) pairs — cycles add nothing once both sides converge.

### Phase 4: entry detection + union

An **entry** is every non-stdlib function or node in the merged call graph. The final per-site handler set is the union of `state[entry][s]` across every entry that reaches `s`.

`collectEntries` deliberately does *not* narrow entries to functions with no incoming call edges. That narrower definition drops mutually recursive groups, because every member has an incoming edge from inside the cycle. It also drops disconnected components whose external caller is not in the graph yet, and their interrupt sites would vanish from the report.

**Stdlib filter.** `isInStdlib(filePath, getStdlibDir())` in `lib/analysis/interrupts.ts` excludes stdlib functions from the entry set. Without it, every orphan stdlib function would count as an entry and contribute its own interrupt sites, which is noise. Stdlib functions remain valid *callees*. When reached from a user entry, their sites propagate normally and their handlers are included.

### Phase 5: build result

For each site (with a non-empty per-site map entry), produce a `SiteResult` and sort by `(file, line)`. Each handler is rendered into a `HandlerRef` with the right `shape`.

**Line numbers.** The parser stores `loc.line` as 0-indexed in the user's source. `toDisplayLine` adds 1 when producing the public `InterruptSite.line` and `HandlerRef.line`, so the rendered output uses the human convention where line 1 is the first line of the file. `parseAgency` already compensates for the template prelude it adds, via the per-parse `AGENCY_TEMPLATE_OFFSET`. See the `withLoc` comment above `AGENCY_TEMPLATE_OFFSET` in [lib/parsers/parsers.ts](../../../lib/parsers/parsers.ts).

## Layer 3: CLI

`renderInterrupts(result)` is a pure function: `AnalysisResult → string`. No I/O, easy to test. The CLI shim (`interruptsCmd`) calls `existsSync(file)`, runs the analyzer, writes `renderInterrupts(...)` to stdout, and handles errors by printing to stderr + `process.exit(1)`.

Registered in [scripts/agency.ts](../../../scripts/agency.ts) via Commander, with `{ hidden: true }`. There is a line for it in [lib/cli/help.ts](../../../lib/cli/help.ts), which is mostly inert because Commander auto-generates the visible help from each subcommand's `.description()`.

## File-path tracking

`SourceLocation` carries only `{line, col, start, end}`, never the file. Every layer that touches a site or handler has to carry the file explicitly:

- `SymbolTable.findFileForName(name)` resolves a top-level function/node name to its defining file.
- `ScopeInfo.file` is populated in `buildScopes` from the symbol-table lookup, threaded through `TypeCheckerContext.symbolTable` which itself comes from `CompilationUnit.symbolTable`.
- `CallGraphFunction.file` is taken from the scope's file when the call graph is built.
- `TaggedHandler.file` is set when handlers are collected per function, so the file survives the propagation hops in Phase 3.

The top-level scope (`name === "top-level"`) gets `file: ""` because it spans the whole compilation unit and no single file. It's skipped by `buildInterruptCallGraph`.

## Known limitations

These are all **call-graph fidelity** issues. The handler-set analysis itself is complete. What it cannot see is the call graph's missing edges.

### Function references through object properties

The analyzer extracts function-typed arguments via `synthType` + `functionNamesFromType`, which recurses into array/object/union types. But once a function reference passes through a variable with type `any` or `any[]`, the names are erased.

Example that **fails**:

```agency
static const codeTools: any[] = [foo, bar]  // erased to any[]

node main() {
  // route(...) eventually does llm({ tools: spec.tools }) inside
  // a stdlib function, several call hops away.
  route({ agents: { code: { tools: codeTools, ... } }, ... }, msg)
}
```

The call edge from `main` to `route` records no synthetic edges for `foo`/`bar`, because `codeTools` synthesizes to `any[]`. Even if it didn't, the analyzer would still need to track that `route`'s `config` parameter flows into `runOneTurnPrompt`'s `spec.tools` which flows into `llm({ tools: ... })` — full interprocedural data-flow.

**Workaround:** invoke tools inline at the `llm` call site, or accept the false negative.

**Long-term fix:** more precise typing for `static const` arrays of function refs (tuple-of-`functionRefType`), plus interprocedural tool-flow tracking. Doable but out of scope for v1.

### Handlers bound via a function-returned value

```agency
const handler = cliPolicyHandler(file: "policy.json", fields: ...)
handle { ... } with handler
```

`cliPolicyHandler` returns `_handler`, a function value. The analyzer sees `with handler` as a `functionRef` whose `functionName` is `"handler"`. But `"handler"` is a local variable, not a defined function, so the call graph has no entry keyed for it. The handler-body interrupts (`maybeLoad` → `parsePolicyFile` → `interrupt std::read`) are invisible.

This requires return-value-of-function-call escape analysis: tracking that `cliPolicyHandler(...)` returns the function value `_handler`. Agency's type system doesn't track this today.

**Workaround:** use the handler factory inline (`with cliPolicyHandler(...)`) if the callable syntax allows it, or document the binding so a human reader knows which function gets dispatched.

### Interrupts thrown directly from `.ts` / `.js` runtime code

Almost all stdlib interrupts are written as `interrupt std::foo(...)` in `stdlib/*.agency`, so they're visible. The handful raised from raw runtime code are invisible.

### Other indirect calls

The only indirect edges the analyzer resolves are function-typed arguments to a call and `gotoStatement` targets. Higher-order calls like `someArray.forEach(fn)` and stored-callback dispatch are ignored.

## Things explicitly out of scope (v1)

These are documented decisions, not bugs:

- **Handler-safety warnings.** The old `handlerBodyRaises` diagnostic (AG3010) is retired. Handler self-exclusion means the dispatcher skips the executing handler entry for its own raises, so raising inside a handler body is legal now.
- **Uncaught-interrupt warnings.** Already a typechecker diagnostic.
- **`--json` output, `--entry` flag, color/`NO_COLOR`, LSP integration.**
- **Special rendering for `llm()`-reachable sites.** The call graph routes through `llm()` tools correctly, so no special header is needed.
- **Stack-order of handlers.** A set is enough for the debugging story.
- **Policy analysis / interrupt-kind filtering.**

## Testing

Three test files, all in normal `vitest` style:

- [lib/typeChecker/interruptCallGraph.test.ts](../../../lib/typeChecker/interruptCallGraph.test.ts) — 8 unit tests for `buildInterruptCallGraph` (call edges with/without handlers, llm tool synthetic edges, goto, file identity, top-level skip, multiple sites).
- [lib/analysis/interrupts.test.ts](../../../lib/analysis/interrupts.test.ts) — unit tests for `analyzeInterrupts` (direct sites, bare interrupts, diamond dedup, recursion, both handler shapes, nested handlers across function boundaries, multi-entry union, orphan functions, cross-file imports).
- [lib/cli/interrupts.test.ts](../../../lib/cli/interrupts.test.ts) — 6 unit tests for `renderInterrupts` (header format, unknown-kind clause, both shapes, block separation, trailing newline, empty input).

Five integration fixtures under [tests/integration/cli-main/fixtures/interrupts/](../../../tests/integration/cli-main/fixtures/interrupts/) plus expected snapshots under `tests/integration/cli-main/fixtures/expected/interrupts-*.txt`. `make fixtures` regenerates the snapshots via the interrupts block in [scripts/regenerate-fixtures.ts](../../../scripts/regenerate-fixtures.ts). The cli-main smoke test ([tests/integration/cli-main/test.mjs](../../../tests/integration/cli-main/test.mjs)) runs `agency interrupts` against each fixture and diffs the output.

**Path normalization.** Both the regenerate script and the test harness normalize absolute fixture paths to a `<fixtures>/interrupts` token so snapshots are reproducible across machines, and both convert Windows backslashes to forward slashes. They also handle the macOS `/private/var/folders/...` realpath form. The two normalization blocks must stay in sync — comments in both files cross-reference each other.

## Related docs

- [interrupts.md](../runtime/interrupts.md) — how interrupts resume inside blocks at runtime (substeps).
- [typechecker](./typechecker/README.md) — bidirectional type checking pipeline.
- [effect-propagation.md](./effect-propagation.md) — the separate analysis that propagates interrupt effect sets.
