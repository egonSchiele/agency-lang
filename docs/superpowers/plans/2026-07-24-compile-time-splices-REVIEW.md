# Review: Compile-time splices implementation plan

Reviewing: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-24-compile-time-splices.md`
Against: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-24-compile-time-splices-design.md`
Date: 2026-07-24

## What is good

The task ordering is right. Diagnostics before the checks that raise them, the formatter before the pass that depends on print fidelity, and eligibility before execution. Each task fails first, then passes, and the commit points are real boundaries.

The two tests the plan singles out as load-bearing are the right two. The transitive-import fixture (Task 9, fixture 5) is genuinely the most important test in the feature, because it is the one that proves the safety argument is not shallow. And the "builtin such as `print` is allowed" case in Task 8 is the kind of test that catches an over-strict implementation that would otherwise pass every other test while rejecting every useful generator.

The verified-fact discipline is also good. Task 5 Step 1 says outright that the determinism approach is unconfirmed and instructs the worker to read the code and decide, rather than pretending the marker approach will work.

The rest of this review is about problems. Four of them are blocking.

---

## Blocking 1: The pass is wired into the wrong compile path

This is the big one, and everything else in this section follows from it.

The plan wires `expandSplices` into `lib/compiler/compile.ts` in `compileSource`, and builds its whole disk-write design around a quirk of that function: it writes the source to a temp file (`lib/compiler/compile.ts:105`) and `SymbolTable.build` then reads that temp file back (`lib/compiler/compile.ts:124`). So the plan says: overwrite the temp file with the expanded source, and the symbol table will pick up the generated names.

`compileSource` is not the path a normal build takes. It is the string-in path, and the comment right there in the function says what it is for: "compileSource compiles agent-authored source for the run() subprocess sandbox" (`lib/compiler/compile.ts:126-128`). It is what `runCode` and the sandbox use.

When a person runs `agency run main.agency` or `agency compile main.agency`, compilation goes through `BuildSession.compileEntry` in `lib/compiler/buildSession.ts`. That function reads the real file off disk (`lib/compiler/buildSession.ts:447`), parses it, and calls `SymbolTable.build(absoluteInputFile, config)` on **the user's actual file path** (`lib/compiler/buildSession.ts:453-454`). There is no temp file. Following this plan as written produces a feature where splices work in the sandbox and are silently ignored in every real build.

The write-back trick cannot be carried over, either. In `buildSession` the path that `SymbolTable.build` reads is the user's source file. Writing expanded source there would rewrite the file the user is editing.

There is a third and fourth caller too. `runCheckerPipeline` in `lib/compiler/typecheck.ts:100-131` runs the same parse → symbol table → compilation unit sequence for `typecheck` and `getEffects`, and `lib/lsp/diagnostics.ts:198` does it again for the editor. A file with a splice in it will show errors in the editor unless expansion runs there as well.

The precedent for "a pass every compile path must run" is already in the tree: `liftCallbackBlocks` appears in all three places (`lib/compiler/compile.ts:136`, `lib/compiler/buildSession.ts:470`, `lib/compiler/typecheck.ts:126`), each with a comment about why it has to run before `buildCompilationUnit`. Splice expansion is a sibling of that pass and belongs in the same three (four, counting the LSP) call sites.

Note also what the spec asks for and this plan does not deliver. The spec says expansion "must happen inside the normal per-file compile that the manifest guards. Hoisting expansion somewhere outside that path would break the guarantee." The manifest guard is in `buildSession` — the freshness check at `lib/compiler/buildSession.ts:436`. Wiring only into `compileSource` puts expansion outside the guarded path entirely, so the caching argument the spec makes does not hold for the code the plan actually writes.

**What to do.** Rework Task 7 around `buildSession.compileEntry`, and add the other call sites explicitly. That probably also removes the need for the source write-back, since the question becomes "how do the generated names reach the symbol table" rather than "how do they reach the temp file". Which leads to:

## Blocking 2: Generated declarations are invisible to the symbol table, and to other files

Once the write-back is gone, the plan's central problem is still there and needs an answer.

`SymbolTable.build` walks the file system. It parses files from disk to record what each one declares. A generated `def greet()` exists only in the in-memory expanded AST, so the symbol table for the host file will not contain it. The plan's diagnosis of this is correct and is the best paragraph in the document ("Background — the part that is easy to get wrong"). Its fix is what does not survive.

