# Compile-time splices

`$( gen(args) )` runs `gen` during compilation and pastes the `Code` value it returns into the file being compiled. This is the half of Template Haskell that code literals did not ship: literals make code, splices install it. See `docs/dev/template-agency.md`.

User-facing documentation is in `docs/site/guide/templates.md`. This file covers the parts you only need if you are changing how splices work.

## The pipeline, and where expansion sits

```
parse → expandSplices → SymbolTable.build / buildCompilationUnit → typecheck → codegen
```

Expansion happens immediately after parsing and before anything reads what the file declares, so a generated name resolves like any other.

**`SymbolTable.build` deliberately does not expand.** That crawl records what each file exports so other files can resolve against it, and expanding there is what would make a generated declaration importable. It would also put generator execution behind all twelve of its callers, including `agency doc`, `pack`, `bundle`, `serve`, the MCP tools, and the editor's symbol table.

Generated declarations are therefore **file-local**: usable in the file that spliced them, invisible to importers. A generated declaration marked `export` is refused outright (`AG8013`) rather than left to fail as a confusing "not defined" in the importing file. Lifting this is issue #687, and the shape of the fix is an interface artifact like the one GHC writes, so a module's exports can be read without re-deriving them from source.

## Typechecking runs your generator

Worth stating plainly, because it surprises people: **`agency tc` and the language server execute generator code.**

They have to. The typechecker needs to know that `greet` exists, and the only way to find that out is to run `makeGreeter`. GHC does the same thing for Template Haskell, running splices before typechecking, and Haskell Language Server evaluates them in the editor for the same reason.

Measured on this machine, one splice whose generator returns a small fragment:

| | Time |
| --- | --- |
| `agency tc` on a file with no splice | ~0.7s |
| `agency tc` on a file with one splice | ~2.7s |
| First expansion inside a running process | ~660ms |
| Later expansions, cache hit | ~0.1ms |

So a splice costs about **two seconds per `tc` invocation**, every time, because each invocation is a fresh process and the cache does not survive it. Inside the language server the cache does survive, so the cost lands once per generator edit rather than once per keystroke.

Two consequences worth keeping in mind when changing this code. The cache is what makes the editor usable, so anything that weakens its key makes the editor forkstorm. And `execFileSync` blocks a single-threaded server, which is why the editor path passes a 3-second wall clock instead of the build's 30.

## Every path that must expand

Six, and missing one is the failure mode to worry about. It produces a file that works through one entry point and misbehaves through another.

The list below was originally found by searching for another preprocessing step, `liftCallbackBlocks`, on the assumption that anything running one should run the other. `agency tc` runs neither, so it was missed, and `agency tc` on a file with a splice reported the generated function as undefined.

Search instead for callers of `buildCompilationUnit`. That is the step which inventories what a file declares, so it is the one that needs the splice already expanded. It returns seventeen call sites; most only want metadata and are listed under "Blast radius" as deliberately not expanding.

That six copies of this sequence exist at all is the real problem, and it is filed as #692.

| Where | On failure |
| --- | --- |
| `lib/compiler/buildSession.ts` (`compileEntry`) | Print and `process.exit(1)`, matching how this path already reports parse and typecheck failures. |
| `lib/compiler/compile.ts` (`compileSource`) | Return a `CompileFailure`. This module returns errors as data and never exits. |
| `lib/compiler/typecheck.ts` (`runCheckerPipeline`) | Keep the unexpanded program. This pipeline answers "what does this check as"; reporting belongs to the compile paths. |
| `lib/analysis/interrupts.ts` (`analyzeOneFile`) | Keep the unexpanded program. Refusing to analyze interrupts because a splice failed would be worse than analyzing what is there. |
| `lib/lsp/diagnostics.ts` (`computeDiagnostics`) | Report it as an editor diagnostic. This is the only path where the user is looking at the file while the generator is broken. |
| `scripts/agency.ts` (the `typecheck`/`tc` command) | Print and mark the run failed. Has its own pipeline and reaches none of the shared ones. Skipped for stdin, which has no path to resolve a generator against. |

