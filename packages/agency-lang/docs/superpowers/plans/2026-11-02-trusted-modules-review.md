# Review: trusted modules implementation plan

Plan: `docs/superpowers/plans/2026-11-02-trusted-modules.md`
Spec: `docs/superpowers/specs/2026-11-02-trusted-modules-design.md`

## Verdict

The overall shape is right. A config list that reaches a child only through
`SubprocessRunInfo` is sound: I checked `parentConfigOverrides`
(`lib/runtime/ipc.ts:1469`). It copies an allow-list of fields, so a new
`sandbox` key never rides along in `configOverrides`, and the spec's "no
second path" claim holds.

But as written, the plan would not deliver the ticket. Five things break:

1. The compiled-closure step reads the trusted module from disk and follows
   its imports, so compiling a program that imports one fails.
2. `describe` on a trusted module is still refused.
3. `agency workflow tools` and `agency workflow run` in BMO still fail
   (Task 9).
4. The `run` parameter never reaches the compile, and at the root it lets a
   model widen the list.
5. The committed `tools.js` fixture is gitignored and has a machine-specific
   path baked into it.

Each one is fixable. Fixing #4 the simplest way (dropping the parameter)
removes about a third of the plan.

## Blocking

### 1. `buildCompiledClosure` reads the disk, not the rewritten import

Task 4 Step 2 says: "`buildCompiledClosure` then sees a `.js` import and
leaves it alone." It does not. Step 6 of `compileSource` rewrites the import
in the in-memory AST, but step 6b calls `buildCompiledClosure(syntheticPath,
config)`, which re-reads the entry from disk (`lib/compiler/compile.ts`, the
comment above `compiledSource` says so). In the mirror, the entry's import
still says `./tools.agency`. So `parseClosure` (`lib/compiler/compileClosure.ts`)
walks into the mirrored trusted module and then into every `.agency` file
*that* module imports.

Here is what goes wrong. Task 3 says a trusted module's imports that do not
resolve under a trusted entry are "ignored: not refused, not followed". If
they are not followed, they are not mirrored. `loadModule` then throws
`CompileClosureError: Input file '<mirror>/…' not found`. Take a BMO layout
like this:

```
src/agent/lists.agency      (trusted)
  import { Session } from "../shared/session.agency"   (not trusted)
```

Compiling a workflow over `lists.agency` fails on `session.agency`. The same
gap hits the typechecker in strict mode (workflows compile `strict: true`).
`SymbolTable.build` skips a missing file silently, so a type the trusted
module's signature names from that file never resolves.

**Fix:** have `walkTrustedFile` mirror, read-only and with no rules, every
`.agency` file reachable from a trusted module, wherever it lives. Only
`.agency` files: the `.js` helpers are never read. Then the typechecker and
`buildCompiledClosure` both see a complete tree, and nothing in it is
compiled. Add a validator test with a trusted module that imports a
non-trusted `.agency` file, plus a `compileSandboxed` test that compiles an
entry over it. Also fix the sentence in Task 4 Step 2 and its "pin it with a
test" claim.

A related point is the init plan. `buildCompiledClosure` will put the
trusted module into the entry's `awaitModules`, keyed by its **mirror** path.
The host-compiled `dist/…/lists.js` registers its init under the **host's**
source path (`registryModuleId` is the absolute source path at build time;
see `lib/backends/typescriptGenerator.ts`). `__awaitStaticInit` returns
silently for an unknown id (`lib/runtime/crossModuleInitRegistry.ts:77`). In
practice the closure-wide bootstrap in `runNode` still initialises every
registered module, so ordinary calls work. But an entry whose `static`
initialiser reads something from a trusted module would hit the
read-before-init trap. Either drop trusted modules from the entry's
`awaitModules` on purpose, with a comment saying why, or note the limit in
`trusted-modules.md`. Don't leave it accidental.

### 2. `describe` of a trusted module is still refused

Task 5 Step 2 says "`describe` on a trusted module now returns its
`ModuleInfo`". But `describedFilePath` (`lib/stdlib/agency.ts:278`) calls
`validateClosure({ entry: { file: filename }, dir })`. The trusted module is
the **entry**, so `validateClosure` reads it with `walkFile`, which treats it
as a validated file and refuses its `.js` import. Task 3 only adds the trust
check to `walkLocalImport`, which runs for imports, never for the entry.

