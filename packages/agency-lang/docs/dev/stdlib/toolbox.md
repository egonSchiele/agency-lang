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
- `meta.json` holds the purpose, the request type text, and the usage
  record.

A program runs a tool with `runTool(name, request)`, or imports it
directly: `import { tool as getNews } from ".../getNews/tool.agency"`.

## Why a template

The first version had the coding agent write the whole module, and a
200-line checker walked the AST to confirm the exports, the guard, its
limits, that finalize runs, and the docstring. With a template, every one of
those is fixed text, so there is nothing to check. What varies is filled
through holes: the two limits and the purpose string.

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
stages, and calls `rounds`. On failure it clears staging once, and a
refused delete is folded into the returned failure. On success the publish rename
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
start when `<dir>/staging/<name>` already exists, naming the directory.
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
any other answer as a `WriteToolReview` with the bang syntax, so a
`revise` without a string `feedback` fails, naming the answer. A
`revise` with empty feedback fails too, because the next round would
get the identical brief.

The typechecker does not carry a `Result` narrowing past a `continue`,
so `rounds` branches on `is failure` / `is success` instead of
narrowing and continuing.

## Reading a toolbox

`listTools` raises one `std::toolbox::scan` interrupt for the directory,
lists it with `ls` from `std::shell`, and keeps the directories whose
names are not `staging` and do not start with a dot. An empty `dir` is
refused, since the primitives would resolve it to the process cwd. `ls`
counts every entry against its cap and does not say when it stopped,
so a listing that reaches the cap is reported as a failure rather than
a shortened catalog. The per-tool reads
of `impl.agency` and `meta.json` use `_read`, covered by that one scan
approval, as `std::skills` does. A toolbox directory that does not exist
yet is an empty catalog.

Each entry carries `module` (what `describe` says about `run`: signature,
docstring, effects) and `meta`. `describe` cannot resolve a local import,
so it reads `impl.agency`, not `tool.agency`. A missing `meta.json` means
the default record. A present `meta.json` can fail three ways: it
cannot be read, it is not JSON, or it fails validation as a `MetaFile`.
Any of these marks the entry `broken`.

## `runTool`

`runTool` checks the tool exists, runs `main` through `runFile` (which
raises its own read and run interrupts), and then rewrites `meta.json`
with one more use, the time, and the outcome (`ok` or the failure
message), keeping the last ten outcomes. It returns the node's own
`Result`.

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

## A checker fix this needed

`null` reaches the type checker as a `variableName` node. The template
name check (AG8015) reported it as undefined, so a template could not
include `return null`. `templateNames.ts` now skips `null` and `undefined`,
the way `isNullExpr` in `narrowing.ts` already did.

## Later pieces

Revision of an existing tool, retirement, the agency-agent integration,
skills, and one real-LLM end-to-end test once there is a place for
real-LLM stdlib tests (today they run only from `lib/agents`).