The map of paths is the same one `liftCallbackBlocks` marks. If a sixth appears, it will need both.

`TypeScriptBuilder.build` has a tripwire for this. A splice reaching code generation means expansion did not run. Without the tripwire the symptom is a raw `Unhandled Agency node type` stack trace that says nothing about the actual mistake.

The tripwire runs before the builder generates anything, and it finds splices by walking the whole tree rather than scanning the top level — a splice in expression position sits several levels down inside a call. The message names the generator when it can read one, so it says *which* splice went unexpanded, and points here for the list of paths that must call expansion.

Because no real compile path can reach the tripwire, its only coverage is `lib/backends/spliceRefusal.test.ts`, which builds a splice program with expansion deliberately skipped, once per splice position. That test is what notices if the tripwire is ever removed.

## Declining generator execution

Compiling a `$( ... )` runs its generator. That is bounded — a generator may import only `std::` modules and other `.agency` files, and compilation installs no interrupt handlers, so anything dangerous cannot complete — but it is still execution, and a caller may prefer to decline it rather than rely on the argument. Inspecting a freshly cloned repository is the usual reason.

`refuseSplices` in `AgencyConfig` (and `--refuse-splices` on `compile`, `run`, `typecheck` and `test run`) refuses `AG8016` instead of expanding. It is off by default.

**The refusal happens before the generator is resolved**, at the top of `expandSplices`, not as one of the `CHECKS` in `decide`. This is a deliberate exception to the "add a rule, do not edit the pass" convention above, for two reasons. Resolution parses the generator's module, which is work the refusal exists to avoid; and resolution can fail on its own, so a file with both a broken import and the setting on would report `AG8005` in preference to the refusal. `calleeName` reads the callee straight off the syntax, so the message still names the generator without opening its file.

The tests in `expandSplices.test.ts` deliberately do not write a generator file. If the refusal ever moves after resolution, they fail with `AG8005` instead of `AG8016`, which is the regression the placement guards against.

### Where it is forced on

Sandboxed compilation (`compileSandboxed`, used by `agency run --agency-only` and by `std::agency compile`) refuses splices unconditionally through the closure validator, and does not consult this setting.

The agent-reachable inspection entry points in `lib/stdlib/agency.ts` — `typecheck`, `typecheckFile`, `getEffects` — set it on unconditionally, via the `INSPECT_UNTRUSTED` policy object there. They need it because **type checking runs generators**: `typecheckFile` hands the checker a real on-disk path so relative imports resolve, which is also what lets a splice resolve its generator against that directory and execute it. That path never passes through the closure validator, so before this it was the one agent-reachable way to run a generator. "Type checking is read-only" holds only for files without splices.

On that pipeline a refusal **throws** rather than becoming a diagnostic. `runCheckerPipeline` otherwise tolerates a splice that will not expand, keeping the unexpanded program — but a refusal is the caller saying "do not run this", and answering as though the file had no splice would report every generated name as undefined. Throwing joins the pipeline's existing rule that a throw means "could not check this", which the `Result`-returning stdlib entry points surface as an ordinary failure. Every other splice failure keeps the tolerant behaviour.

## The three phases

`expandSplices` keeps decide, run, and graft separate, because they change for different reasons.

1. **Decide.** An ordered list of checks, each `(context) => SpliceDiagnostic | null`, applied by a short-circuiting reduce. Adding a rule means adding an entry to `CHECKS`, never editing the pass. Short-circuiting matters, because each eligibility check parses the generator's whole import closure.
2. **Run.** `runGenerator`. Not a check. It produces a value, so it returns `SpliceResult<Code>` and does not belong in the array.
3. **Graft.** The capture rule, the position/kind rule, then paste. These need the *result*, which is why phase 1 cannot simply be "all the checks".

Grafting matches splices by object identity rather than by index. A declaration splice spreads N nodes and shifts the position of every splice after it, so index-based grafting breaks on the second splice in a file.

## Why the cache is mandatory

Not an optimization. `SymbolTable.build` has twelve non-test callers, and `lib/lsp/server.ts` calls it from `onDidChangeContent`, once per keystroke. Without a memo, every splice in an open file forks a child process every time the user types a character.

