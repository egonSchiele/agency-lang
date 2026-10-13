# The `@capabilities` tag and the platform check

An effect declaration can say what the host must have for the effect's
function to work:

```
@capabilities(fileRead, subprocess)
effect std::exec { command: string }
```

The host is the layer between a program and the platform it runs on
(`docs/dev/runtime/host.md`). Its seven capabilities are `CAPABILITIES` in
`lib/host/host.ts`, and a platform may lack some of them: the browser has
`network`, `env`, `terminal`, and `llm`, and nothing else
(`PLATFORM_CAPABILITIES` in the same file). The tag names the capabilities
an effect's function asks the host for, so the compiler can refuse a program
before it is run on a platform that cannot serve it, and the runtime can
refuse a raise before anyone is asked to approve it.

The user-facing description is the "What an effect needs from the host"
section of `docs/site/guide/effects.md`. This doc is for changing the
mechanism.

## The tag

`lib/utils/capabilitiesTag.ts` reads the tag: `readCapabilities(tags)`
returns whether a `@capabilities` tag is present, the names it carries, and
any problems. The parser needs nothing new; a tag is a tag, and the
preprocessor attaches it to the effect declaration like `@alwaysUnder`.

The rules, each a diagnostic in `lib/typeChecker/effectPayloadCheck.ts`
beside the `@always` checks:

- Every argument is a bare identifier (AG3025) that names one of the seven
  (AG3024). An unknown name is reported with the closest known one, by edit
  distance divided by the longer length, so `flies` suggests `fileRead` and
  not `llm`.
- The tag appears once per declaration (AG3026).
- Every tagged declaration of one effect agrees (AG3027). A declaration
  with no tag inherits the tagged ones, so a user program may still write
  `effect std::read { dir: string, filename: string }` with no tag, as the
  guide shows.
- The tag sits above an effect declaration and nothing else (AG3028).

A tag with no names is written `@capabilities`. That is how the formatter
writes any tag with no arguments, and `make` formats the stdlib, so
`@capabilities()` would not survive a build. The names mean something only
inside the tag: a program can name a variable `network`.

**Every `std::` effect carries the tag.** `lib/stdlibCapabilities.test.ts`
parses every stdlib file and fails on an untagged one. An effect whose
function calls nothing on the host writes `@capabilities`; seven do
(`std::question`, `std::agents::planApprove`, `std::aws::s3::presignGet`,
`std::exit`, `std::memory::disableMemory`, `std::toolbox::review`,
`std::skills::review`).

### How the stdlib tags were decided

Each tag is the union over every function that raises the effect of what
that function asks the host for. The whole function counts, including the
code before the raise, because the runtime check below compares the tag
with every host call the function made. Three consequences:

- A write is tagged `fileRead` as well as `fileWrite`, because every write
  helper first asks the files part for a root or a real path, and the host
  counts those as reads.
- The `std::github` effects carry `subprocess` and `env` beside `network`:
  the token falls back to `gh auth token` and the keyring, and the owner and
  repo are read from `git remote` before the raise.
- `std::readImage` is raised by `imageSize` (Python through a subprocess)
  and by `generateImageLocal` (the model client), so it carries the union.

## Checking a tag against the code

A tag is written by hand. `agency test --check-capabilities` compares it
with what the code did:

1. The runner names a file in the `AGENCY_CAPABILITY_LOG` setting of each
   case's subprocess (`lib/cli/test.ts`).
2. In that process, `lib/host/node/default.node.ts` builds the host with an
   `onUse` callback that appends `use <part.function> <capability>` to the
   file for every capability function that runs, and
   `interruptWithHandlers` appends `raise <effect>` for every raise
   (`recordRaise` in `lib/runtime/capabilityLog.ts`).
3. When the subprocess exits, `checkCapabilityLog` in
   `lib/cli/capabilityCheck.ts` reads the file. A capability among
   `fileRead`, `fileWrite`, `network`, and `subprocess` that the host was
   asked for, while some effect was raised and none of the raised effects is
   tagged with it, fails the case; the message names the host functions and
   the effects.

`terminal`, `env`, and `llm` are left out: `print` and `input` raise
nothing and nearly every test prints, `env` is read through its own effect
before many raises, and both platforms have `llm`.

A case that raised no effect at all and still used the host is one of the
functions in the next section. Deciding such a function is separate from
checking a tag, so the runner prints it as a note and the case passes. A test
file whose cases mix such a function with an unrelated raise (the review
agent scans the bundled docs at startup, then reads an environment
variable) says so in a `silentHostUse` field of its `.test.json`, with the
reason, and the runner prints the check's findings for that file as notes.

The check sees only what the tests run. It does not prove a tag complete.
The agency tests run with the flag in CI (`.github/workflows/test.yml`).

## Functions that use the host and raise nothing

Some stdlib functions use the host and raise no effect, so they have
nothing to tag. Each one has one of three answers:

1. **It uses a part every host provides**, so there is nothing to refuse:
   `cwd`, `args`, `setTitle` (`host.system`), `sleep` and `std::date`
   (`host.clock`), `spillDir` (`host.system`).
2. **It should have raised an effect all along.** None has been given one
   in this round; a new effect changes what a user is asked to approve and
   is decided per function.
