# Capabilities on functions: implementation plan

**Spec:** section 6 of `docs/superpowers/specs/2026-10-05-host-and-platforms.md`,
which this plan changes. The design below replaces "Declaring what an
effect needs", "Refusing before the approval prompt", and the follow-up
section on import tags. Update the spec in the first task.

**Review:** the first draft of this plan was reviewed before any code was
written. The last section of this file lists what the review changed.

Read first:

- `docs/dev/language/capabilities.md`, for what PR F3 (#1193) built. This
  plan keeps the tag reader, the diagnostics, the platform check, the
  test runner check, and the entry point for the runtime check, and moves
  the tag from effects to functions.
- `docs/dev/language/agency-function.md`, for the wrapper around every
  Agency function, where the runtime check moves to.
- `docs/dev/compiler/effect-propagation.md`, for the pass that carries
  effects from function to function across files. Capabilities travel
  through the same pass as a third view.
- `docs/dev/contributing/coding-standards.md` and
  `docs/dev/contributing/anti-patterns.md`.

**Branch:** one PR based on `main`, after F3 has merged. All paths are
relative to `packages/agency-lang`. One commit per task.

**Timing:** F3 documents `@capabilities` on an effect declaration. This
plan makes that an error. Land this before the next release, so no
published version accepts a form the next one rejects. v0.27.0 shipped on
Oct 3 without the F series.

## The problem

In F3, the only place a capability can be written is above an `effect`
declaration. A function that raises no effect has nowhere to say what it
needs from the host. This program compiles for the browser without
complaint and fails only when it runs:

```
import { exists } from "std::shell"

node main() {
  if (exists("notes.txt")) {
    print("found it")
  }
}
```

`exists` asks the host for `files.stat`, and the browser host has no file
system. The host refuses, so the run is safe. What is missing is the
compile-time error, and a line in `std::shell` that says `exists` reads
files.

The deeper reason is that a capability and an effect are different
things. A capability is a fact about code: this code asks the host to read
a file. An effect is a question for a person: may this file be read? Tying
the tag to the effect means a function can only state a need when it also
asks a question.

## The design

A capability is written on the function that has it:

```
@capabilities(fileRead)
export def exists(path: string): boolean {
  return _exists(path)
}
```

A node is a function the program starts from, and it takes the tag the
same way:

```
@capabilities(network)
node main() {
  ...
}
```

The tag goes nowhere else. There is no module tag and no tag on an
import. A function with no tag declares nothing of its own, so a program
that adds no tags is unchanged.

What a function needs is the union of its own tag and what the functions
it calls need. A wrapper needs no tag:

```
def hasNotes(): boolean {
  return exists("notes.txt")    // needs fileRead, through exists
}
```

The compiler computes the union through the pass it already uses for
effects, which follows a tool handed to `llm`, a function passed on, and
a function received as a parameter. A user's own TypeScript file is
reached through an Agency function that calls it, and the user tags that
function.

Effects carry no tag. `@capabilities` above an `effect` declaration is an
error that says to put it on the function. What an effect needs follows
from the functions that raise it, and nothing reads it separately.

The compile-time check is the one F3 built, with the new source of
needs. Under `--platform browser`, a node or exported function that needs
a capability the browser lacks is AG3029, and the path in the message
ends at the function whose own tag carries the capability:

```
error AG3029: Node 'main' needs the fileRead capability, which the browser platform does not have.
  main calls exists from std::shell (main.agency:4), which needs fileRead
```

The runtime check moves from the raise to function entry. The wrapper
around every Agency function already runs before the body; it reads the
function's own tag, and when the run's host lacks one of the names it
returns the call's failure before the body runs, before any handler is
pushed, and before any interrupt is raised. A node gets the same check
when it starts. A function reached through a chain of calls is checked
when it is entered, so the transitive list is a compile-time matter only.
The registry F3 keyed by effect goes away; the generated code carries the
declared list in the wrapper's metadata, beside the tool markers.

Decided here so the tasks do not reopen them:

- **Functions and nodes only.** A tag anywhere else is an error whose
  message names the two places it may go. A module tag was in the first
  draft and came out: a module-wide tag on `std::shell` reached
  `std::skills` through one imported function and made every stdlib
  agent need `subprocess`. A tag on an import was the spec's follow-up
  and is also out, for the same reason the user asked for: one place to
  look.
- **Top-level code is not checked.** A `static const` initializer that
  calls a TypeScript helper directly has no function to carry a tag. The
  host refuses it at module load, which is what happens today. The guide
  says so in one sentence. Wrapping the call in a tagged `def` is the fix
  when someone meets it.
- **The failure at entry is the host's own refusal.** The check calls
  `requireCapabilities` in `lib/host/host.ts`, the one function that
  reads `host.capabilities`, and converts the `UnsupportedOnHostError` it
  throws the way the generated catch converts one thrown inside a body.
  So the failure reads `exists needs the fileRead capability, which the
  browser host does not have.`, the same text as a refusal from inside
  the host, with one sentence added for a model that called the function
  as a tool: `No tool call can supply it.` No new message, no new kind of
  result.
- **The entry check runs on resume.** A resume replays the node from the
  top and re-enters the call that was in progress through `__call` and
  `invoke`, so a checkpoint taken on a full host and resumed on a
  smaller one is refused at the function, with the function's message.

## Tasks

### Task 1: the spec and the tag's new places

1. Rewrite the spec sections named at the top to say what this plan says.
   Withdraw "Imports that only work on one platform (follow-up)" and say
   why in one paragraph: the user tags the Agency function that calls the
   import.
2. `attachTags` in `lib/preprocessors/typescriptPreprocessor.ts` already
   attaches a tag to a `function` and a `graphNode`. Confirm with
   `pnpm run preprocess` on a tagged `def` and a tagged `node`. It also
   attaches a tag to an `assignment`, a `functionCall`, a `typeAlias`,
   and an `effectDeclaration`; those are the error cases below.
3. `lib/typeChecker/capabilitiesTag.ts`: `readCapabilities` stays as it
   is. It is now read off a function or node's tags.
4. Diagnostics, in a new `lib/typeChecker/capabilitiesCheck.ts` beside
   `effectPayloadCheck.ts`, which loses its tag code:
   - AG3024 (unknown name), AG3025 (bad argument), and AG3026 (repeated
     tag) keep their codes and now name the function instead of the
     effect.
   - AG3027 (two declarations disagree) is retired. Keep the code
     reserved: its entry in `diagnostics.ts` and
     `diagnosticExplanations.ts` says it was retired and why, so the
     generated `docs/site/diagnostics/index.md` does not reuse it.
   - AG3028 (stray tag) learns the new rule: "`@capabilities` goes on a
     `def` or a `node`". One predicate decides it: a `@capabilities` tag
     attached to any node that is not a `function` or a `graphNode`, or
     left standing alone, is stray. The effect declaration is the one
     case that adds a hint, "move it to the function that raises the
     effect", because that is where F3's users will have written it. Do
     not write a branch per node type.
   - Run `make` for the generated diagnostics docs.
5. Formatter test in `agencyGenerator.test.ts`: a tag above a `def` and
   above a `node` survive `agency fmt`, with and without parentheses.
6. Tests in `capabilitiesTag.test.ts` and `capabilitiesCheck.test.ts`
   for each rule. The stray cases to cover: a tag on an effect
   declaration (with the hint), on a `static const`, on a bare call, on a
   type alias, and one standing alone at the end of a file.

### Task 2: what a function needs

1. Add a third view to `EFFECT_VIEWS` in `lib/analysis/effects.ts`. The
   two views today seed each callable with its direct raises and union
   to a fixed point over the call edges, across files, through
   re-exports. The new view seeds each callable with its own tag, read
   with `readCapabilities`, and writes `sym.capabilities` on
   `FunctionSymbol` and `NodeSymbol` in `lib/symbolTable.ts`. The
   `EffectView` type today fixes the field to the two effect names and
   the element type to `InterruptEffect`; widen it so a view can carry
   `Capability[]`, or give the capabilities view its own small summary
   type beside `EffectSummary`. Read `propagateEffects`,
   `buildSummaries`, and `writeBack` before choosing.
2. `buildCompilationUnit` in `lib/compilationUnit.ts` builds
   `capabilitiesByFunction` with `effectTable` from
   `callablesVisibleFrom`, beside the two effect tables.
   `TypeCheckResult` and `CompilationUnit` carry it.
3. The type checker adds what it learns from a function-typed parameter
   with a `raises` clause, the same way it adds effects, so the invariant
   in `effect-propagation.md` holds: the checker may find more than the
   pass, never fewer. Extend `lib/analysis/effectsOracle.test.ts` or add
   a sibling that compares the two for capabilities.
4. `checkPlatformCapabilities` in `lib/typeChecker/platformCheck.ts`
   reads `capabilitiesByFunction` instead of the effect tags. The call
   path ends at the function whose own tag carries the capability, named
   with its module as today, with the line "which needs fileRead". Delete
   `buildEffectCapabilities`.
5. `docs/dev/compiler/effect-propagation.md` gains the third view.
6. Tests in `platformCheck.test.ts`: a direct call to a tagged function,
   a call through an untagged wrapper in the same file, a call through an
   imported wrapper, a tool handed to `llm`, a function passed on, a
   function received as a parameter, a tagged node, the default platform.
   Keep the F3 cases that still apply.

### Task 3: the check at function entry

1. Codegen: the function wrapper's metadata gains `capabilities`, the
   function's own list, beside the markers. Read
   `docs/dev/language/agency-function.md` for where the metadata is
   emitted (the `createProps` object in `lib/backends/typescriptBuilder.ts`).
   A function with no tag emits nothing. A node's compiled form carries
   the list where `runNode` can read it; read `processGraphNode` for
   where a node's metadata goes.
2. One helper owns what happens at the edge of a callable, in
   `lib/runtime/capabilities.ts` (renamed from `effectCapabilities.ts`):

   ```ts
   enterCallable(run, name, capabilities, body)
   ```

   It calls `requireCapabilities(run.ctx.host, capabilities, name)` from
   `lib/host/host.ts`, converts a thrown `UnsupportedOnHostError` into
   the failure the design names, runs `body` when the host can serve the
   call, and in Task 5 also writes the `enter` and `exit` log lines. It
   has two callers and no copies: `AgencyFunction.invoke`, after
   `assertUsable` and before argument resolution, and `runNodeCore` in
   `lib/runtime/node.ts`, which both `runNode` and `runNodeForServe`
   already go through. Do not write the check, the conversion, or the
   log lines at a call site. Do not add a loop over `host.capabilities`;
   `requireCapabilities` is that loop, and its comment says it is the
   only one.
   - Write beside the helper, in the words `checkFailureArgs` uses: the
     body never begins, so its `pushHandler` calls never run, and no
     handler is skipped by a partial run.
   - The empty list needs no special case. Iterating nothing costs
     nothing.
3. `AgencyFunction` in `lib/runtime/agencyFunction.ts` gets a
   `capabilities` field. Four methods today build a derived copy by
   listing every field by hand: `withToolDefinition`, `partial`,
   `preapprove`, and `rename`. That is how a field gets lost, and
   `read.partial(dir)` is how `skillsDir` hands out tools. Add a private
   `derive(overrides)` that spreads the current options and applies the
   changes, rewrite the four methods to call it, and add the new field
   once, in the options type. No test for "the field survives
   derivation" is then needed, because nothing copies fields any more.
4. Delete `__registerEffectCapabilities`, `refuseUnservable`,
   `missingCapabilityFor`, and the registry. `interruptWithHandlers` in
   `lib/runtime/interrupts.ts` loses its call. The header import list in
   `imports.mustache` and `lib/runtime/portable.ts` lose the registration
   name; `make fixtures` and `make -j siblings` follow.
5. Statelog: nothing to decide. The entry failure goes through the same
   conversion as a refusal thrown inside the host, so it writes the same
   `error` event and shows in the logs viewer the same way. F3's
   `interruptThrown` and `interruptResolved` with `resolvedBy: "host"`
   go, since no interrupt is raised. Remove `"host"` from `resolvedBy` in
   `lib/statelogClient.ts` if nothing else writes it.
6. Tests:
   - A unit test on `enterCallable` with a `memoryHost` lacking the
     capability: the failure text, body never ran.
   - A unit test on `AgencyFunction.invoke` on the same host: refused,
     handler never pushed.
   - A unit test on `runNode` with a tagged node.
   - `tests/agency-js/host-capability-refusal` rewritten: the tag moves
     from `app::shell` to `runIt` and `askIt`, the handler still never
     prints, and the resume case is kept with the new message, which
     names the function instead of the effect.
   - The browser smoke test `tests/browser/browser.test.ts` accepts
     either message for `read` today. `read` is now refused at entry,
     before `files.locate` runs, so tighten the match to the entry
     message.

### Task 4: tag the stdlib

Replace the 143 effect tags with tags on functions. The decisions come
from the survey F3 made of what each function asks the host for;
`docs/dev/language/capabilities.md`, "How the stdlib tags were decided",
has the reasoning, and `--check-capabilities` in Task 5 checks the
result. A tag is the whole function, including code before a raise,
because the runtime check in Task 5 sees every host call the function
made.

Where a row says "every exported function", each function in the module
carries that tag. Repetition inside a module is the cost of having one
place to look; a function in such a module that needs less may carry
less.

| Module | Tag |
| --- | --- |
| `std::git` | every exported function: `fileRead, env, subprocess` |
| `std::github` | every exported function: `fileRead, env, network, subprocess` |
| `std::fs`, `std::spill`, `std::toolbox`, `std::skills` | every exported function: `fileRead, fileWrite`, except a function that only reads, which carries `fileRead` (the skills scans `docsSkill`, `agentSkill`, `agentPrompt`, `skillsDir`, `commandsDir`). A `std::fs` function that calls `bash` inherits `subprocess` through the call. |
| `std::shell` | `exec`, `bash`: `fileRead, subprocess`. `ls`, `grep`, `glob`, `stat`, `exists`: `fileRead`. `which`: `subprocess` (it calls `host.subprocess.locate`). |
| `std::http`, `std::weather`, `std::wikipedia`, `std::web/*`, `std::data/*`, `std::aws/s3`, `std::messaging/email`, `std::messaging/sms` | every exported function: `network` |
| `std::notes/apple`, `std::clipboard`, `std::auth/keyring`, `std::messaging/imessage` | every exported function: `subprocess`, including `isKeyringAvailable` |
| `std::auth/oauth`, `std::calendar` | every exported function, from the survey; the union is `fileRead, fileWrite, network, subprocess, env` |
| `std::speech`, `std::ocr`, `std::image`, `std::vision`, `std::memory` | per function, from the survey |
| `std::system` | `env`, `setEnv`: `env`. `openUrl`, `notify`: `subprocess`. `screenshot`: `fileRead, subprocess`. `isTTY`, `readStdin`: `terminal`. `exit`, `args`, `cwd`, `setTitle`: nothing. |
| `std::index` | `read`, `readBinary`: `fileRead`. `write`, `writeBinary`: `fileRead, fileWrite`. `print`, `input`: `terminal`. The rest: nothing. |
| `std::agency` | `typecheckFile`, `loadTemplate`, `testFile`: `fileRead`. `writeAST`, `formatFile`: `fileRead, fileWrite`. `run`, and its siblings `runFile`, `test`, `runCode`, `cli`: `subprocess, fileWrite`, confirmed against the survey. `walkAST`: nothing unless it reads a file. |
| `safeBash`'s planner | `fileRead, subprocess` |
| `std::agency/local`, `std::mcp`, `std::ui` | per function, from the survey. These modules were on F3's Node-only list; the tags are what keep them off the browser now. |

1. Write the tags. `make` formats the stdlib, so run it and check the
   tags survive.
2. `lib/stdlibCapabilities.test.ts` becomes a rule over data the
   compiler already produces. It does not walk bodies or follow calls
   itself; the propagation pass does that. For every exported stdlib
   function it reads two things from the symbol table built in Task 2:
   the transitive `capabilities` list, and the callee names
   `collectBodyFacts` already gathers. The rule: a function whose
   transitive callees include a `stdlib-lib` import has a non-empty
   list, or is on an allow list of functions that touch nothing on the
   host (`range`, the `std::date` and `std::path` functions, and the
   like). The allow list is in the test, with a sentence per group.
   Because the test reads the pass's output, a tag the pass cannot see
   fails here before it is a gap anywhere else.
3. `agency doc`: `lib/cli/doc.ts` renders a function as its signature,
   docstring, and a `Throws:` line, and shows no function tags today.
   Add a `Needs:` line beside `Throws:`, read from
   `capabilitiesByFunction`, so it shows the transitive list a reader
   wants. Run `make` and check `docs/site/stdlib/shell.md` shows `Needs:
   fileRead` on `exists` and `Needs: fileRead, subprocess` on `exec`.

### Task 5: the test runner check

1. `enterCallable` from Task 3 is the one place that knows when a
   function or node starts and ends. With `--check-capabilities` on, it
   appends `enter <name> <capabilities>` and `exit <name>` to the
   capability log (`lib/runtime/capabilityLog.ts`). The `exit` line is
   written in a `finally`, so a body that throws, returns a failure, or
   is aborted still leaves the stack. A missed exit covers every later
   host use in the case, which is a false pass. Neither `invoke` nor
   `runNodeCore` writes a log line itself. `recordRaise` goes away; a
   raise is no longer what the check compares against. Cache the sink
   lookup per run rather than reading the setting on every entry.
2. `checkCapabilityLog` in `lib/cli/capabilityCheck.ts`: a host use is
   covered when some function on the entered-and-not-exited stack at that
   moment declares the capability. A use with no such function fails the
   case and names the innermost entered function. Parallel blocks, forks,
   and concurrent tool calls interleave entries, and the stack is really
   the set of every in-flight function across branches, so a use is
   covered if any in-flight function declares the capability. The errors
   this produces are false passes. Say so in the dev doc, so a green CI
   is not read as proof.
3. `UNCHECKED_CAPABILITIES` loses `env` and `terminal`. F3 left them out
   because `print` raised nothing and `env()` raised before many uses.
   With attribution to a function, `print` and `input` carry `terminal`,
   and `env` and `setEnv` carry `env`. Keep `llm` out, since both
   platforms have it. If either new name turns up a wrong tag the survey
   missed, fix the tag.
4. Delete `silentHostUse` from `lib/testFormat/schema.ts` and from the
   thirteen test files that carry it. The tags on the skills scans and
   `std::memory` cover what they were for. If a case still fails after
   Task 4, the tag is wrong, and the fix is the tag.
5. Keep the flag on in CI.

### Task 6: docs

1. `docs/site/guide/capabilities.md`: the tag on a function and on a
   node, the `exists` example, the untagged wrapper that inherits, what
   `--platform browser` reports, the failure at function entry as a tool
   call shows it to a model, and the one sentence about top-level code.
   The table against handlers and policies stays.
2. `docs/dev/language/capabilities.md`: rewrite around the function as
   the owner of the tag. Keep the sections on the test runner check and
   the platform check, with their new inputs. Replace "How the stdlib
   tags were decided" with the table from Task 4. Say that `callPlain`
   TypeScript helpers are not wrapped and get no check. Say in one
   sentence why two mechanisms carry a tag to the runtime: `@always` goes
   through a registry at module load because an effect has no runtime
   object to hang data on, and `@capabilities` rides on the wrapper
   because a function has one. The next reader should not try to unify
   them. Update the index
   line in `CLAUDE.md` and the `agency-language-docs` skill.
3. `docs/dev/language/agency-function.md`: the entry check, in the list
   of what the wrapper does before the body.
4. `docs/dev/runtime/host.md` and the `CAPABILITIES` comment in
   `lib/host/host.ts` both say the tag sits on an effect declaration. One
   line each.
5. The host plan's status table and a "What this PR learned" entry in
   `docs/superpowers/plans/2026-10-05-host-and-platforms.md`.

Review focus: the table in Task 4, which is the whole stdlib's word on
what it needs, and the message a user and a model see from the entry
check.

## Out of scope

- A tag on a module or on an import. See the decisions above.
- Checking top-level code. See the decisions above.
- Making the browser bundle smaller.
- smoltalk in the browser, which has its own plan in the smoltalk repo.

## What the review changed

The first draft of this plan had a module tag beside the function tag.
The review found that
a module tag leaks: `std::shell`'s module-wide `subprocess` reached
`std::skills` through `exists`, and from there every stdlib agent. It also
found that the module tag's position was ambiguous at the top of a file,
where the preprocessor attaches a tag to whatever follows it. The module
tag came out, and with it the position rules, AG3027's replacement for
two module tags, and the per-module rows of the stdlib table.

The other changes from the review, each now in a task:

- The capability walk is a third view in `lib/analysis/effects.ts`, not a
  second walk in the type checker (Task 2).
- Nodes get the runtime check, since they do not go through
  `AgencyFunction.invoke` (Task 3).
- The resume case's expected message changes, and the F3 test's tagged
  user effect becomes an error (Task 3).
- The message tells a model not to retry (design).
- `agency doc` gains a `Needs:` line (Task 4).
- The `exit` log line is written in a `finally`, and interleaving is
  described as producing false passes (Task 5).
- `env` and `terminal` join the checked capabilities (Task 5).
- The release timing of F3 and this PR is stated (top of file).

A second pass checked the plan against
`docs/dev/contributing/anti-patterns.md` and changed five things:

- The entry check calls `requireCapabilities` in `lib/host/host.ts`
  instead of reading `host.capabilities` in a new loop. That also gives
  the entry failure the host's own message and statelog event, so the
  statelog question from the first draft went away (design, Task 3).
- The check and the log lines live in one helper, `enterCallable`, with
  two callers, instead of being written at each entry point (Tasks 3
  and 5).
- `AgencyFunction` gets a `derive(overrides)` method, and the four
  derivations use it, instead of a sixth field copied by hand through
  each one (Task 3).
- The stdlib coverage test reads the propagation pass's output instead
  of walking calls again (Task 4).
- The empty-list fast path and the per-node-type branches for AG3028 are
  gone (Tasks 1 and 3).