The key has two parts. The **slot** identifies the call: the generator's path and the printed expression. The **fingerprint** says whether a remembered answer is still good: a hash over every file that can change what the generator returns. One entry per slot, so an editing session replaces rather than accumulates.

The fingerprint covers every module the runner imports, not just the generator. A splice may pass an imported value as an argument, and that module is imported by the *host*, so it need not appear in the generator's closure at all:

```ts
import { makeFieldGetters } from "./gen.agency"    // imports only std::
import { FIELDS } from "./fields.agency"           // not in gen's closure

$( makeFieldGetters(FIELDS) )
```

Hashing only the generator meant that adding a field served the old expansion. A fresh `agency compile` hid it, because that process starts with an empty cache; the editor, `agency serve`, and watch mode did not. `rebuild.test.ts` pins it.

The key is a fingerprint over inputs, not a claim about the generator. Generators are not required to be deterministic (see below), so a nondeterministic one is answered once per slot within a process and re-run by the next fresh compile. Two builds of the same source can still differ.

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

## Blast radius

Six paths run generator code: the two compile paths, the two typecheck paths, the editor, and interrupt analysis. Everything that only builds a symbol table or reads metadata does not, which covers `agency doc`, `pack`, `bundle`, `serve`, `policy`, and the MCP tools.

"Compiling runs your code" is therefore close to accurate, with typechecking as the honest addition. That was not true of an earlier draft, which expanded inside `SymbolTable.build`; see the section above for why that changed.

## What is not checked

Two things a reader might expect and should not.

**Effects are not checked before the generator runs.** An earlier draft refused an effectful generator statically, as `AG8003`. That is gone. The backstop does the work instead: compilation installs no handlers, so an operation that raises cannot complete, and the failure arrives as `AG8008` naming the generator.

The static version could not be made precise while #680 stands, because effects do not cross a module boundary. To fail closed it had to refuse a generator when *any* export anywhere in its closure raised, which rejects a generator that uses one harmless function from a file that happens to contain an effectful one. A coarse check is defensible when it is the only protection; it is hard to justify as an earlier version of an error the runtime already produces. Filed as **#691**, blocked on #680.

The import restriction, `AG8006`, was removed at the same time and then restored. It does not share the imprecision: "does this generator reach a non-Agency import" has an exact answer, and it is the precondition that makes the backstop mean anything rather than a duplicate of it. It is on by default, with `allowNonAgencyGenerators` in the config to opt out.

**Determinism is not enforced.**

An earlier draft refused a generator that could reach `llm()` or the clock, as `AG8004`. That check is gone and the code is unused.

It was a hardcoded name list, and a name list cannot be made complete. It missed anything one wrapper away through a `std::` module, and eleven stdlib files reach `llm` while declaring no interrupts. It missed everything nondeterministic that was not `llm` or `std::date`, and it would have missed every function added afterwards. A check that reads like a guarantee and is not one is worse than no check.

Nondeterminism was never a safety property in any case. Safety comes from the effect system and the import restriction. A generator that calls an LLM produces a strange build, not a compromised one, and the author wrote that generator.

The cache tolerates it without fixing it. A slot holds one entry, so a nondeterministic generator's answer is pinned for the life of the process, which stops it varying inside one editor session. The cache is module-level, so a fresh compile re-runs the generator and can get a different answer. Two builds of the same source still differ.

If this needs to be enforced properly one day, the complete version is to track `llm` through `analyzeInterruptsFromScopes`, the chokepoint effects already flow through. That is transitive by construction and needs no lists.

## The safety argument, and what carries it

Agency can do compile-time codegen more safely than Haskell. GHC cannot distinguish `makeLenses` walking a datatype from a splice that exfiltrates your source, because `runIO` is opaque. Agency routes dangerous operations through interrupts, and compilation installs no handlers, so an effectful generator cannot complete — it fails partway with `AG8008` instead of finishing its work.

That is enforcement without foresight: the operation is stopped, but only once attempted. The import restriction below is what keeps that enforcement applicable at all.

