# Review: capabilities on functions and modules

Reviewed: `docs/superpowers/plans/2026-10-13-capabilities-on-functions.md`,
against PR F3 (#1193, branch `host-f3`, still open) and the code it adds.

## Verdict

The design is right. A capability is a fact about code, and the tag
belongs on the code. Moving the runtime check from the raise to function
entry is also right, because the wrapper is one place every call goes
through, including a tool call from a model and a call replayed on resume.

Four things need a decision or a change before anyone builds this. They
are the first four sections below. The rest are smaller corrections to
the tasks, in task order.

## 1. Module tags leak through imports

Task 4 gives `std::shell` the module tag `fileRead, subprocess`. Other
stdlib modules import single functions from it:

| Importer | Imports from `std::shell` |
| --- | --- |
| `std::skills` | `exists` |
| `std::toolbox` | `ls`, `exists` |
| `std::fs` | `bash`, `glob`, `ls`, `grep` |
| `std::agency` | several |
| `std::agents/lib/toolkits`, `std::agents/agency/coding`, `std::safeBash`, `std::llm`, `std::policy` | various |

Task 2 computes what a function needs as the union over the functions it
calls. So `skillsDir` in `std::skills` needs `subprocess`, because it
calls `exists`, which carries the module tag of `std::shell`. Every
stdlib agent calls `docsSkill` or `agentSkill` at startup. Under
`--platform browser`, every one of them is refused for a capability it
never uses, and the AG3029 path ends at `exists`, which a reader will
find confusing, since `exists` runs no program.

The plan's argument for over-wide module tags is that "a user who cannot
give the module all of it cannot use it on that platform anyway". That
holds for a user who calls the module directly. It does not hold for a
module that imports one function from it.

The rule I would add to Task 4: a module tag is right only when every
exported function needs the whole tag, or when no other module imports
from it. `std::shell` fails both halves and should be tagged per
function:

| Function | Tag |
| --- | --- |
| `exec`, `bash` | `fileRead, subprocess` |
| `ls`, `grep`, `glob`, `stat`, `exists` | `fileRead` |
| `which` | `subprocess` (it calls `host.subprocess.locate`) |

Check the other module rows the same way. `std::fs` imports `bash`, so
its functions that reach `bash` carry `subprocess` through the union,
which is correct, and its module tag of `fileRead, fileWrite` is fine
for the rest. `std::system` and `std::index` are already per function.
`std::git` and `std::github` are imported by nobody else in the stdlib,
so their module tags do not leak.

The test in Task 4.2 should enforce the rule: a module tag on a module
that another stdlib module imports from fails the test unless the test
lists the module with a sentence.

## 2. The module tag's position is ambiguous at exactly the spot it uses

The plan says the module tag goes "after the module's doc comment and
before any import", and that position alone marks it as the module's.
Two facts about the code cut against that.

The stdlib does not agree on where the module doc comment goes. Thirty
nine files start with `/** @module`. Fifty put the imports first and the
doc comment after them. The sentence in the plan matches neither group
as a rule.

`attachTags` in the preprocessor attaches a pending tag to the next
`function`, `graphNode`, `assignment`, `functionCall`, `typeAlias`, or
`effectDeclaration`. It leaves a tag standing alone only when the next
node is something else, such as an import. So this is a module tag:

```
@capabilities(network)
import { fetchJSON } from "std::http"
```

and this attaches to the type alias and is a stray tag under the plan's
rules:

```
@capabilities(network)
type Reply = { body: string }
```

Eight stdlib files begin with an export, a type alias, or a doc comment
rather than an import, so the second shape will come up.

Two ways out. The plan can keep position and define it as "the first
node of the file, before any import or declaration, with comments
ignored", and `moduleCapabilities` can look at both a standalone tag and
a tag attached to a leading type alias or static const. Or the module
tag can have its own name, such as `@moduleCapabilities(...)`, which
removes the question and reads better at the top of a 900 line file. The
plan says the decision is closed. I would reopen it for this one point,
because the ambiguity sits on the one line the rule depends on.

## 3. Nodes are not wrapped, so a node's tag has no runtime check

The plan says "a node may carry the tag too" and "the check treats it
the same way", and puts the runtime check in `AgencyFunction.invoke`.
Nodes do not go through `invoke`. A node runs through `runNode` in
`lib/runtime/node.ts` and the graph engine. So a node's tag is checked
at compile time under `--platform browser` and never at run time. The
same gap hits Task 5: the `enter` and `exit` lines come from the wrapper,
so a host use made directly in a node body is attributed to no function.

Either add the check and the log lines at the start of `runNode` (and
the serve entry point, `runNodeForServe`), or say in the dev doc that a
node's tag is read by the compiler only and the runtime relies on the
functions the node calls. The first is a few lines and keeps the plan's
sentence true.

## 4. F3 is unmerged, and the two PRs change the same syntax

The plan is based on `main` after F3 merges. F3 puts `@capabilities` on
143 effect declarations and documents that form in the guide. This plan
makes that form an error (AG3028). If F3 ships in a release before this
plan lands, a tag that is valid in one version is an error in the next.

v0.27.0 went out on Oct 3 without any of the F series. Land this before
the next release, or have Task 1 report the effect form as a warning for
one release instead of an error. Rebasing this work onto `host-f3` would
avoid the question but would make a stacked PR, which the repo avoids.

## Task 1: the tag's new places

- AG3027 (two declarations of one effect disagree) is retired. Do not
  reuse the code. `docs/site/diagnostics/index.md` is generated from the
  registry, so the entry should stay with a "retired" note, or the
  explanation file should say what happened to it.
- `attachTags` also attaches a tag to a `functionCall` and an
  `assignment`. A `@capabilities` tag above a top-level `static const` or
  a bare call is a stray tag and should get AG3028. Add those two to the
  Task 1.6 test list.

## Task 2: what a function needs

The plan builds the walk in `lib/typeChecker/interruptAnalysis.ts` beside
`analyzeInterruptsFromScopes`, and separately has the symbol table record
each file's tags. That is two walks over the same edges.

`interruptEffectsByFunction` is not built by the type checker. It is
built by `propagateEffects` in `lib/analysis/effects.ts`, which runs at
the end of `SymbolTable.build` once per entry in `EFFECT_VIEWS`, across
every file, through re-exports, with a worklist. The type checker only
adds to it. Capabilities fit as a third view: the seed for each callable
is its own tag plus its module's tag instead of its direct raises, and
the union to a fixed point is the same code. `compilationUnit.ts` then
builds `capabilitiesByFunction` with `effectTable` the way it builds the
other two. The checker adds what it learns from function-typed
parameters, as it does for effects.

This gives three things for free: the same resolver through barrels, the
same under-report invariant and its oracle test, and the data `agency
doc` needs (section on Task 4 below).

The dev doc `docs/dev/compiler/effect-propagation.md` should gain the
third view.

## Task 3: the check at function entry

- **Derived copies.** `AgencyFunction` is constructed in five places:
  `create`, `withToolDefinition`, `partial`, `preapprove`, and `rename`.
  Each copies the fields by hand. `read.partial(dir)` is how `skillsDir`
  hands out tools, so a `capabilities` field missing from one constructor
  means a derived tool skips the check. Add a unit test that
  `.partial().rename().describe().preapprove()` keeps the list, the way
  `registeredName` is tested.
- **Handlers.** The check runs before the body, so the body's
  `pushHandler` calls never run, and no handler is skipped by a partial
  run. That is the same argument `checkFailureArgs` makes in its
  comment. Write it down next to the check, since the repo treats a
  skipped handler as a critical issue.
- **Resume.** A resume replays the node from the top and re-enters the
  call that was in progress through `__call` and `invoke`, so the entry
  check runs again on the new host. The plan's "resume case kept" is
  right, but the expected text changes: the F3 test expects
  `app::shell needs the subprocess capability`, and the new check will
  say `runIt needs the subprocess capability`. The test also declares a
  user effect with the tag, which becomes an error. Say both in Task
  3.4.
- **Shape of the failure.** Today a host refusal throws
  `UnsupportedOnHostError` inside the body, and the generated catch
  turns it into `runtimeFailure(...)` with the function name, the
  arguments, the result checkpoint, and a statelog `error` event. The
  plan returns a bare `failure(message)` from `invoke` instead. That is
  the shape failure propagation uses, so it is consistent, but it loses
  the statelog `error` event and the F3 interrupt events that showed the
  refusal in a trace. Decide which one you want in the logs viewer and
  say so in Task 3.3. "Nothing new" is a choice, not a given.
- **The message, as the model reads it.** When a tool fails at entry,
  the tool loop hands the failure text to the model. The planned text
  tells it what is missing but not that retrying is pointless. One more
  sentence helps: `exists needs the fileRead capability, which the
  browser host does not have. No tool call can supply it.`
- **Cost.** `invoke` is on every call. Precompute the list in the
  constructor and skip the loop when it is empty, so a program with no
  tags pays one length check.
- `callPlain` TypeScript helpers are not wrapped and get no check, which
  matches the "no tag on imports" decision. The dev doc should say so in
  one line.

## Task 4: the stdlib table

Beyond section 1:

- `std::agency`: the row names `typecheckFile`, `loadTemplate`,
  `testFile`, `writeAST`, `formatFile`, `run`. The module also exports
  `runFile`, `test`, `runCode`, `walkAST`, and `cli`. Decide each.
- `std::system`: `isTTY` and `readStdin` fall under the last row
  ("a function tag where the module has none"). Put them in the
  `std::system` row as `terminal`, so the table is complete on its own.
- The AG3029 example reads "which is tagged fileRead". With a module tag
  the function is not tagged; the module is. Write the path line as
  `main calls exists from std::shell (main.agency:4), which needs
  fileRead` and let the message not say where the tag sits.
- **`agency doc` does not show function tags.** Task 4.3 says to "check
  the generated docs for one module tag and one function tag", but
  `lib/cli/doc.ts` renders a function as its signature, docstring, and a
  `Throws:` line. Effect tags showed up in F3 only because the generator
  prints the whole effect declaration. Add a task: a `Needs:` line beside
  `Throws:`, read from `capabilitiesByFunction` (the transitive list,
  which is what a reader wants), and the module tag in the module header.

## Task 5: the test runner check

- **Exit on every path.** The `exit` line must be written in a `finally`,
  for a body that throws, returns a failure, or is aborted. A missed exit
  leaves the function on the stack for the rest of the case, and every
  later host use is covered by it. That is a false pass, which is the
  wrong direction for this check.
- **What interleaving does.** The plan says a use attributed to the wrong
  branch "shows up as a wrong-tag report, which is the same false
  positive the check has today". It is mostly the opposite. The
  entered-and-not-exited set spans all in-flight branches, so a use is
  covered if any in-flight function anywhere declares the capability.
  Interleaving produces false passes, not false failures. Say that, so
  nobody reads a green CI as proof.
- **Add `env` and `terminal` back.** F3 left them out because `print`
  raises nothing and `env()` raised before many uses. With attribution to
  a function, `print` and `input` carry `terminal` and `env` and `setEnv`
  carry `env`, so both can be checked. Try it and keep whichever stays
  green. `llm` stays out, since both platforms have it.
- **The memory block.** `_popMemoryFrame` persists the frame when a
  `memory` block ends. It is called from a `def` in `std::memory`
  (`stdlib/memory.agency:184`), so the module tag covers it. Good. The
  thirteen `silentHostUse` files are agents whose startup scans the docs
  through `std::skills`, also covered. Deleting the field should work
  once section 1 is fixed. If a case still fails, section 1 is the first
  place to look.

## Task 6: docs

- `docs/dev/runtime/host.md` says the tag sits on an effect declaration
  (the `CAPABILITIES` comment in `lib/host/host.ts` says the same). Both
  need the one-line update.
- The guide page should show the failure a user sees from a tool call,
  since that is where most people will meet it.

## Smaller notes

- `print` is tagged `terminal`, so a `memoryHost` built without
  `terminal` in a unit test fails at the entry check instead of inside
  `_print`. Same outcome, different message. A few existing tests may
  match on the old text.
- The browser smoke test (`tests/browser/browser.test.ts`) accepts
  either refusal message for `read`. With the entry check, `read` is
  refused before `files.locate` runs, so the message is the entry one.
  Tighten the regex once the check lands.
- The `AGENCY_CAPABILITY_LOG` setting is read on every raise in F3 and
  will be read on every function entry under Task 5. Cache the sink
  lookup per run, not per call, or the test suite gets slower.