Worse, this is not only about the host file. If `other.agency` imports `main.agency`, the symbol table for `other.agency` learns what `main.agency` exports by parsing `main.agency` **from disk**, where the splice is still an unexpanded `$( ... )`. So a generated `export def greet()` is invisible to every other file in the project, no matter how the host's own compile is arranged.

That needs an explicit decision in the plan. The two candidates:

- **Forbid generated declarations from being exported in v1.** A new refusal code, a one-line rule, and the problem is defined out of existence. Splices become file-local, which is enough for the boilerplate use case that motivates the feature.
- **Expand during symbol-table construction**, so the disk parse of any file goes through expansion. Much more expensive: it means running generators during symbol-table walks, in the LSP, on every keystroke.

The first is almost certainly right for v1. Either way the plan must say which, because a worker who hits this mid-task will invent an answer.

## Blocking 3: Running a generator is asynchronous; the compile pipeline is not

Task 6 declares:

```ts
export function runGenerator(splice, importsFromHost, cwd): GeneratorResult;
```

Synchronous. And Task 7 calls it synchronously from inside `expandSplices`, which `compileSource` calls synchronously.

The machinery it delegates to is not synchronous. `runCode` goes through `_compile` then `run`, and `run` lands on `_run` in `lib/runtime/ipc.ts:1296`, which is `async` and returns a `Promise<any>` because it forks a child process. `compileSource` returns a plain `CompileResult`, and `BuildSession.compileEntry` is synchronous too.

So Task 6 as written cannot be implemented. The options are:

- Run the generator with a **synchronous** child process (`execFileSync` or `spawnSync` on a small runner script), giving up the `_run` envelope, its cost accounting, and its interrupt plumbing, but keeping wall-clock and memory limits, which are the two the spec actually leans on.
- Make the compile path **async**, which reaches `compileSource`, `BuildSession`, the CLI, the LSP, and `runCheckerPipeline`. That is a much larger change than this feature and would swamp the plan.

This is the single biggest unknown in the whole plan and it is currently invisible, buried under the placeholder name `compileAndRunInSubprocess`. It should be a **Task 0 spike**: pick the mechanism, prove a trivial generator round-trips a `Code` value through it, and only then write Tasks 1 through 9. If the answer turns out to be "sync child process", several later interfaces change shape.

## Blocking 4: The effect check is fail-open for any generator with a relative import

Task 5 says `checkEffects(source, generatorName)` calls `getEffectsFromSource(source)` and refuses on a non-empty list. That is right in spirit, but `getEffectsFromSource` takes only a source string, and it passes `undefined` as the source path (`lib/compiler/typecheck.ts:162`). `withSourcePath` then writes the source to a fresh synthetic path under `.agency-tmp/` (`lib/compiler/typecheck.ts:60-67`) and builds the symbol table from **there**.

The consequence is stated plainly in the stdlib docs for the function next door: "Relative imports (./foo.agency) cannot be resolved from a source string" (`stdlib/agency.agency`, the `typecheck` doc comment).

So for a generator like this:

```ts
// gen.agency
import { loadTemplate } from "./helper.agency"

export def makeGetters(fields: string[]): Code {
  return loadTemplate(fields)
}
```

...where `helper.agency` calls `read`, the import does not resolve, the effect propagation never sees `read`, and the returned effect list for `makeGetters` is **empty**. The check passes. The generator then runs and reads the file. The unhandled-interrupt backstop catches it at that point, which is exactly the belt-and-suspenders case the spec calls a backstop — but the static check, which the spec calls "the primary one because it is better in every way that matters", quietly did nothing.

This is the same shape of hole as the transitive-import case the plan is proud of catching, and it is the more dangerous of the two, because the generator here contains no suspicious import at all.

**What to do.** `runCheckerPipeline` already accepts a `sourcePath` and short-circuits the temp file when given one (`lib/compiler/typecheck.ts:59`). Add a path-taking variant of `getEffectsFromSource` — `_typecheckFile` at `lib/stdlib/agency.ts:432` is the precedent for a file-based sibling of a string-based checker — and have `checkEffects` take the generator's real absolute path. Change the signature in Task 5 from `(source, name)` to `(generatorPath, name)`.

Then add the test that would have caught it: **a generator that delegates an effectful call to a relative helper must be refused.** Put it beside the transitive-import test and give it the same "do not drop this" note. The same fix and the same test apply to `checkDeterminism`, which has the identical structure.

