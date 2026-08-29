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
module to a flat record (exported names, the guards inside `tool`, the
`with approve` count, the docstring text from `describe`). `shapeRules`
turns that record into a list of `{ ok, message }`, and `checkToolShape`
returns the messages of the rules that fail. Adding a rule is one line.
The guard rule looks only at the first guard inside `tool` and requires
the finalize to be that guard's child, so a finalize on some other guard
does not count. To find the guards inside `tool` the checker prints the
`tool` node alone with `toSource` and runs `getNodesOfType` on it, which
reuses the existing walker instead of writing another.

## `writeTool` is a pipeline

`draftSource` → `reviewSource` → `testSource` (together `prepareDraft`)
→ `askUser` → `saveTool`, each a def with one job that returns a
`Result`. `rounds` is the loop; `feedback` is its only state, holding
the last problem or the user's revision request. `writeTool` validates,
stages, calls `rounds`, and clears staging once, folding a refused
delete into the returned failure.

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
must be the serialized envelope
`{"__type":"resultType","success":true,"value":...}`. `testFileJson`
adds that envelope, so the model supplies plain values.

## meta.json

A missing `meta.json` means the default record (version 1, no uses). A
present one that is not JSON marks the entry `broken`, so a corrupt
file never passes as a healthy tool.

## Model calls and mocks

Per round: one call in the coding agent (its internal review has no
task and draws none), one in the review agent (it has a task), one for
the test cases. A draft that fails the shape check draws only the first.
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
