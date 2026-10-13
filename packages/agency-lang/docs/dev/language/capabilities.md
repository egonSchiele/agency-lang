# The `@capabilities` tag and the platform check

A function or node can say what the host must have for it to work:

```
@capabilities(fileRead, subprocess)
export def exec(command: string): Result<ExecResult> { ... }
```

The host is the layer between a program and the platform it runs on
(`docs/dev/runtime/host.md`). Its seven capabilities are `CAPABILITIES` in
`lib/host/host.ts`, and a platform may lack some of them: the browser has
`network`, `env`, `terminal`, and `llm`, and nothing else
(`PLATFORM_CAPABILITIES` in the same file). The tag names the capabilities
a function asks the host for, so the compiler can refuse a program before
it is run on a platform that cannot serve it, and the runtime can refuse
the call before anything in it runs.

The user-facing description is `docs/site/guide/capabilities.md`. This doc
is for changing the mechanism.

## Why the tag is on the function

A capability is a fact about code: this code asks the host to read a file.
An effect is a question for a person: may this file be read? The first
version of this feature (PR F3) put the tag on the effect declaration, and
a function that raised no effect, such as `exists`, then had nowhere to say
what it needed. The tag moved to the function.

The tag goes on a `def` or a `node` and nowhere else. A module-wide tag was
in the plan and came out: a tag on `std::shell` reached `std::skills`
through one imported function and made every stdlib agent need
`subprocess`. A tag on an import was the spec's follow-up and came out for
the same reason the owner gave: one place to look. The plan and its review
are `docs/superpowers/plans/2026-10-13-capabilities-on-functions.md` and
the `-review.md` beside it.

## The tag

`lib/typeChecker/capabilitiesTag.ts` reads the tag. `readCapabilities(tags)`
returns whether a `@capabilities` tag is present, the names it carries, and
any problems. `callablesWithTags(nodes)` pairs every `def` and `node` with
its tags, read with `tagsAbove` because the symbol table and the type
checker see the raw parse tree, where a tag is still a sibling node above
its declaration. `ownCapabilities(nodes)` is the map from name to the
function's own list.

The rules, each a diagnostic in `lib/typeChecker/capabilitiesCheck.ts`:

- Every argument is a bare identifier (AG3025) that names one of the seven
  (AG3024). An unknown name is reported with the closest known one, by edit
  distance divided by the longer length, so `flies` suggests `fileRead` and
  not `llm`.
- The tag appears once per declaration (AG3026).
- The tag sits above a `def` or a `node` (AG3028). One predicate decides
  it: a `@capabilities` tag attached to any other node, or standing alone,
  is stray. The effect declaration is the one case that adds a hint, "move
  it to the function that raises the effect", because that is where F3
  taught people to write it.
- AG3027, two declarations of one effect disagreeing, is retired. The code
  stays reserved in `diagnostics.ts` with a note.

A tag with no names is written `@capabilities()`. The parser records
whether a tag's parentheses were written (`parentheses` on the `Tag`
node), and the formatter writes them back. The names mean something only
inside the tag: a program can name a variable `network`.

## What a function needs

What a function needs is the union of its own tag and what the functions it
calls need. The compiler computes it in two places that must agree.

**The symbol table.** `classifySymbols` in `lib/symbolTable.ts` writes each
function's own tag onto `sym.capabilities`. Then `propagateEffects` in
`lib/analysis/effects.ts` runs its fixpoint once per view in
`EFFECT_VIEWS`, and `CAPABILITIES_NEEDED` is the third view beside the two
effect views: it reads `sym.capabilities` as the seed, follows the same
call edges through imports and re-exports, and writes the union back. A
view is three functions, `readBody`, `readOwn`, and `writeBack`, so adding
one touched no propagation code. `buildCompilationUnit` then builds
`capabilitiesByFunction` with `fieldTable`, beside the two effect tables.

**The type checker.** `analyzeCapabilitiesFromScopes` in
`lib/typeChecker/interruptAnalysis.ts` runs the same pipeline as
`analyzeInterruptsFromScopes`, seeded for imported names from
`ctx.capabilitiesByFunction` and for the file's own functions from their
tags, over the same callee keys, so the two walks cannot disagree about who
calls whom. The checker can add a function reference resolved through a
type that the symbol table's syntax walk cannot see. `TypeCheckResult`
carries the result as `capabilitiesByFunction`.

The invariant from `docs/dev/compiler/effect-propagation.md` holds here
too: the checker may find more than the pass, and may not find fewer.
`lib/analysis/effectsOracle.test.ts` compares the two for capabilities as
it does for effects.

## Checking a tag against the code

A tag is written by hand. `agency test --check-capabilities` compares it
with what the code did:

1. The runner names a file in the `AGENCY_CAPABILITY_LOG` setting of each
   case's subprocess (`lib/cli/test.ts`).
2. In that process, `lib/host/node/default.node.ts` builds the host with an
   `onUse` callback that appends `use <part.function> <capability>` to the
   file for every capability function that runs, and `enterCallable`
   (below) appends `enter <name> <capabilities>` when a function or node
   starts and `exit <name>` when it ends (`lib/runtime/capabilityLog.ts`).
   The exit is written in a `finally`, so a body that throws, fails, or is
   aborted still leaves the stack; a missed exit would cover every later
   host use in the case.