---

## Should fix

### 5. Nested-splice detection has no mechanism

Task 7 Step 3 item 1 says "Reject if the splice sits inside a generator module (AG8009)." Nothing in the plan tells `expandSplices` whether the file it is looking at is a generator module. It is an ordinary compile from its own point of view.

The check has to live where the generator module is compiled — that is, inside whatever `runGenerator` invokes — and it needs a flag threaded down saying "this compile is a generator; splices here are an error." Say so explicitly, and put the test where the flag is set rather than in `expand.test.ts`, where it cannot actually exercise the path.

### 6. Carrying the host's imports into the synthesized program is wrong

Task 6 passes `importsFromHost` — the host file's import lines — into the synthesized program so the generator name resolves.

That drags along every other import the host has, including the npm and `pkg::` imports that Task 4 just spent a whole task banning from the generator's graph. The synthesized program would import them, which means compiling it pulls in JavaScript, and if the host has `import test { ... }` it hits the test-import denial in `resolveImports`.

Emit **only** the one import that supplies the generator, reconstructed from what `resolveGeneratorModule` already found. That function knows the module path; it should also return the imported name (and any alias) so `runGenerator` can print exactly one import line.

### 7. AG8005 is doing two unrelated jobs

The message is written for one case:

> "`{name}` must be imported from another file to be used in a splice. A generator cannot be defined in the file that splices it, because it has to be compiled first."

Task 7 Step 3 item 3 then reuses AG8005 for a different rule: a splice **argument** referencing a host-file name. Reading "a generator cannot be defined in the file that splices it" when what you actually wrote is `$( gen(SOME_CONST) )` is confusing, and `agency explain AG8005` cannot give useful prose for both.

Give the argument rule its own code. Codes are cheap and append-only; make it AG8011 with its own message about splice arguments.

### 8. `combine()` is required by the spec's motivating example and has no task

The spec's open question 1 settles on `combine(codes: Code[]): Result<Code>` in `std::agency`, and its main worked example — the one that carries the whole "stop writing N near-identical functions" argument — ends with `return combine(out)`. There is no `def combine` anywhere in `stdlib/` today. I checked.

The plan never mentions it. Task 9's `builtWithFill` fixture will run straight into it.

Either add a task for `combine` (stdlib source, docstring, `PRELUDE_NAMES` mirror if it is exported from `stdlib/index.agency`, `make` afterwards, and merge rules per kind pair, which the spec left open) or state that v1 generators emit a single fragment and change the fixture accordingly. Do not leave it implicit.

### 9. Two tests the spec asks for are missing

The spec's Testing section lists "an error-attribution test proving that when generated code fails to compile, the message names the generator." The plan has no such test.

This matters more than a missing test usually does, because error attribution is the specific thing the spec claims splices can do that `runCode` cannot — the origin stamps survive because the AST is pasted rather than printed and re-parsed. It is the payoff for the whole design. Test it, and test that `loc.origin` is actually present on grafted nodes after Task 7's graft step.

### 10. Reprinting the file destroys locations for the user's own code

The plan prints the expanded AST back to source and writes it over the file the symbol table reads. Even setting aside blocking issue 1, the printed source is formatter-normalized and now contains generated declarations, so every line and column below the splice has moved. Anything downstream that reads positions from that file — the symbol table, and anything that later reports at a symbol's location — is off by however much the splice expanded to.

Task 7's case 7 checks that the reprinted source re-parses to a structurally equal program. It does not check that positions still point at the right lines, and structural equality will happily pass while every location is wrong.

If blocking issue 1 is fixed by keeping the expanded AST in memory and never writing it back, this dissolves. That is another reason to fix it that way.

### 11. Splices inside code literals are undefined

What does `[| $( f() ) |]` do?

`codeLiteral` is a walker leaf (`lib/utils/expressionSlots.ts:97` is `codeLiteral: true`), so the expansion pass will not descend into it and will not see the splice. Whether the code-literal body parser even tolerates `$(` at that position is not obvious.

Pick the rule — most likely "a splice inside a code literal is ordinary template text and expands only when that `Code` is itself compiled" — write it down, and add a parser test. Leaving it undefined means the first person who tries it gets whatever the implementation happened to do.

---

## Smaller things

