# Compile-time splices

`$( gen(args) )` runs `gen` during compilation and pastes the `Code` value it returns into the file being compiled. This is the half of Template Haskell that code literals did not ship: literals make code, splices install it. See `docs/dev/template-agency.md`.

User-facing documentation is in `docs/site/guide/templates.md`. This file covers the parts you only need if you are changing how splices work.

## The pipeline, and where expansion sits

```
parse → expandSplices → SymbolTable.build / buildCompilationUnit → typecheck → codegen
```

Expansion happens immediately after parsing and before anything looks at what a file declares. That ordering is forced by one requirement: generated declarations must be visible both inside their own file and to files that import it.

The place that makes the second half true is `lib/symbolTable.ts`, inside `SymbolTable.build`:

```ts
const expanded = expandSplices(parseResult.result, absPath, config);
const program = expanded.ok ? expanded.value : parseResult.result;
parsed[absPath] = { symbols: classifySymbols(program), program };
```

`classifySymbols` is what records a file's declarations. Expanding before it means a generated `export def` is an ordinary export as far as every other file is concerned.

## Every path that must expand

Five, and missing one is the failure mode to worry about. It produces a file that compiles fine through one entry point and crashes through another.

| Where | On failure |
| --- | --- |
| `lib/symbolTable.ts` (`SymbolTable.build`) | Keep the unexpanded program and carry on. Symbol discovery is best-effort by design, exactly as for unresolvable imports. |
| `lib/compiler/buildSession.ts` (`compileEntry`) | Print and `process.exit(1)`, matching how this path already reports parse and typecheck failures. |
| `lib/compiler/compile.ts` (`compileSource`) | Return a `CompileFailure`. This module returns errors as data and never exits. |
| `lib/compiler/typecheck.ts` (`runCheckerPipeline`) | Keep the unexpanded program. This pipeline answers "what does this check as"; reporting belongs to the compile paths. |
| `lib/analysis/interrupts.ts` (`analyzeOneFile`) | Keep the unexpanded program. Refusing to analyze interrupts because a splice failed would be worse than analyzing what is there. |

The map of paths is the same one `liftCallbackBlocks` marks. If a sixth appears, it will need both.

`TypeScriptBuilder.build` has a tripwire for this. A splice reaching code generation means expansion did not run. Without the tripwire the symptom is a raw `Unhandled Agency node type` stack trace that says nothing about the actual mistake.

## The three phases

`expandSplices` keeps decide, run, and graft separate, because they change for different reasons.

1. **Decide.** An ordered list of checks, each `(context) => SpliceDiagnostic | null`, applied by a short-circuiting reduce. Adding a rule means adding an entry to `CHECKS`, never editing the pass. Short-circuiting matters, because each eligibility check parses the generator's whole import closure.
2. **Run.** `runGenerator`. Not a check. It produces a value, so it returns `SpliceResult<Code>` and does not belong in the array.
3. **Graft.** The capture rule, the position/kind rule, then paste. These need the *result*, which is why phase 1 cannot simply be "all the checks".

Grafting matches splices by object identity rather than by index. A declaration splice spreads N nodes and shifts the position of every splice after it, so index-based grafting breaks on the second splice in a file.

## Why the cache is mandatory

Not an optimization. `SymbolTable.build` has twelve non-test callers, and `lib/lsp/server.ts` calls it from `onDidChangeContent`, once per keystroke. Without a memo, every splice in an open file forks a child process every time the user types a character.

The key is the printed splice expression plus a content hash of the generator's whole transitive closure of relative `.agency` files. Hashing the closure rather than one file is what makes editing a helper one import away invalidate the memo.

The key is only sound because generators are required to be deterministic. That is the strongest practical argument for the determinism rule, beyond reproducible builds: a generator that could call `llm()` would make the cache silently wrong.

Failures are cached too. A currently-broken generator is the case an editor hits hardest, since the user is staring at the error while typing. The caller re-anchors the diagnostic to the splice at hand, because a cached failure carries the position of whichever splice ran first.

`clearSpliceCache()` exists for tests. The cache deliberately outlives a single compile.

## Running a generator synchronously

`_run` is async because it forks, but the whole compile pipeline including `SymbolTable.build` is synchronous, and expansion has to happen inside it. `runGenerator` therefore uses `execFileSync`: the parent blocks while the child does async work internally.

It synthesizes a runner with exactly one import and one node, writes it under `.agency-tmp/`, and compiles it **from a real path**. `compileSource` cannot do this. It writes to its own temp directory, so a program importing the generator by relative path cannot resolve it. The same root cause bit the effect check: anything needing relative imports to resolve must take a path, never a source string.