That only holds for Agency code. A plain JS/TS package passes through untouched when imported (`docs/dev/pkg-imports.md`), and JavaScript raises nothing, so a generator that reaches one is neither checked before it runs nor stopped while running.

`checkImportGraph` is therefore not an optional extra. It is the precondition: a generator's transitive import graph may contain only `std::` and relative `.agency` files. Transitive is load-bearing, because a clean-looking local file can import `zod` one level down. `tests/agency/splices/refuseNonAgency.agency` is exactly that case.

`allowNonAgencyGenerators` turns it off for users who need it, and turns off the guarantee with it.

Unhandled interrupts are the backstop rather than the mechanism. Compilation installs no handlers, so an operation that somehow passed eligibility still cannot complete.

### The gap: interrupt-free ambient reads

Some stdlib functions read process state and raise nothing, so nothing sees them. `std::system` exports `env`, `args`, `cwd`, and `isTTY` this way, while `setEnv` right below `env` does raise.

`env` is the one that matters: a generator could bake a secret into the emitted JavaScript as a string literal, and that artifact gets committed.

Two mitigations, because there are two routes. Making `env` raise like its neighbour closes the Agency route and is filed as **#688**. It cannot close the JavaScript route, where an imported package reads `process.env` with no interrupt involved anywhere. So the child process receives an allowlisted environment holding only what Node needs to start (`CHILD_ENV_ALLOWED` in `runGenerator.ts`), which covers both. Its stdin is a pipe, so `readStdin` gets EOF rather than consuming the build's input.

For calibration, this is closer to the npm `postinstall` problem than to a new hole. The generator is code already in your project, and compiling already runs your code. npm, Template Haskell, and Rust proc macros check nothing at all.

## Known gap: cross-module effect propagation

Effects do not propagate across a module boundary. Measured directly:

```
helper.agency alone      →  { h: ["std::read"] }
gen.agency, calling h()  →  { g: [] }
```

A generator that delegates its effectful work one file away reports an empty effect list, which reads as "safe to run at compile time". Tracked as **#680**.

This is why the static effect check was removed rather than kept coarse. See "What is not checked" above, and #691.

## Two claims that were tested and did not hold

Recorded because both were load-bearing and both were wrong.

**Duplicate declarations are not always an error.** The argument that declaration splices are safe assumed a generated `const config` colliding with an existing one would be a duplicate-declaration error. Two `def`s with the same name is a hard error; two top-level `const`s is not, and the later one silently wins. So the guarantee is enforced as `AG8012` rather than assumed.

**A declaration splice cannot require a `program` fragment.** Kind inference for code literals is smallest-first, so a literal holding only `const config = "x"` infers `statements` and never reaches `program`. Requiring `program` in declaration position would make generating top-level constants impossible. A declaration splice accepts `statements` too; template holes keep the stricter rule.

## The cycle guard

Running a generator compiles it, which builds a symbol table, which walks files and can arrive back at a file with a splice.

Two things stop that. `checkNoNestedSplice` refuses a generator whose own file contains a splice (`AG8009`). Behind it, `expandSplices` tracks an in-progress set keyed by resolved host path and refuses re-entry.

## Shared with template fills

`lib/runtime/template/graft.ts` holds what filling a hole and expanding a splice must agree about: origin stamping and the position/kind table. Origin stamping is the detail that goes stale first once there are two copies of it, and it is what makes an error inside generated code attributable at all.

`formatErrors` reads that stamp and appends ``(in code generated by `name`)``. This is best-effort. A diagnostic anchored at a node carrying no position of its own has no stamp to read. Attribution for those needs the fragment-checker entry point that `fill.ts` records as a follow-up.

## Not in scope

No introspection of any kind: no `reify`, no seeing inside types, no asking the compiler about a name. Generators take arguments. Everything hard about splices is independent of introspection, and introspection without splices would have nowhere to put its answers, so the ordering was forced.

Holes still cannot appear in property-name position, so a generator cannot emit `p.#field`. That blocks a `makeLenses`-shaped use case and is tracked as **#678**.