**Altitude: the new directory.** `lib/compiler/splice/` for four files is defensible, but the expansion pass itself is a preprocessor in the exact sense this codebase already uses: `resolveReExports`, `liftCallbackBlocks`, and `typescriptPreprocessor` all live in `lib/preprocessors/` and all run in the same slot in the pipeline. Consider putting `expand.ts` there and keeping only the checks under `lib/compiler/splice/`. Following `liftCallbackBlocks` has a practical payoff: it is the pass whose call sites tell you exactly which four places splice expansion also has to be inserted.

**`params.name` in AG8006 renders a filename.** `checkImportGraph` in Task 4 Step 3 sets `params: { name: path.basename(entryPath), ... }`, but the AG8006 message reads "The generator `{name}` reaches non-Agency code" — so the user sees a file name where a function name is promised. Pass the generator name down, or reword the message to be about the module.

**Task 4's tests pass `{}` as `AgencyConfig`.** Fine if the type allows it; check before writing, since a required field would break all nine tests at once.

**`findNodesOfType` does not exist.** The plan already hedges this correctly. Confirming: there are no hits anywhere in `lib/`. `lib/utils/holes.ts` filtering over `walkNodesArray` is the construction to copy.

**Task 1 Step 7's three table references are accurate.** `codeLiteral: true` at `lib/utils/expressionSlots.ts:97`, `codeLiteral: none` at `lib/utils/identifierSlots.ts:217`, and the deliberate-absence comment at `lib/utils/bodySlots.ts:233`. The instruction not to copy `codeLiteral`'s leaf-ness is right and worth the emphasis it gets.

**`generateAgency` exists** at `lib/backends/agencyGenerator.ts:1990`, and `generateExpression` at line 2008 is the nested-expression printer Task 2 calls `formatExpression`. Check `generateAgency`'s arity before writing the test.

**`expectedCompileError` is real and merged** — `lib/cli/expectedCompileError.ts` plus fixtures under `tests/agency/templates/`. Task 9's refusal fixtures are on solid ground.

**Fixture directory.** The plan uses `tests/agency/splices/`; the spec said `tests/agency/templates/`. The plan's choice is better. Just noting the divergence so it is deliberate.

**Task 7 Step 5's snippet declares `const program` after using `program`.** The plan says to rename rather than shadow, which is right — name the final variable in the plan so two workers do not pick two names.

---

## Anti-pattern audit

Checked against `packages/agency-lang/docs/dev/anti-patterns.md`. The plan hits six of the catalog's entries. The "what versus how" one is the most serious, so it goes first.

### Imperative code where a declarative interface belongs

This is the plan's weakest area, and it shows up in two places.

**`checkImportGraph` (Task 4, Step 3).** The plan hands the worker a hand-written breadth-first search: a mutable `visited` record, a `queue` array, `queue.shift()`, a `while` loop, and a `return` out of a nested `for`. That is the "how" written out in full, with the "what" — which import edges are allowed — buried three levels deep inside it.

The plan's own prose says the right thing one paragraph later: "read `lib/compiler/compileClosure.ts` — it already walks the import closure for the build manifest, and reusing its edge extraction is better than writing a second walker that can drift from it." Then the sample code writes the second walker anyway. A worker copying the snippet will do what the snippet does, not what the paragraph says. Delete the snippet.

What the split should look like: one thing that produces the edges, one thing that says which edges are legal.

```ts
const ALLOWED_EDGE = (specifier: string) =>
  specifier.startsWith("std::") || isRelativeAgencyPath(specifier);

const offending = importClosureOf(entryPath, config).find(
  (edge) => !ALLOWED_EDGE(edge.specifier),
);
```

The rule then reads as one line you can check against the spec, and the walking lives somewhere reusable.

**`expandSplices` (Task 7, Step 3).** The plan describes the pass as a seven-step numbered recipe: reject if nested, resolve the module, check the arguments, run three eligibility checks, run the generator, check the fragment kind, graft. Written literally that becomes one long function where a policy question ("what makes a generator acceptable?") is interleaved with mechanics ("how do we run it and paste the result?").

Those are two different things and they change for different reasons. Adding a rule later — say, a size cap on generated output — should mean adding an entry to a list, not editing the middle of the pass. Suggest the plan specify:

- an ordered list of checks, each with the same shape `(context) => SpliceDiagnostic | null`, applied by a single `.find()`;
- a separate `graft` step that assumes eligibility already passed.

