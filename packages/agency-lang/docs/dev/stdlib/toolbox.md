# std::toolbox

A toolbox is a directory of tools an agent wrote and keeps. This note
records the decisions behind `stdlib/toolbox.agency`. The spec that led
to it is `2026-08-28-self-written-tools-spec.md` at the package root.

## What a tool is

One directory per tool under the toolbox (default `~/.agency-agent/tools`):
`tool.agency`, `tool.test.json`, `meta.json`. The module exports exactly
`type Request`, `def tool(request: Request)`, and `node main(request:
Request)`. Fixed names mean one export to describe and exact static
checks. A program imports a tool with an alias:
`import { tool as getNews } from ".../getNews/tool.agency"`.

`tool` returns the `Result` of the guard that wraps its work. A guard
evaluates to a `Result` (see the guards guide), so a `tool` declared to
return a plain value does not typecheck, and the coding agent's own
check rejects it before `writeTool` ever sees it. `main` returns the
same `Result`, which is why a conforming tool's effect list is never
empty: it always carries `std::guard`.

## Why the coding agent writes the whole module

The first design used a Template Agency skeleton so the coding agent
would write only the body. A template's own `def tool(request: Request)`
cannot mention a `Request` that arrives through a hole (a fragment that
fills a hole cannot supply a name another part of the template uses),
and there is no hole in type position. So `writeTool` asks for the whole
module and enforces the shape with `checkToolShape` plus the review
agent. A type-position hole would let the skeleton own the guard and
exports again; that is a follow-up.

## The shape checker is facts plus rules

`shapeFacts` is the one def that knows AST field names; it reduces a
module to a flat record (exported names including `export const`, the
guard `tool` returns, that guard's named arguments, the `tool` and
`main` signatures and the docstring text from `describe`, the
`with approve` count). `shapeRules` turns that record into a list of
`{ ok, message }`, and `checkToolShape` returns the messages of the
rules that fail. Adding a rule is one line.

The guard rules are exact about what the contract promises: `tool`'s
body must contain a top-level `return guard(...) { ... }` (a guard
assigned to a variable, or nested inside another block, does not count,
because work can happen outside it), that guard must name both `time:`
and `cost:`, and its finalize must be its own child. The signature
rules compare `describe`'s printed signatures against
`tool(request: Request): Result<` and `main(request: Request): Result<`,
so a `tool()` with no parameter is refused even though it typechecks.

## `writeTool` is a pipeline

`draftSource` → `reviewSource` → `testSource` (together `prepareDraft`)
→ `askUser` → `saveTool`, each a def with one job that returns a
`Result`. `rounds` is the loop; `feedback` is its only state, holding
the last problem or the user's revision request. `writeTool` validates,
stages, calls `rounds`, and clears staging once, folding a refused
delete into the returned failure.

`writeTool` and `listTools` expand `~` in `dir` once, up front, with the
stdlib's `expandPath`. The file primitives expand it themselves, but the
sandboxed `testFile` resolves its directory without expansion, so an
unexpanded default would have made every generated test run fail.

### Publishing is one rename

Every round writes into `<dir>/.staging/<name>`: `tool.agency`, then
`tool.test.json` when the tool was tested, then `meta.json` on accept.
`saveTool` re-checks that `<dir>/<name>` is still free (the check in
`checkName` is stale after several model calls) and then `move`s the
staged directory into place. A tool is either fully present or absent;
no failed write can leave an empty or partial directory that `checkName`
would refuse to reuse.

### Only pure tools are tested

`llm()` raises no interrupt and cannot be scripted in a sandbox test
file, and a scripted approval of a network effect lets the call through,
so a generated exact-match test for a tool that calls a model or the
network can never pass. `testSource` therefore generates and runs tests
only for a pure tool: its effect list is exactly `["std::guard"]` and
its source has no `llm` call (`isPure`). Other tools skip the cases
call; the review payload says so with `tested: false`.

### What the handler may answer

`askUser` returns a `Result<WriteToolReview>`. A rejected interrupt
comes back as the failure it is, message intact, and `rounds` returns
it. A bare `approve()` (what a catch-all policy sends) carries no value
and counts as accept. Anything else without a `verdict` of `accept` or
`revise` is a failure naming the answer.

The typechecker does not carry a `Result` narrowing past a `continue`,
so `rounds` branches on `is failure` / `is success` instead of
narrowing and continuing.

## The review interrupt

`std::toolbox::review` is raised after the draft passes the shape check,
the review agent, and its own tests. The handler's `approve` value is a
`WriteToolReview`: `{ verdict: "accept" }` saves, `{ verdict: "revise",
feedback }` runs another round with the feedback in the brief, and
`reject()` cancels. `std::question` in `stdlib/agent.agency` is the
precedent for an interrupt whose approval carries a value. The loop
lives in `rounds`, so a reject (which returns a failure from the
function that raised the interrupt) still lets `writeTool` clear the
staging directory. The payload's `stagingDir` is temporary; the saved
tool's directory is the `dir` field of the returned `ToolEntry`.

## Tests as JSON

The spec had `tool.test.agency` with an exported `cases` const. The
module writes `tool.test.json` in the sandbox `.test.json` profile
(`lib/testFormat/schema.ts`) and runs it with `testFile`, which exists
already and does not load the tool module a second time. Two profile
facts that cost a round of debugging: scripted interrupt answers are
`interruptHandlers: [{ action: "approve" | "reject" }]`, not
`interrupts`; and because `main` returns a `Result`, `expectedOutput`
must be the serialized `Result` envelope. `testFileJson` builds it with
the runtime's own `success(value)` and `JSON.stringify`, so there is no
second copy of the envelope format.

## meta.json

A missing `meta.json` (probed with `_exists`, so a read error is not
mistaken for absence) means the default record (version 1, no uses). A
present one that cannot be read, is not JSON, or has a field of the
wrong type marks the entry `broken`, so a corrupt file never passes as
a healthy tool.

## Listing

`listTools` lists the toolbox with `_ls`, a plain one-level directory
read, and keeps the directories whose names do not start with a dot.
The walking glob skips `dist`, `build`, `.cache` and friends at every
level, which would have hidden a tool with one of those names.

## Model calls and mocks

Per round: one call in the coding agent (its internal review has no
task and draws none), one in the review agent (it has a task), and, for
a pure tool only, one for the test cases. A draft that fails the shape
check draws only the first; a tool that calls a model draws two.
`tests/agency/toolbox/writeTool.test.json` counts mocks this way; if the
order ever gets awkward, scope the queues by module basename. The
mocked draft is the `good` fixture embedded as a string, so regenerate
the JSON (the script is in the plan) whenever that fixture changes; a
stale copy fails the coding agent's own check and silently spends the
round's mocks.

`writeTool.agency` writes under `tests/agency/toolbox/test-output/`
(gitignored) and removes what it made. A `tool.test.json` left there is
picked up by `agency test tests/agency/toolbox` and refused by the full
profile (`args` is sandbox-only), so tests must clean up.

The example module in the brief escapes its `${...}` as `\${...}`: the
brief is a `static const` string, and an unescaped interpolation is
evaluated when the module loads.

## Later pieces

`runTool` with outcome recording (needs `cwd` on `runFile`), revision of
an existing tool, retirement, the agency-agent integration, skills, the
type-position hole, and one real-LLM end-to-end test once there is a
place for real-LLM stdlib tests (today they run only from `lib/agents`).
