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
  the request's contents.

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

`writeTool` takes the request type as Agency type text, such as
`"{ topics: string[]; maxItems: number }"`. It parses
`export type Request = <text>` and requires exactly one type alias back.
The brief tells the coding agent to copy that line as is; a draft that
changes it fails the typecheck of `tool.agency`.

## `writeTool` is a pipeline

`draftSource` → `reviewSource` → `testSource` (together `prepareDraft`)
→ `askUser` → `saveTool`, each a def with one job that returns a
`Result`. `rounds` is the loop; `feedback` is its only state, holding
the last problem or the user's revision request. `writeTool` validates,
stages, and calls `rounds`. On failure, it clears staging once and
folds a refused delete into the returned failure. On success the publish rename
has already emptied staging, so no delete interrupt is raised.

`testSource` starts with `assembleTool`: write `impl.agency`, fill the
template, write `tool.agency`, and typecheck it. A draft that exports
the wrong names fails there with the compiler's message, which becomes
the next round's feedback. `typecheckFile` resolves imports but does
not police them, so `assembleTool` then runs the sandboxed `compile`,
which refuses TypeScript, Node, and `pkg::` imports anywhere in the
closure. That is the only import check in this module. Without it a
draft could import a raw primitive such as `_which` from
`agency-lang/stdlib-lib/shell.js`, which raises no interrupt and so
never shows in the effect list.

`writeTool` and `listTools` expand `~` in `dir` once, up front, with the
stdlib's `expandPath`. The file primitives expand it themselves, but the
sandboxed `testFile` resolves its directory without expansion, so an
unexpanded default would have made every generated test run fail.

### Publishing is one rename

Every round writes into `<dir>/staging/<name>`. The staging directory is
not a dot directory. The built-in with-writes policy (the approval
policy that allows writes under a path glob) scopes writes with
`base/**`, and `**` does not match a dot-led segment. A `.staging`
directory would have prompted on every mkdir. `staging` is therefore a
reserved tool name, and `listTools` skips it. `writeTool` refuses to
start when `<dir>/staging/<name>` already exists; the failure names the
directory.
Deleting it instead would let two concurrent writes of the same name
destroy each other's drafts; a crashed write leaves a directory the
user removes by hand. A round whose tool has an
effect removes a `tool.test.json` that an earlier pure round left
behind, so a revision that starts calling a model does not ship the old
tests. `saveTool` re-checks that `<dir>/<name>` is still free (the check
in `checkName` is stale after several model calls) and then `move`s the
staged directory into place. A tool is either fully present or absent.

### Only pure tools are tested

`llm()` raises no interrupt, so it cannot be scripted in a sandbox test
file. A scripted approval of a network effect would let the real call
through anyway. So `testSource` generates and runs tests only when
`run` has an empty effect list and the source calls none of `llm`,
`today`, or `now` (`UNPREDICTABLE_CALLS`). A tool that stamps a date
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
do not start with a dot. The recommended policy approves `std::toolbox::scan`; the `std::ls`
behind it keeps that policy's read scope, so a toolbox outside the
working directory still prompts for the listing. `listTools` refuses an empty `dir`, since the
primitives would resolve it to the process cwd. `ls` counts every entry
against its cap and does not say when it stopped, so a listing that
reaches the cap is reported as a failure. It is not returned as a
shortened catalog. The per-tool reads
of `impl.agency` and `meta.json` use `_read`, covered by that one scan
approval. A toolbox directory that does not exist
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
headroom, so the guard trips before the subprocess is killed. It then rewrites `meta.json` with
one more use and the time. If that write fails, the returned failure
carries the tool's result in its message, since the tool has already
run. Otherwise it returns the node's own `Result`.

## Model calls and mocks

Per round: one call in the coding agent (its internal review has no
task, so it draws no separate mock), one in the review agent (it has a task), and, for
a pure tool only, one for the test cases. The review runs before the
tool is assembled, so a draft with the wrong export still draws the
review mock. `tests/agency/toolbox/generate-writeTool-mocks.mjs`
regenerates `writeTool.test.json`; run it whenever
`fixtures/tools/good/impl.agency` changes. A stale copy fails the coding
agent's own check and silently spends the round's mocks.

`writeTool.agency` writes under `tests/agency/toolbox/test-output/`
(gitignored) and removes what it made. A `tool.test.json` left there is
picked up by `agency test tests/agency/toolbox` and refused by the full
profile (`args` is sandbox-only), so tests must clean up.

## Later pieces

Revision of an existing tool, retirement, the agency-agent integration,
skills, and one real-LLM end-to-end test once there is a place for
real-LLM stdlib tests (today they run only from `lib/agents`).