Task 5's three checks already have that uniform shape, which is good. They should be composed into one `checkGeneratorEligible` rather than called individually from inside the pass, so the pass never names the individual rules.

### Duplicating existing code

**The import-edge scan.** The plan tells the worker to write a local helper called `importSpecifiersOf`. `lib/compiler/compileClosure.ts:283` already has `agencyImportTarget`, and its neighbour carries a doc comment written specifically as a warning against what this plan is about to do:

> "Routed through the SAME extraction as the closure walker (`agencyImportTarget`), which recognizes `importStatement`, `importNodeStatement`, AND `exportFromStatement` — a hand-rolled `importStatement`-only scan would let `export { x } from "pkg::…"` escape the incremental-build never-skip. One source of truth for 'what is an import edge'."

A hand-rolled scan here has exactly that bug, with a worse consequence: a generator containing `export { z } from "zod"` would pass the eligibility check and then reach JavaScript at compile time. The plan's Task 4 tests would not catch it, because all six use plain `import` statements.

Two changes. Reuse `agencyImportTarget` — note it is currently module-private, and `loadModule` beside it carries a comment saying it is "kept inside `compileClosure.ts` until a second caller appears", so splices are that second caller and exporting it is the intended move rather than a liberty. And add a seventh test: a generator that re-exports from a JS package must be refused.

One caveat for the worker: the exported `agencyImportTargets` (plural) is not the function to use. It filters out `std::`, `pkg::`, and non-Agency targets before returning, which is precisely the set of edges the eligibility check needs to see. Use the singular per-node extractor and apply your own policy to what it returns.

**The expression printer.** Task 6 calls `formatExpressionForSplice` and Task 2 calls `formatExpression`. Neither exists. `generateExpression` does, at `lib/backends/agencyGenerator.ts:2008`, and it is a one-liner over `AgencyGenerator`. Name it in the plan so two tasks do not invent two spellings of the same call.

**Grafting and origin stamping.** Task 7 says grafting "mirrors `fill`'s two substitution modes" and to "stamp `loc.origin` on grafted nodes the way `fill` does." Mirroring is duplication with a friendly name, and origin stamping is exactly the kind of detail that drifts once there are two copies. The plan gets this right for `assertKindMatchesSort` — "reuse it rather than restating the rule" — and should use the same language for the graft and the stamp: extract the shared helper out of `lib/runtime/template/fill.ts` and call it from both.

Task 8 gets it right too, reusing `freeNamesOf` and `bindersOf` from `hygiene.ts` while explicitly refusing the rename planner. That is the model for the other cases.

### Leaky abstractions

**`runGenerator(splice, importsFromHost: string, cwd)`.** The second parameter is a blob of source text that the caller has to assemble by knowing what the host's import lines look like and how the synthesized program is put together. The caller now has to understand `runGenerator`'s internals to call it. Pass the resolved module path and the imported name, and let `runGenerator` synthesize its own single import line. That also fixes the correctness problem in finding 6 above, where dragging the host's other imports along pulls in the very packages Task 4 banned.

**`ExpandResult.source`,** documented as: "`source` is the expanded program printed back out, which the caller **must** write to the path `SymbolTable.build` will read." The interface is carrying a pipeline quirk and an obligation the caller cannot forget without breaking the feature silently. If blocking issue 1 is resolved as suggested, this field goes away.

### Inconsistent patterns

The feature invents three different failure shapes across four files:

| Function | Failure shape |
| --- | --- |
| `checkImportGraph`, `checkEffects`, `checkDeterminism` | `EligibilityFailure \| null` |
| `resolveGeneratorModule` | `{ path } \| { failure }` |
| `runGenerator`, `expandSplices` | `{ ok: true, ... } \| { ok: false, failure }` |

Three conventions for one idea inside one feature, which means every call site reads differently and a worker moving between tasks has to re-learn the shape. Standardize on one before Task 4.

The type name `EligibilityFailure` is also wrong for most of its uses. It carries AG8007 (fragment kind mismatch), AG8008 (generator crashed at runtime), and AG8010 (generated code referenced an outer name), none of which are eligibility. Call it `SpliceDiagnostic`.

### One-line if statements

Banned by the catalog, and present in the sample code the worker will copy verbatim:

- Task 4 Step 3: `if (Object.hasOwn(visited, resolved)) continue;` and `if (specifier.startsWith("std::")) continue;`
- Task 1 and Task 2 test helpers: `if (!result.success) throw new Error(...)` and `if (!parsed.success) throw new Error(...)`