3. When the subprocess exits, `checkCapabilityLog` in
   `lib/cli/capabilityCheck.ts` replays the lines. `enter` pushes a frame,
   `exit` pops the innermost frame with that name, and a `use` is covered
   when any frame on the stack declares the capability. A use no frame
   covers fails the case and names the host function, the capability, and
   the innermost function that was running.

`llm` is left out: both platforms have it, and a model call is made by
`llm()`, which is not a function a tag can sit on. The other six are
checked. `CHECKED_CAPABILITIES` is every name in `CAPABILITIES` minus
that one, so a new capability is checked unless someone leaves it out.

Concurrent branches interleave their lines, so the stack is really the set
of every in-flight function across branches, and a use is covered if any of
them declares the capability. The errors this produces are false passes: a
wrong tag can hide behind a concurrent function with the right one, so a
green run does not prove the tags complete. The check also sees only what
the tests run. The agency tests run with the flag in CI
(`.github/workflows/test.yml`).

## Compiling for a platform

```
agency compile --platform browser app.agency
agency typecheck --platform browser app.agency
```

or `"platform": "browser"` in `agency.json`. `applyCliFlags` turns the flag
into `config.platform`; the default is `node`. `run` always runs on Node and
does not take the flag. `pack` keeps its own `--target node`, because it can
only produce a Node bundle today, and `bundle` is the trace bundle command.

The check is `checkPlatformCapabilities` in
`lib/typeChecker/platformCheck.ts`, run by the type checker when the
platform is not `node`. For every node and every exported function it
reads `capabilitiesByFunction` and reports each capability the platform
lacks as AG3029. A function the file keeps to itself is reported through
the exported function that reaches it. A handler changes nothing.

The message carries the calls from the node to the function whose own tag
carries the capability. The path is built only for a violation, from the
per-file call graph the checker already made (`buildInterruptCallGraph`),
following the file's own functions and stopping at the first imported one,
named by its module:

```
Node 'main' needs the fileRead capability, which the browser platform does not have.
  main calls loadNotes (notes.agency:12)
  loadNotes calls read from std::index (notes.agency:4), which needs fileRead
```

The checker does not follow a call through a variable the function was
assigned to (`const f = read; f("a")`), a limit of effect propagation, so
the compile-time check does not see it either. The runtime refusal still
holds, because the wrapper does not care how it was reached.

`compile` runs the checker for this check alone when the platform asks for
it (`runTypecheck` in `lib/compiler/buildSession.ts`): when nothing else
asked for the checker, only the platform findings are printed, and they are
fatal whether or not `typechecker.strict` is set.

### What the check does not cover

Top-level code. A `static const` initializer that calls a TypeScript helper
directly has no function to carry a tag. The host refuses it at module
load. A TypeScript file the program imports is also invisible unless an
Agency function that calls it is tagged; if it imports `fs`, the bundler
reports it. A stdlib module whose functions touch Node without going
through the host (`std::agency/local` manages model files with the
synchronous file module, `std::ui` drives a terminal in raw mode) is kept
off the browser only by the tags its functions carry, which the runtime
check cannot verify for it.

## Refusing at function entry

Every function and node starts through one helper, `enterCallable` in
`lib/runtime/capabilities.ts`. It has two callers and no copies:
`AgencyFunction.invoke` (`lib/runtime/agencyFunction.ts`), after
`assertUsable` and before argument resolution, and the compiled node body,
which `processGraphNode` in `lib/backends/typescriptBuilder.ts` wraps in a
call to `__enterCallable`. Both hand it the run, as every body the runtime
calls back is handed the run (`docs/dev/compiler/codegen-run-parameter.md`).

The helper calls `requireCapabilities(run.ctx.host, capabilities, name)`
from `lib/host/host.ts`, the one function that reads `host.capabilities`,
and converts the `UnsupportedOnHostError` it throws the way the generated
catch converts one thrown inside a body: a statelog `error` event and
`runtimeFailure`. So a refusal at entry and a refusal from inside the host
read the same and log the same. One sentence is added for a model that
called the function as a tool, `No tool call can supply it.`, so it does
not try again with other arguments.

The body never begins, so its `pushHandler` calls never run, and no handler
is skipped by a partial run. This is the argument `checkFailureArgs` makes
for failure propagation, and it holds here for the same reason.

The function's own list reaches the runtime in the wrapper's metadata: the
`createProps` object codegen emits gains `capabilities` when the tag names
something, beside the markers. `AgencyFunction` keeps it in a field, and
every derivation (`partial`, `rename`, `describe`, `preapprove`) goes
through one `derive(overrides)` method that spreads the current options, so
a derived tool carries the list by construction. A node's list is written
into the `__enterCallable` call in its compiled body.

Two mechanisms carry a tag to the runtime, and they should stay two.
`@always` goes through a registry at module load because an effect has no
runtime object to hang data on; `@capabilities` rides on the wrapper
because a function has one.

