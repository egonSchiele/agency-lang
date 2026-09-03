# std::toolbox

A toolbox is a directory of tools an agent wrote and keeps. This note
records the decisions behind `stdlib/toolbox.agency`.

## What a tool is

One directory per tool under the toolbox (default `~/.agency-agent/tools`):

- `impl.agency` is what the coding agent writes. It exports
  `type Request` and `def run(request: Request): Json`.
- `toolbox.agency` generates `tool.agency` from a template. It imports
  `run` and `Request` from `impl.agency` and wraps `run` in a guard with
  time and cost limits (the wrapper is `runGuarded`). It exports `tool`,
  which is `runGuarded` with the purpose set through `.describe()`, and
  `node main`.
- `tool.test.json` holds generated test cases, only for a tool that does
  nothing but compute.
- `meta.json` holds the purpose, the request type text, the creation
  time, the time limit, and a use count with the last-used time. It
  records no outcomes or results, because a failure message can carry
  the request's contents. It does not hold the tool's name either; the
  directory name is the only name.

A program runs a tool with `runTool(name, request)`, or imports it
directly: `import { tool as getNews } from ".../getNews/tool.agency"`.

## Why a template

Every fixed part of the contract (the exports, the guard and its limits,
the signatures) is template text, so nothing checks a draft's shape.
What varies is filled through holes: the two limits and the purpose
string. The guard has no `finalize`. A tool that trips its limit fails, and
`runTool` returns that failure instead of a partial value that looks
like success.

`runFile` and `typecheckFile` resolve `.agency` imports inside the
tool's directory, so `tool.agency` can import `impl.agency`. A code
literal that imports a name declares it for the template check, so the
template can use `run` and `Request` even though neither exists until
fill time.

There is no hole in type position, so `tool` returns `Result<Json>` for
every tool. There is no hole in docstring position either, so the
purpose goes through `.describe()` on the exported `tool` and into
`meta.json`. `runGuarded` keeps a fixed docstring.

Both entry points take the request type as Agency type text, such as
`"{ topics: string[]; maxItems: number }"`. They parse
`export type Request = <text>` and require exactly one type alias back.
The brief tells the coding agent to copy that line as is; a draft that
changes it fails the typecheck of `tool.agency`.

## Two entry points, one save gate

`designTool` is the design loop: the coding agent drafts, the review
agent and the typecheck vet the draft, and the user sees it in a
`std::toolbox::review` interrupt that can accept or ask for a revision.
`writeTool` is the plain primitive: the caller already has the `run`
source, and no model is called. Both publish through `gateAndSave`,
which raises one `std::toolbox::save` interrupt (the toolbox root, the
name, the source, and its effects) and then calls `saveTool`. So every
tool that enters a toolbox raises the save effect, whichever way it was
made, and a policy that matches `std::toolbox::save` sees all of them.
A rejection there publishes nothing.

An accepted design therefore raises two interrupts in a row: the review
with its revise option, then the save. The second look is deliberate.
The review is where the user shapes the tool; the save is the one
effect a policy can pin. `designSkill` in `std::skills` ends the same
way, by calling `writeSkill`.

`designTool` does not call the exported `writeTool` for that last step.
It would have to stage a second copy and typecheck it again, and the
generated `tool.test.json` from the design's own staging directory would
not come along. Sharing `gateAndSave` gives the same effect without the
copy.

`stage` is what the two share up front: expand the root, check the name,
the time limit, and the request text, then make the call's staging
directory. Every check runs before anything is written or anyone is
asked. `clearStaging` is the shared tail: on failure it removes the
staging directory once and folds a refused delete into the returned
failure. On success the publish rename has already emptied staging, so
no delete interrupt is raised.

## `designTool` is a pipeline

`draftSource` → `reviewSource` → `testSource` (together `prepareDraft`)
→ `askUser` → `gateAndSave`, each a def with one job that returns a
`Result`. `rounds` is the loop; `feedback` is its only state, holding
the last problem or the user's revision request. Only a `DraftProblem`
(a coding-agent failure, review findings, a typecheck or compile error,
a failed test) becomes feedback. Any other failure, such as a refused
write or a review agent that did not run, ends the loop at once, since
another draft cannot fix it.

`writeTool` is `stage` → `assembleTool` → `gateAndSave`. A compile or
typecheck failure arrives from `assembleTool` as a `DraftProblem`, the
shape the design loop feeds back to the coding agent. With no loop to
feed, `problemText` returns the message as a plain failure. No tests are
generated: the design loop tests a draft it produced, and a caller who
wrote the source is expected to have tested it.

`testSource` starts with `assembleTool`: write `impl.agency`, fill the
template, write `tool.agency`, compile the pair in the sandbox, and
typecheck it. The compile resolves the imports and refuses TypeScript,
Node, and `pkg::` imports anywhere in the closure; a draft that exports
the wrong names fails there, and the message becomes the next round's
feedback. The typecheck runs second because it does not police imports,
and a typecheck that fails after a clean compile is a read error, which
ends the loop. That is the only import check in this module. Without it a
draft could import a raw primitive such as `_which` from
`agency-lang/stdlib-lib/shell.js`, which raises no interrupt and so
never shows in the effect list.