Braces on all of them, or drop the snippets in favour of prose.

### Not using safeDelete

Task 4's tests do `fs.rmSync(dir, { recursive: true, force: true })` in `afterEach`, over a directory built from `os.tmpdir()`. The catalog says to use the safe-delete helper.

There is a related detail worth putting in the plan, because it will otherwise cost the worker an hour. `withSourcePath` in `lib/compiler/typecheck.ts:60-62` explains why the checker's temp directories live under the project's `.agency-tmp/` rather than `os.tmpdir()`: "so `safeDeleteDirectory`'s project-containment check accepts it on cleanup. `os.tmpdir()` would be outside the project." Temp fixtures in these tests should follow that convention so the safe delete actually works.

### Single-character variable names

Throughout the sample code: `s` for a splice, `n` for a name, `p` for a path, `z`, `f`, `g`, `h` for functions in fixtures. Test fixture function names are defensible — `g` reads fine as "the generator" in a five-line fixture. The local variables in the helpers are not, and they are the ones that get copied into real code. Rename `s`, `n`, and `p` at minimum.

### Tests where a failure would be catastrophic

Two things to say here, both minor but both worth writing down.

Task 6's infinite-loop test is handled correctly: the plan gives it a 60-second vitest timeout so a broken wall-clock limit fails the test rather than wedging CI. Good.

Task 9's refusal fixture 1 is "generator raises an effect → AG8003" and does not say which effect. Specify a harmless one — reading a file that does not exist. If the check ever fails to fire, the fixture runs the generator for real, and a fixture that demonstrates the rule with `write` or a shell command would then do the damage it was written to prevent.

### Clean

For completeness, these catalog entries do not appear: nested ternaries, order-dependent mutable state in the anti-pattern's sense (the sequencing in Task 7 is inherent to a pipeline pass, and the interfaces return new values rather than mutating in place), swallowed `catch` blocks, magic numbers (Task 6 names both limits), nested objects in type definitions, dynamic imports, and the spread-conditional pattern.

## Review of the test plan

The question worth asking of each test is not "does it test the right area" but "if the code were wrong, would this test go red." By that standard the plan has three tests that cannot fail correctly, one whole task whose tests are consistent with a broken implementation, and about a dozen gaps. Taking them in order.

### Tests that cannot fail the way they are supposed to

**The import cycle test hangs instead of failing (Task 4).** The test writes `a.agency` importing `./b.agency` and `b.agency` importing `./a.agency`, calls `checkImportGraph` on `b`, and expects `null`. The plan says "the cycle test is what forces the `visited` set, so do not skip it."

If the `visited` set were missing, this test does not go red. It loops forever, and the whole vitest run stalls. A hanging test is worse than a missing one, because CI sits there and nobody learns anything. Give it an explicit timeout, exactly the way Task 6's infinite-loop generator test already does. That converts a hang into a failure.

**Task 2's round-trip step proves nothing at the point it runs.** Step 5 runs the corpus round-trip gate and expects "PASS, unchanged from before this task." That is trivially true: the corpus contains no splice-bearing file until Task 9. So the gate that the plan describes as the guarantee behind the two-outputs-must-agree invariant does not exercise splices at all until three tasks after the code that depends on it.

The three tests in Task 2 also only assert `toContain` on a printed substring. Substring presence is not fidelity. What Task 7 actually needs is that print → re-parse gives back the same tree. Add that directly in Task 2: parse, print, re-parse, deep-equal the two programs. Then Task 7's case 7 is checking an invariant that already has a unit test underneath it.

**Step 8's claim about the slot tables is too strong (Task 1).** The plan says running `lib/utils/expressionSlots.test.ts` "will fail loudly if Step 7 was incomplete." Incomplete, yes. Wrong, no. The completeness test at `lib/utils/expressionSlots.test.ts:143` asserts that "every expression kind is enumerated **or explicitly empty**, never both" — so a worker who copies `codeLiteral`'s leaf ruling and writes `splice: true` passes it.

That matters because Task 1 spends a paragraph explaining that a splice is emphatically *not* a leaf and that the walker must descend into `expression`, since Task 4 and Task 8 depend on seeing the names inside it. Nothing in Task 1 tests that. Every one of the six parser tests finds the splice through its *parent's* slot, which works identically whether the splice is a leaf or not. The failure would surface much later as an eligibility check that mysteriously sees nothing.