Things that are easy to get wrong here:

- **A generator rarely crashes the child.** The runtime converts an exception inside an Agency function into a Failure `Result` and returns it normally, so the ordinary way a generator fails arrives as a value under `.data`, not as a nonzero exit. Both `Result` shapes are recognized by their `__type` tag, since the value crossed a process boundary as plain JSON and carries no class identity.
- **A node returns an envelope**, `{ messages, data, tokens }`. The generator's value is under `data`.
- **Detect a timeout kill with `err.signal === "SIGTERM"`**, not `err.killed`, which comes back `undefined`. The memory limit surfaces as `SIGABRT`.
- **The runner compiles with the typechecker off.** `compileEntry` reports a type error with `process.exit(1)`, which would take the user's whole build down instead of reporting AG8008.

## The safety argument, and what carries it

Agency can do compile-time codegen more safely than Haskell. GHC cannot distinguish `makeLenses` walking a datatype from a splice that exfiltrates your source, because `runIO` is opaque. Agency routes dangerous operations through interrupts and computes transitive effect lists statically, so the compiler can refuse an effectful generator before running a line of it.

That only holds if a generator cannot reach code with no effects to check. A plain JS/TS package passes through untouched when imported (`docs/dev/pkg-imports.md`), so **a generator's transitive import graph may contain only `std::` and relative `.agency` files**. Transitive is load-bearing: a clean-looking local file can import `zod` one level down while the generator itself looks spotless. `tests/agency/splices/refuseNonAgency.agency` is exactly that case and is the test that decides whether this argument is real.

Unhandled interrupts are the backstop rather than the mechanism. Compilation installs no handlers, so an operation that somehow passed eligibility still cannot complete.

For calibration, this is closer to the npm `postinstall` problem than to a new hole. The generator is code already in your project, and compiling already runs your code. npm, Template Haskell, and Rust proc macros check nothing at all.

## Known gap: cross-module effect propagation

Effects do not propagate across a module boundary. Measured directly:

```
helper.agency alone      →  { h: ["std::read"] }
gen.agency, calling h()  →  { g: [] }
```

A generator that delegates its effectful work one file away reports an empty effect list, which reads as "safe to run at compile time". Tracked as **#680**.

Until that is fixed, `checkEffects` and `checkDeterminism` walk the generator's whole transitive closure: the generator's own file is checked by name, and across an import boundary *any* effectful export refuses. Coarse and deliberately so. It fails closed, and generators are small and effect-free by rule anyway. When #680 lands, `lib/compiler/splice/eligibility.ts` can go back to a direct lookup, and its comment says so.

## Two claims that were tested and did not hold

Recorded because both were load-bearing and both were wrong.

**Duplicate declarations are not always an error.** The argument that declaration splices are safe assumed a generated `const config` colliding with an existing one would be a duplicate-declaration error. Two `def`s with the same name is a hard error; two top-level `const`s is not, and the later one silently wins. So the guarantee is enforced as `AG8012` rather than assumed.

**A declaration splice cannot require a `program` fragment.** Kind inference for code literals is smallest-first, so a literal holding only `const config = "x"` infers `statements` and never reaches `program`. Requiring `program` in declaration position would make generating top-level constants impossible. A declaration splice accepts `statements` too; template holes keep the stricter rule.

## The cycle guard

Running a generator compiles it, which builds a symbol table, which walks files and can arrive back at a file with a splice.

Two things stop that. `checkNoNestedSplice` refuses a generator whose closure contains any splice at all (`AG8009`), which catches the cycle before anything is compiled. Behind it, `expandSplices` tracks an in-progress set keyed by resolved host path and refuses re-entry.

## Shared with template fills

`lib/runtime/template/graft.ts` holds what filling a hole and expanding a splice must agree about: origin stamping and the position/kind table. Origin stamping is the detail that goes stale first once there are two copies of it, and it is what makes an error inside generated code attributable at all.

`formatErrors` reads that stamp and appends ``(in code generated by `name`)``. This is best-effort. A diagnostic anchored at a node carrying no position of its own has no stamp to read. Attribution for those needs the fragment-checker entry point that `fill.ts` records as a follow-up.

## Not in scope

No introspection of any kind: no `reify`, no seeing inside types, no asking the compiler about a name. Generators take arguments. Everything hard about splices is independent of introspection, and introspection without splices would have nowhere to put its answers, so the ordering was forced.

Holes still cannot appear in property-name position, so a generator cannot emit `p.#field`. That blocks a `makeLenses`-shaped use case and is tracked as **#678**.