That is exactly the error in the spec's opening example (`describe refused
…`), so `catalog`, `checkWorkflow`'s `_signatures`, and `agency workflow
tools` would all still fail.

**Fix:** in `validateClosure`, check a file entry against the trusted list
too, after its existing containment and symlink checks. When it matches,
record it with `walkTrustedFile`. Add a validator test where the trusted
module is the entry. The Task 7 `describeTrusted` row would have caught this,
but only at the end of the plan. Put the unit test in Task 3.

### 3. The `agency workflow` commands, which Task 9 relies on

There are two separate problems here.

**(a) The CLI calls `_describe` with no run.** `describeModule` in
`lib/cli/workflow/toolImports.ts` calls `_describe` straight from TypeScript.
Task 5 says that with no run current, the helpers "pass an empty list". So
in BMO, `agency workflow tools ./src/agent/lists.agency` is refused exactly
as today. The plan's claim that "the helpers are only ever called under one"
is wrong for this caller.

**Fix:** pass the list as an explicit argument to `compileToProgram`,
`sandboxImportErrors`, `describedFilePath`, and `_describe`. The stdlib
wrappers pass `effectiveTrustedModules(ctx)`. The CLI resolves `io.config`'s
list and passes it in. This also removes the "catch the throw from
`getRuntimeContext`" fallback, which is control flow by exception.

**(b) The driver compiles the tools from source.** `runDriver` writes a
driver that imports each tool module by its source path and compiles it
normally (`lib/cli/workflow/runDriver.ts`, `driver.ts`). For BMO, that
compile produces a `lists.js` whose `../backend/lib/x.js` import points into
`src/`. The spec's own problem #2 says nothing exists there. So I expect
`agency workflow run` to fail when the driver loads, before the sandbox is
ever involved. Task 7 Step 4 says "`agency workflow` needs no change". I
think that is wrong for any host whose tools import TypeScript.

I could not run this against BMO, because today it stops earlier, at (a).
It is cheap to confirm once (a) is fixed. The options are:

- The driver imports a trusted tool module from its compiled path, as the
  sandbox does. This needs a check that `std::workflow` still accepts a tool
  whose module is a `.js` import. The source-file metadata comes from the
  host's compile, so it may just work.
- Task 9 drops the CLI checks and tests only BMO's own `runWorkflow` call,
  which goes through BMO's compiled agent and never through the driver.
  Then say in the plan that the CLI commands do not work for such hosts yet.

Either way, decide before building, because it changes Task 9's success
criteria.

### 4. The `run` parameter: drop it from this PR

The spec leaves "whether `run`'s parameter ships now" to the builder. I
recommend not shipping it, for three reasons.

**It never reaches the compile.** `run` takes an already compiled program.
The list that decides what a program may import is the one `compile` uses,
and Task 5 Step 1 gives `compileToProgram` only `effectiveTrustedModules(ctx)`
(config or inherited). Task 5 Step 3 threads `runCode`'s parameter "through
`_runProgram` to `_run`", not into `_compile`. So:

- Task 7's `runsWithTrust` row passes the list only as a parameter, and its
  compile is refused. The test as written fails.
- In a child, a narrowing parameter narrows only what the *grandchild* may
  compile. The program being started was already compiled against the wider
  inherited list.

**At the root it widens, and a model can be the caller.** Every function is
a tool, and `runCode`'s docstring tells a model to "prefer this over separate
compile and run calls". If a model at depth 0 calls
`runCode(src, dir: d, trustedModules: [{ source: d, compiled: d }])` after
writing `d/evil.agency` and `d/evil.js`, the sandbox imports `d/evil.js` as
trusted. That is arbitrary JavaScript outside the sandbox. The `std::run`
interrupt (`stdlib/agency.agency:253`) does not show the list, so a person
approving "Running agent-generated code in subprocess" cannot see it either.
"At the root the caller is the host" holds for config. It does not hold for
an argument a model chose.

**Nothing needs it yet.** BMO never calls `run`. `runWorkflow`,
`workflowTool`, and the CLI all take the config list.

Without the parameter, the rule is one sentence: a child gets its parent's
list unchanged, and the root's list is its config. That removes
`narrowTrustedModules`, `trustedModulesForChild`, Task 5 Step 3, and the
narrowing tests, and it makes Task 6 Step 2 a single line. Task 6 Step 2 is
also self-contradictory as written ("narrow… where at the root… unioned
instead"), and it introduces a helper Task 1 never defines or tests. Both
problems go away. The nested test in Task 7 Step 3 still has a point: a
grandchild started by a trusted tool cannot import from a directory outside
the inherited list.

If a host later needs narrowing, add it to `compile` as well as `run`, and
put the list in the `std::run` interrupt data.

### 5. The committed `tools.js` fixture

Task 7 Step 1 commits a compiled `tools.js` and adds a vitest that recompiles
it and diffs. Three problems:

- `.gitignore:28` ignores `**/*.js`. The existing hand-written helpers under
  `tests/agency/` were force-added. A compiled file needs the same, and the
  plan doesn't say so.
- Compiled output embeds the absolute source path (`__registerStaticInit` is
  keyed by it). The committed file would contain `/Users/adit/…`. The drift
  test then fails on CI, whose checkout path differs, and on every machine
  but yours.
- Any codegen change anywhere changes the output, so unrelated PRs would
  have to regenerate this file.

**Fix:** compile the fixture when the test runs. An agency-js test fits
well: its JS side compiles `tools.agency` into a temp folder under
`.agency-tmp` with the compiler API, then runs the Agency side with that
folder as `compiled`. That also exercises the real case where `source` and
`compiled` are different directories, which the single-directory fixture
never does. Keep `helper.js` hand-written and force-added, like its
neighbours.

## Should fix

### 6. Task 3's order contradicts its symlink test

Step 2 puts the trust check "before the symlink check", and says that on a
match, `walkTrustedFile` is called. Step 3 then expects "a trusted `source`
directory reached through a symlink in the import path is refused by the
existing symlink rule". In `walkLocalImport`, the containment check comes
*before* the symlink check. So the trust branch must sit above containment,
and as written it returns before the symlink rule ever runs. The trust
branch has to run `canonical !== resolved` itself. Say so in Step 2.
Otherwise `dir/link -> ~/bmo/src/agent` imports through a link.

### 7. Drop "a trusted module outside `dir`" and the `__trusted__/` prefix

The mirror works because every file sits at its own path relative to `dir`,
so the importer's relative specifier finds it. Suppose the entry imports
`../../bmo/src/agent/lists.agency` and the mirror writes that file at
`__trusted__/agent/lists.agency`. The entry's specifier no longer points at
it, so `prepareProgram` and the typechecker cannot find it. The validator
test in Task 3 would pass and the compile would fail.

Workflows already require tool files under `dir`
(`stdlib/workflow.agency:66`), and the spec doesn't ask for this. Keep the
containment check for trusted imports too, and the prefix and its collision
handling disappear. `resolveTrustedModules` can still allow a trusted
directory anywhere. It just has to be inside `dir` to be imported.

### 8. Where `trustedModules.ts` lives

`lib/runtime/**/*.ts` is in `BROWSER_FILES` (`eslint.config.js:41`). A
runtime leaf that calls `fs.realpathSync`, or imports `lib/utils.ts` (which
imports `fs`), fails `lint:structure`. Either add it to `NODE_ONLY` in
`eslint.node-exceptions.mjs` with a reason, or keep the pure parts (type,
containment, `compiledPathFor`) in the runtime leaf and move
`resolveTrustedModules` next to its Node-only callers. Either way,
`config.ts` and `context.ts` (both browser files) should use `import type`.

### 9. The "same bytes on every compile" test

`compileToProgram` does not pass `fingerprintModuleIds`, so each compile
gets a random module id (`agency_${nanoid()}`). The string entry also gets
a random relPath, and the init registry key is the mirror path in a fresh
temp directory. Today, two compiles of the same source are not
byte-identical. Task 4 Step 3's "the same source compiled twice is
identical" will fail unless the test sets `fingerprintModuleIds: true`. The
spec's test means the workflow's generated Agency *source*, which is
already deterministic. Restate the global constraint to say that, and either
drop the compiled-bytes test or run it with fingerprinted ids and say
what it pins: that the trusted path is absolute and stable.

### 10. Test rows need `dir`

`runCode`'s `dir` defaults to `""`, and the validator refuses every local
import when the root is null. The `runsWithTrust`, `refusedWithoutTrust`,
and `directJsRefused` rows need `dir:
"tests/agency/subprocess"` (the cwd-relative style `run-function.agency`
uses). Otherwise all three fail on the "no sandbox dir" message, not the
one they expect.

## Minor

- Task 2 Step 1: `client.providerModules` resolves against `process.cwd()`
  when it is used. Mirroring that is fine, but a BMO server started from
  another directory will get a confusing "directory does not exist" error.
  The error message should print the resolved path, not only the entry.
- Task 6 Step 4's resume test is fine. `_runFor` rebuilds the identity on
  every segment. Say that a root restarted with a changed config resumes
  with the new list, which is the intended behaviour.
- `trusted-modules.md` should state plainly that a trusted module's
  `.agency` imports are mirrored for type information only, once item 1 is
  fixed.
- Consider adding the effective list to the `std::run` interrupt data even
  without the parameter, so a policy or a person can see what a child may
  import. Optional.

## Suggested task order after the fixes

1. Leaf: type, `trustedEntryFor`, `compiledPathFor`, resolution (Node-only).
   No narrowing.
2. Config field and the baked context field.
3. Validator: the trust check for imports **and** file entries, the symlink
   rule kept, containment kept, and every reachable `.agency` file mirrored.
4. Compiler: the absolute rewrite, trusted modules not compiled, and the init
   plan decision.
5. Stdlib and CLI: the list as an explicit argument to compile, typecheck,
   and describe.
6. IPC: the list rides to the child unchanged.
7. Tests: an agency-js test that compiles the fixture at setup, with separate
   `source` and `compiled` directories, plus the nested refusal.
8. Docs.
9. BMO: once 3(b) is decided, either the CLI checks or `runWorkflow` alone.