A function reached through a chain of calls is checked when it is entered,
so the transitive list is a compile-time matter only. A resume replays the
node from the top and enters the call that was in progress again through
`__call` and `invoke`, so a checkpoint taken on a full host and resumed on
a smaller one is refused at the function, with the function's message.
`tests/agency-js/host-capability-refusal` runs both raise forms, a tagged
node, and the resume on a memory host without `subprocess`, and checks the
handler never printed.

`callPlain` TypeScript helpers are not wrapped and get no check, which
matches the decision that imports carry no tag.

## How the stdlib tags were decided

Each raising function carries the union of what the F3 survey found the
effects it raises asked the host for. The whole function counts, including
the code before the raise, because the runtime check compares the tag with
every host call the function made. So a write is tagged `fileRead` too
(every write helper resolves a root first), the `std::github` functions
carry `subprocess` and `env` beside `network` (the `gh auth token` and
keyring fallbacks, `git remote` before the raise), and `imageSize` carries
what `std::readImage` carried.

The functions that raise nothing and touch the host carry their own tag:

| Module | Tags |
| --- | --- |
| `std::shell` | `stat`, `exists`: `fileRead`. `which`: `subprocess`. |
| `std::system` | `isTTY`, `readStdin`: `terminal`. |
| `std::index` | `print`, `printJSON`, `input`: `terminal`. |
| `std::auth/keyring`, `std::auth/oauth`, `std::calendar` | `isKeyringAvailable`: `subprocess`. `isAuthorized`, `isCalendarAuthorized`: `fileRead`. |
| `std::skills` | the scans (`docsSkill`, `agentSkill`, `agentPrompt`, `scanEntries`, `checkSkillInputs`): `fileRead`. |
| `std::toolbox`, `std::speech`, `std::spill`, `std::thread` | the private readers (`expandRoot`, `moduleFacts`, `metaFacts`, `realOutput`) and `spillDir`, `attachToReply`: `fileRead`. |
| `std::memory` | `memory`, the block that persists its frame: `fileRead, fileWrite`. |
| `std::policy`, `std::safeBash` | `writePolicyFile`, `addPolicyRules`, `runWrite`: `fileRead, fileWrite`. `missingPolicyRules`, `prepareRedirectWrite`: `fileRead`. |
| `std::mcp` | `readProjectMcpConfig`: `fileRead`. `loadMcpTools`, `loadMcpToolsWithStatus`: `fileRead, fileWrite, subprocess, network`. |
| `std::agency`, `std::agency/eval` | the functions that compile or read a file: `fileRead`. `run` and its siblings: `subprocess, fileWrite` as well. |
| `std::agency/local` | per function: downloading needs `fileRead, fileWrite, network`; listing needs `fileRead`; asking the server needs `network`. |
| `std::ui`, `std::ui/cli` | everything that draws or reads a key: `terminal`. |
| `std::embedding` | `embed`, `embedMany`: `llm`. |

`lib/stdlibCapabilities.test.ts` keeps the table honest. For every exported
stdlib function it reads two things the compiler already produces: the
transitive `capabilities` list on its symbol, and the call edges from
`callSummaries` in `lib/analysis/effects.ts`. It runs one more fixpoint
over those edges for "reaches a `stdlib-lib` helper", and a function that
does and has an empty list fails unless it is on the allow list in the
test, which has a sentence per group (`range`, the `std::date` and
`std::path` functions, agents that assemble a prompt and hand on the tools
they are given, and the like). A second test fails if a name on the allow
list carries a tag after all. The test found one missing tag when it was
written, `runWrite` in `std::safeBash/actions`.

`agency doc` prints the transitive list as a `Needs:` line beside `Throws:`
on every function and node (`formatNeeds` in `lib/cli/doc.ts`).

## Files

| File | What |
| --- | --- |
| `lib/typeChecker/capabilitiesTag.ts` | reads the tag; `callablesWithTags`, `ownCapabilities`; the closest-name suggestion |
| `lib/typeChecker/capabilitiesCheck.ts` | AG3024 to AG3028 |
| `lib/analysis/effects.ts` | the `CAPABILITIES_NEEDED` view; `callSummaries` |
| `lib/symbolTable.ts` | `capabilities` on `FunctionSymbol` and `NodeSymbol`, seeded from the tag |
| `lib/compilationUnit.ts` | `capabilitiesByFunction` |
| `lib/typeChecker/interruptAnalysis.ts` | `analyzeCapabilitiesFromScopes` |
| `lib/typeChecker/platformCheck.ts` | AG3029 and the call path |
| `lib/compiler/buildSession.ts` | `runTypecheck`, which runs the check for `compile` |
| `lib/runtime/capabilities.ts` | `enterCallable`, the one place a callable is refused and logged |
| `lib/runtime/agencyFunction.ts`, `lib/backends/typescriptBuilder.ts` | the two callers |
| `lib/runtime/capabilityLog.ts`, `lib/cli/capabilityCheck.ts` | `--check-capabilities` |
| `lib/stdlibCapabilities.test.ts` | every stdlib function that reaches the host is tagged |