`stage` and `listTools` expand `~` in `dir` once, up front, with the
stdlib's `expandPath`. The file primitives expand it themselves, but the
sandboxed `testFile` resolves its directory without expansion, so an
unexpanded default would have made every generated test run fail.

### Publishing is one rename

Every round writes into the call's own `<dir>/staging/<name>-<random>`. The staging directory is
not a dot directory. The built-in with-writes policy (the approval
policy that allows writes under a path glob) scopes writes with
`base/**`, and `**` does not match a dot-led segment. A `.staging`
directory would have prompted on every mkdir. `staging` is therefore a
reserved tool name, and `listTools` skips it. Each call stages under
`staging/<name>-<random>`, so two concurrent writes of one name never
share a draft; the publish rename is the only point of contention, and
the second one fails because the target exists. A crashed write leaves
its directory behind for the user to remove. A round whose tool has an
effect removes a `tool.test.json` that an earlier pure round left
behind, so a revision that starts calling a model does not ship the old
tests. `saveTool` re-checks that `<dir>/<name>` is still free (the check
in `checkName` is stale after the approval and any model calls) and then
`move`s the staged directory into place. A tool is either fully present or absent.

### Only pure tools are tested

`llm()` raises no interrupt, so it cannot be scripted in a sandbox test
file. A scripted approval of a network effect would let the real call
through anyway. So `testSource` generates and runs tests only when
`run` has an empty effect list and the source calls none of `llm`,
`today`, `now`, or `random` (`UNPREDICTABLE_CALLS`), under their own
names or an import alias. A call reached some other way, such as a
helper module that calls `now()`, is not seen; that tool gets tests
that fail, and the round's feedback says so. A tool that stamps a date
computes without effects, but exact expected values for it would be
wrong tomorrow.

### What the handler may return

A rejected interrupt halts `askUser` and returns the rejection to
`rounds`, which returns it; nothing after the interrupt runs. A bare
`approve()` arrives as `null` and counts as accept. `askUser` validates
any other answer as a `WriteToolReview` with the bang syntax (the `!`
runtime-validation operator), so a `revise` without a string `feedback`
fails; the failure names the answer. A
`revise` with empty feedback fails too, because the next round would
get the identical brief.

## Reading a toolbox

`listTools` raises a `std::toolbox::scan` interrupt for the directory.
It then lists the directory with `ls` from `std::shell` (which raises
`std::ls`), and keeps the directories whose names are not `staging` and
do not start with a dot. The recommended policy gives `std::toolbox::scan` the same `dir` scope
as `std::read`, so a toolbox outside the working directory prompts. `listTools` refuses an empty `dir`, since the
primitives would resolve it to the process cwd. `ls` counts every entry
against its cap and does not say when it stopped, so a listing that
reaches the cap is reported as a failure. It is not returned as a
shortened catalog. The per-tool reads
of `impl.agency` and `meta.json` use `_read`, covered by that one scan
approval. `runTool` and the post-publish read in `saveTool` raise the
same scan for the one tool directory they read, so no `_read` runs
without an approval that names its directory. A toolbox directory that does not exist
yet is an empty catalog.

Each entry carries `module` (what `describe` says about `run`: signature,
docstring, effects) and `meta`. `describe` cannot resolve a local import,
so it reads `impl.agency`, not `tool.agency`. A missing `meta.json` means
the default record. A present `meta.json` can fail three ways: it
cannot be read, it is not JSON, or it fails validation as a `MetaFile`.
Any of these marks the entry `broken`.

## `runTool`

`runTool` checks that the name is an identifier, since it becomes a
path segment. It reads `meta.json` before the run, so a corrupt record
stops the tool before it has side effects. It then runs `main` through
`runFile`, with `wallClock` set to the tool's own `maxTime` plus
headroom, so the guard trips before the subprocess is killed. `runFile`
clamps `wallClock` to an hour, so `stage` refuses a `maxTime` above
an hour minus that headroom. It then rewrites `meta.json` with
one more use and the time. If that write fails, the returned failure
carries the tool's result in its message, since the tool has already
run. Otherwise it returns the node's own `Result`.

## Model calls and mocks

Per round: one call in the coding agent (its internal review has no
task, so it draws no separate mock), one in the review agent (it has a task), and, for
a pure tool only, one for the test cases. The review runs before the
tool is assembled, so a draft with the wrong export still draws the
review mock. `tests/agency/toolbox/generate-designTool-mocks.mjs`
regenerates `designTool.test.json`; run it whenever
`fixtures/tools/good/impl.agency` changes. A stale copy fails the coding
agent's own check and silently spends the round's mocks.

`tests/agency/toolbox/writeTool.agency` covers the plain primitive with
no mocks at all, so a model call anywhere on its path fails the suite.
It feeds the good fixture's source in by hand, and edits it to make the
wrong-export and raw-import sources.

`designTool.agency` and `writeTool.agency` write under
`tests/agency/toolbox/test-output/` (gitignored) and remove what they
made. A `tool.test.json` left there is
picked up by `agency test tests/agency/toolbox` and refused by the full
profile (`args` is sandbox-only), so tests must clean up.

## Later pieces

Revision of an existing tool, retirement, the agency-agent integration,
skills, and one real-LLM end-to-end test once there is a place for
real-LLM stdlib tests (today they run only from `lib/agents`).