There is a corpus tripwire that would catch it — the structural-reachability test at `lib/utils/expressionSlots.test.ts:503` walks every expression node in the corpus — but again, only once a splice-bearing fixture exists, which is Task 9. Add a Task 1 test that reaches *inside* a splice: parse `$( f(g(1)) )` and assert the walker finds the inner `g` call. That test fails immediately on a leaf ruling.

### The task whose tests are consistent with a broken implementation

All six tests in Task 5 pass **source strings** with no relative imports. That is precisely the shape in which the fail-open bug from blocking issue 4 is invisible: `getEffectsFromSource` resolves nothing relative, so a generator that delegates its effectful work to `./helper.agency` reports an empty effect list and sails through. Every test in the task passes against that broken implementation.

The fix is the test I recommended earlier, and it should carry the same "do not drop this" annotation the transitive-import fixture has:

- a generator whose relative helper calls `read` must be refused
- a generator whose relative helper calls `llm()` must be refused

Three more gaps in the same task:

- **No negative control for determinism.** Four tests all check that bad things are refused. Nothing checks that an ordinary generator calling a pure stdlib function is *allowed*. An implementation that flags every stdlib call passes all four.
- **Clock and randomness have no test.** The spec names three sources of nondeterminism and Task 5 Step 1 tells the worker to go find the clock and randomness entry points. Then only `llm()` gets tested. Two of the three rules ship untested.
- **A trap worth writing into the plan.** `getEffectsFromSource` reports only **exported** callables (`lib/compiler/typecheck.ts:167`). The transitive determinism test deliberately uses a non-exported `helper`, which is the right test, but the worker needs to know about the exported-only filter up front or they will lose an afternoon to it.

Also unverified: the test asserts `params.effects` contains the string `"std::read"`. Whether effect names come back qualified that way is not confirmed anywhere in the plan. If the format differs the test fails cosmetically, and the likely reaction is to loosen the assertion rather than check why.

### The highest-value missing test in the whole plan

**Nothing tests incremental rebuild.** The spec devotes a full section to arguing that caching needs no new machinery, because editing `gen.agency` changes `depsHash` on `main.agency`, which invalidates it, which re-runs the splice. That argument is load-bearing — it is why there is no cache to design — and it is completely untested.

The test is easy to describe: compile a project with a splice, edit the generator so it emits a different function body, compile again, assert the output changed. It is also the test that would have caught blocking issue 1, since wiring expansion into `compileSource` puts it outside the manifest-guarded path entirely.

Add it to Task 9.

### Missing cases, by task

**Task 1, parser.**

- *Two splices in one file.* The helper is called `firstSplice` and every test looks at index 0. Multiple splices are the normal case for the feature's motivating use, and they are where grafting breaks: a declaration splice spreads N nodes into the top-level array, which shifts the index of every splice after it. Untested at every level, parser through expansion.
- *A splice in statement position.* `$( makeGreeters(names) )` on its own line inside a node body is a natural thing to write. The plan supports "decl" and "expr" and never says what this is. It would parse through `baseAtom` as an expression splice and then demand an `expr` fragment, which is probably not what the user meant. Decide the rule, then test it.
- *`loc` is populated.* Error attribution is the feature's headline advantage over `runCode`, and it rests on `withLoc`. One assertion.
- *A top-level `const x = $( f() )`.* Module-level assignment reaches the splice through `baseAtom`, not `topLevelSpliceParser`, so `position` is `"expr"`. Probably right, currently unpinned.

**Task 2, formatter.**

- *A splice whose argument is a multi-line code literal.* This is where a printer is most likely to mangle something, and Task 9's `builtWithFill` fixture depends on it working.
- *A splice with long arguments that trigger line wrapping,* if the printer wraps call arguments at all.

**Task 3, diagnostics.**

- *Nothing checks that the message placeholders get filled.* Every message uses `{name}`, `{effects}`, `{importPath}`, `{actual}`, `{expected}`, `{position}`, `{reason}`. If a check passes `params: { effect }` where the message wants `effects`, the user sees a literal `{effects}` — and every test in the plan still passes, because Task 9's refusal fixtures deliberately assert the `code` field rather than message text. One assertion per diagnostic that the rendered message contains no `{` closes this for the price of a loop.
- Step 5 (`agency explain AG8003`) is an eyeball check, not an assertion. Fine as a smoke test, just do not count it as coverage.