3. **It stays as it is, and a host without the capability refuses it at
   run time** with an `UnsupportedOnHostError` that becomes the call's
   failure: `stat`, `exists`, and `which` in `std::shell`; `isTTY`,
   `readStdin`, `print`, and `input` (the terminal part; `print` works
   wherever there is a console); `isKeyringAvailable`; `docsSkill`,
   `agentSkill`, `agentPrompt`, and the other skills scans, which read files
   that ship inside the agency package on purpose without an interrupt (the
   tool they return is `read.partial`, so every later read still raises
   `std::read`); `safeBash`'s planner, which resolves redirect targets with
   `files.realDir` before raising one effect per target; and the model
   management functions of `std::agency/local`, `readProjectMcpConfig` and
   `loadMcpTools` in `std::mcp`, and `isAuthorized` in `std::auth/oauth`,
   which are in Node-only modules.

A separate case the check also reports: a function that checks its path
through the host before it raises, and refuses the path. `read("../x")`
asks `files.locate`, finds the escape, and returns a failure without ever
raising `std::read`. On a host without `fileRead`, the same function is
refused by `files.locate` before the raise; that is earlier than the
runtime check below, and the browser smoke test accepts either message.

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
reads the effects the function can raise from the checker's own list
(`interruptEffectsByFunction`, the one `agency policy gen` reads, which
follows a tool handed to `llm`, a function passed on, and a function
received as a parameter) and the capabilities on their tags
(`buildEffectCapabilities`, across the import closure). Each capability the
platform lacks is AG3029. A function the file keeps to itself is reported
through the exported function that reaches it. The check reads the full
effect list rather than the unanswered one, so a handler changes nothing.

The message carries the calls from the node to the raise. The path is
built only for a violation, from the per-file call graph the checker
already made (`buildInterruptCallGraph`), following the file's own
functions and stopping at the first imported one, named by its module:

```
Node 'main' raises 'std::read', which needs the fileRead capability. The browser platform does not have it.
  main calls loadNotes (notes.agency:12)
  loadNotes calls read from std::index (notes.agency:4), which raises std::read
```

A function called through a variable it was assigned to (`const f = read;
f("a")`) is a limit of effect propagation itself
(`docs/dev/compiler/effect-propagation.md`): the checker does not follow
it, so the compile-time check does not either. The runtime refusal still
holds.

`compile` runs the checker for this check alone when the platform asks for
it (`runTypecheck` in `lib/compiler/buildSession.ts`): when nothing else
asked for the checker, only the platform findings are printed, and they are
fatal whether or not `typechecker.strict` is set.

### Node-only stdlib modules

A few stdlib modules import a TypeScript helper on the `NODE_ONLY` list in
`eslint.node-exceptions.mjs`, so no browser bundle can hold them, and most
of their functions raise no effect for the per-effect check to see.
`NODE_ONLY_STDLIB_MODULES` in `lib/typeChecker/nodeOnlyModules.ts` names
them, and importing one when the platform is not `node` is AG7009 on the
import line. `nodeOnlyModules.test.ts` derives the list from the stdlib
sources and the lint list and fails when the two differ. It is the direct
imports only; a module that reaches a Node-only helper through another
stdlib module is the bundler's to report, as is any TypeScript file a
program imports.

## Refusing before the approval prompt

The tags reach the runtime the way `@always` scopes do: each tagged
declaration compiles to one `__registerEffectCapabilities(effect, [...])`
call at module load (`lib/backends/typescriptBuilder.ts`, the
`effectDeclaration` case), into the registry in
`lib/runtime/effectCapabilities.ts`. The registry is process-wide and never
checkpointed; a resume re-imports the modules and re-registers.

`interruptWithHandlers` (`lib/runtime/interrupts.ts`) calls
`missingCapabilityFor(run.ctx.host, effect)` before it consults any
handler. When a capability is missing, the raise is rejected with the same
result a handler's rejection gives, and a reason that names the capability
and the host: `std::exec needs the subprocess capability, which the browser
host does not have.` The statelog events are the ones a handler's rejection
writes, with `resolvedBy: "host"`. For an effect the host serves, nothing
changes: every handler runs and can still reject.

The runtime does this with a check at the raise. A handler installed by
the runtime would have been the other way, and it was set aside because
handlers are not part of a checkpoint: every path that restores a run
would have to install the root handler again, and one that forgot would
let the effect through to the approval prompt. The check reads `ctx.host`,
which every restored run has. `tests/agency-js/host-capability-refusal`
runs both forms of a raise on a memory host without `subprocess`, checks
the handler never ran, and resumes a checkpoint taken on a full host onto
one without the capability.

## Files

| File | What |
| --- | --- |
| `lib/utils/capabilitiesTag.ts` | reads the tag; the closest-name suggestion |
| `lib/typeChecker/effectPayloadCheck.ts` | the tag diagnostics and `buildEffectCapabilities` |
| `lib/typeChecker/platformCheck.ts` | AG3029 and the call path |
| `lib/typeChecker/nodeOnlyModules.ts` | AG7009 and `NODE_ONLY_STDLIB_MODULES` |
| `lib/compiler/buildSession.ts` | `runTypecheck`, which runs the check for `compile` |
| `lib/runtime/effectCapabilities.ts` | the runtime registry and `missingCapabilityFor` |
| `lib/runtime/capabilityLog.ts`, `lib/cli/capabilityCheck.ts` | `--check-capabilities` |
| `lib/stdlibCapabilities.test.ts` | every `std::` effect is tagged |