**Task 4, eligibility.**

- *A re-export edge:* `export { z } from "zod"` inside a generator. This is the case `compileClosure.ts`'s own doc comment warns about, and none of the six tests use anything but a plain `import`.
- *The `import node` form,* which `agencyImportTarget` also recognizes.
- *An import that does not resolve.* A typo in a generator's import should produce a diagnostic, not a crash inside the eligibility walker.
- *An aliased import* (`import { makeGetters as gen }`) for `resolveGeneratorModule`, and *a generator reached through a re-export chain*. `resolveReExports` exists because re-export chains are common; a naive scan of the host's import nodes misses them, and the plan's three tests all use the direct form.

**Task 6, running a generator.**

- *A generator returning a non-`Code` value* — say a number. The plan writes the `isCode` guard and a good comment explaining why the `Array.isArray` half matters, then lists no test for either half. Both are one line to test.
- *A `Code` value with a malformed `nodes` field,* which is the exact scenario the comment describes.
- *The memory limit.* Only wall-clock gets a test; both constants are declared.
- *A code-literal argument,* since Task 6 synthesizes the program by printing the splice expression, and printing a code literal is the likeliest thing to go wrong there. Currently only covered end-to-end in Task 9.

**Task 7, expansion.**

- *Two splices in one file*, per above.
- *A file with no splices comes back untouched.* Step 6 runs `compile.test.ts` as a proxy; an explicit identity assertion is better and cheaper.
- *A splice inside a code literal,* whose behavior is undefined today (see finding 11).
- *Origin stamps survive the graft.* The spec asks for an error-attribution test and the plan has none. This is the feature's distinguishing claim.
- Case 4 (a splice inside a generator module, AG8009) **cannot be written in `expand.test.ts` as designed**, because `expandSplices` has no way to know it is looking at a generator module (blocking issue 5). As the plan stands a worker will either fake it or quietly drop it. Move the test to wherever the generator-compile flag gets set, once that mechanism exists.

**Task 8, name capture.**

- *The declaration-splice direction is untested.* The plan's rationale rests on a specific claim: a generated top-level `const config` colliding with an existing one "is a duplicate declaration, which is a loud correct failure." That claim is asserted twice, in the spec and in the plan, and verified nowhere. If duplicate top-level declarations are actually last-wins, the safety story for declaration splices is wrong. Test it.
- *Generated code referencing a name the host file imports.* The rule says generated code may use names **it** imports. A name the host imported but the generator did not should be refused, and that is the subtle version of case 1 — the one an implementation that checks against the wrong import list would get backwards.

**Task 9, end to end.**

- Refusal fixtures exist for AG8003 through AG8007. **AG8008, AG8009, and AG8010 get no end-to-end fixture** (and AG8011, if the argument rule gets its own code, would make four). A diagnostic with no test is a diagnostic that may never fire.
- The error-attribution fixture the spec asks for.
- The incremental-rebuild test described above.

### One thing the test plan gets right

The two tests the plan flags as load-bearing are the correct two, and the reasons given are correct. Fixture 5 in Task 9 — a generator whose local `.agency` helper imports a JS package — really is the test that decides whether the safety argument holds or is decorative. And the "a builtin such as `print` is allowed" case in Task 8 is the right guard against an over-strict implementation, which is the failure mode that would otherwise pass every other test in the task while making the feature useless. The plan tells the worker not to drop either. Keep that framing and extend it to the fail-open effect test, which belongs in the same category.

## Suggested reordering

1. **New Task 0** — spike the generator-execution mechanism (blocking 3). Sync child process or async pipeline. Everything in Task 6 and Task 7 depends on the answer.
2. **New Task 0b** — decide where expansion runs (blocking 1) and what happens to generated exports across files (blocking 2). This is a design decision, not a coding task, and it belongs in the plan rather than in a worker's head at Task 7.
3. **Task 5 grows** — add the path-taking effects entry point and the relative-helper fail-open test (blocking 4).
4. **Task 3 gains AG8011** for the splice-argument rule.
5. **`combine`** gets a task or an explicit exclusion.

6. **Task 4's sample BFS comes out**, replaced by a reused edge extractor plus a one-line allowed-edge rule, and the failure shapes get standardized before any of them have call sites.

Tasks 1, 2, 3, and 8 are in good shape and can proceed roughly as written once the codes are settled.
