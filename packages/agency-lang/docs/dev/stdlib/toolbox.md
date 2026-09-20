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
  which is `runGuarded` with the purpose set through `.describe()`,
  `node main`, and `node requestSchema`, which returns
  `schema(Request).toJSONSchema()`. `saveTool` runs that node once, in the
  same sandbox as the tests, and records the answer in `meta.json`, so
  whoever offers the tool to a model can give its request the real shape.
- `tool.test.json` holds generated test cases, only for a tool that does
  nothing but compute.
- `meta.json` holds the purpose, the request type text and its JSON
  Schema, the creation time, the time limit, and a use count with the
  last-used time. It
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
The brief tells the coding agent to copy that line as is. The typecheck
cannot catch a draft that changes it, because `tool.agency` imports
whatever `Request` the draft declares, so `assembleTool` compares the
two through `describe`, which prints both the same way. A mismatch is a
draft problem for the design loop and a plain failure for `writeTool`.

The author's brief tells it to ask the user for a fact the task does not
give, such as an address or an account. `draftSource` offers it a
`question` tool on every round. That tool is `askAndRecord`, which calls
`question` from `std::agent` and keeps each question and answer in
`_answered` under the staging directory, the way `cannotFix` keeps its
reports. Each round's author is a new thread, so `taskText` puts the
answers in the next brief and tells the author not to ask again. A draft
picked up from earlier in the session runs in a new staging directory, so
its answers are not carried over.

### Drafts are checked the way a saved tool runs

A saved tool runs sandboxed, so `designTool` checks each draft with the
name checks a sandboxed compile uses. `assembleTool` calls `compile` and
`typecheck` from `std::agency` with `strict: true`, and `draftSource`
passes `strict: true` to `agencyCodingAgent`, which checks each attempt
the same way and gives the author a `typecheck` tool that does too. The
author then sees these errors on its own draft:

```
return built as Json
```

Agency has no `as` cast. This parses as `return built`, then the names
`as` and `Json`, and strict mode reports both as undefined. Without it
the draft typechecks, its generated tests pass because the two names sit
after a `return`, and the tool is saved in a state that a sandboxed
compile refuses.

`draftSource` also passes `projectTools: false`, which leaves out the
author's file and git tools. The brief allows `std::` imports only, so
nothing in the caller's project bears on the task, and an author that has
those tools spends minutes searching the project for facts it should ask
the user for.

### The review agent is off by default

`designTool(review: true)` has `agencyReviewAgent` read each draft before
its checks. Blocking findings go back to the author once, and a second
set reaches the user with the draft. The sections below on `fromReviewer`
and `cannotFix` apply only to that mode.

It is off because it did not pay for itself. On `evals/design-tool`, with
gpt-5-mini and three trials, the score was 0.878 with the reviewer and
0.890 without it. A tool took 187 seconds and $0.041 with it, and 85
seconds and $0.014 without it. The user already reviews every draft at
the `std::toolbox::review` prompt.

Two rules hold when it is on. The reviewer gets its own task text,
`reviewBrief`, which says the `Request` type is fixed and already
verified. It reads the draft in the formatter's layout, where the type
spans several lines, so it must not be asked whether the line was copied
as is. `reviewBrief` also carries the user's answers and says the user
wants those values in the module, so the reviewer does not report one as
hard-coded.

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

`designTool` shares the gate function rather than calling the exported
`writeTool`, which would stage and typecheck a second copy and lose the
design's generated `tool.test.json`.

Both validate and stage through `stage`, so every check runs before
anything is written or anyone is asked, and both clear staging through
`clearStaging`: on failure the staging directory is removed once and a
refused delete is folded into the returned failure. On success the
publish rename has already emptied staging, so no delete interrupt is
raised.

## `designTool` is a pipeline

`draftSource` → `reviewSource` → `testSource` (together `prepareDraft`)
→ `askUser` → `gateAndSave`, each a def with one job that returns a
`Result`. `rounds` is the loop. It carries four things between rounds:
`feedback`, holding the last problem or the user's revision request,
`fromReviewer`, which says whether that feedback is the reviewer's (see
the next section), `drafted`, the draft that feedback is about, and
`previous`, the draft the user last saw. `drafted` goes into the next
author's brief, so a redraft starts from the code the feedback names
and keeps what was right in it. The two differ when the reviewer blocks
a draft: the user never saw it, but the next author must.
`previous` rides along on the
review interrupt so the approval prompt can diff this round's draft
against it and show what changed rather than the whole tool again; on the
first round it is `""` and the diff is all insertions. A round that
produced no draft passes `previous` through unchanged. It does mean a
review interrupt carries the tool twice, in every checkpoint and every
statelog event for it; a diff is worth that for something the user is
being asked to read and judge. Only a `DraftProblem`
(a coding-agent failure, the reviewer's first blocking findings, a
typecheck or compile error, a failed test) becomes feedback. Any other failure, such as a refused
write or a review agent that did not run, ends the loop at once, since
another draft cannot fix it.

### What the reviewer may block, and when the user is asked

A parse error, a typecheck error, a bad import, or a failing generated
test is a fact, and it goes back to the author without the user. A
reviewer finding is a judgment, and the author may be unable to act on
it: it can change one module, not the purpose, the request type, or what
a stdlib function returns. A purpose that asks for a publication time,
written against a search that returns none, would otherwise be blocked
in every round and never shown to anyone.

1. `reviewSource` passes the reviewer `REVIEW_LIMITS` as `context`. It
   says what the author can change, that `error=true` is for problems
   inside that limit, and that anything else is `error=false`, written
   as advice to the user.
2. `error=false` findings are `Review.notes`. They ride on the draft and
   on the `std::toolbox::review` payload, and print under the diff
   (`renderReviewFindings` in `stdlib/policy.agency`).
3. The reviewer's first blocking findings go back to the author with
   `fromReviewer` set. On that redraft the brief says "fix it, or call
   `cannotFix` with the reason", and the coding agent is given
   `cannotFix.partial(stagingDir: ...)` through `extraTools`. A draft
   whose author called it is not reviewed again. It goes to the user
   with each point and the author's reason (`Review.unresolved`).
4. If the author reports nothing and the reviewer blocks the redraft
   too, the draft goes to the user with the findings (`Review.blocking`),
   who may accept it anyway. Nobody waits for more than two reviews.

`cannotFix` writes to `_unresolved`, a module-level record keyed by
staging directory. The key matters in one case. Separate runs and
`fork`/`parallel` branches each have their own globals, but two tool
calls in the same LLM round share them (see `runBatch.md`), and a model
can call `designTool` twice in one round. That sharing is also what lets
`designTool` read what the tool wrote from inside the coding agent's
tool loop.

The record is read without being cleared. A redraft that reports a point
and then fails `testSource` leads to another draft, and the point is
still true of that draft, so the failure keeps `fromReviewer` set and
the author keeps the tool. The record is cleared when the reviewer
issues new findings and when a draft is shown.

A draft nobody accepts is not saved. When it had open review points, the
failure lists them (`notAccepted`), so a model that called `designTool`
with no user at a terminal can say why.

`progress` prints a line at each stage with `print`, the channel
`whatIAmDoing` uses.

### A draft nobody accepted is kept for the session

`presentDraft` records every draft it is about to show in `_unfinished`,
a module-level record keyed by toolbox root and tool name, holding the
request text, the source, and the review. It records before it asks,
because a cancelled turn never comes back from `askUser`. Saving the
tool removes the entry. A rejected or cancelled draft stays.

`rounds` starts with `resumeDraft`. A kept draft for this name and the
same request text is run through `testSource` again, into this call's
own staging directory, and shown with `resumed: true`. No model writes
or reviews it again. Feedback starts a normal round that diffs against
it. A kept draft that no longer passes `testSource` is dropped.

- The record lasts as long as the process. Looking through the staging
  directories on disk instead would mean guessing which leftover fits
  the request.
- It holds the source, not a staging directory, because a rejected
  review clears staging.
- The purpose is not compared. The calling model rewords it from one
  call to the next.

`writeTool` is `stage` → `assembleTool` → `gateAndSave`. A
`DraftProblem` from `assembleTool` becomes a plain failure, since there
is no loop to feed it to. No tests are generated: a caller who wrote the
source is expected to have tested it.

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

### The toolbox's own file work

Writing one tool used to put eleven prompts in front of the user, and
nine of them were the toolbox working in its own directories: a
`std::mkdir` for the staging directory, four `std::write`s, two
`std::read`s, a `std::move` to publish, and the scan. Only the review and
the save were decisions.

Those now raise the toolbox's own effects, as `recordUse` already did for
the use count:

- `std::toolbox::writeFile { root, dir, filename, content }` for each of
  the four files. The four names are constants and `dir` is a directory
  built from a name `checkNameSyntax` has passed, so a model never
  chooses a path here.
- `std::toolbox::createStaging { root, dir, name }` when the staging
  directory is made, `std::toolbox::removeStaging` when an unsaved draft's
  directory is removed, and `std::toolbox::removeStagedFile { …, filename }`
  when a stale `tool.test.json` is cleared. One effect each, so a policy
  can tell creating a directory from removing one.

Both carry `root`, the toolbox root, as the `@alwaysUnder` field, so
"approve always here" pins the toolbox instead of one draft's staging
directory, whose name ends in a random number and never recurs.

The publish `move` raises nothing of its own: the `std::toolbox::save`
gate was answered a moment earlier and named the same root and name.
`recommended` auto-approves all of them under the agent home, alongside
the use count. Writing a draft's files decides nothing: the user reads
the finished draft at the review gate and answers for it at the save
gate, and those two are the prompts a tool costs.

Each wrapper resolves the directory with `_realDir` before it raises and
hands that same spelling to the primitive (`_write`, `_mkdir`, `_remove`,
`_move`), which re-resolves it with the `fixed*` pair. A directory
swapped for a symlink while the prompt is open is refused rather than
followed. See `docs/dev/stdlib/contained-files.md`.

The two reads are gone rather than renamed. `assembleTool` typechecks the
source the template just produced (`typecheck(source, dir:)`) instead of
reading `tool.agency` back, and `runGeneratedTests` runs its cases from
memory (`test(dir, file, cases)`) instead of reading `tool.test.json`
back. The file is still written, because it ships with the tool.
`prepareCases` parses each expected value once, so the file and the run
that checks it cannot disagree.

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

### How the test cases are generated

A case is a `request` for the tool and the value `run` should return.
The structured-output schema must spell out the request's fields. An
open object such as `Record<string, Json>` becomes
`additionalProperties: {}` in the JSON schema. Anthropic rejects that
with a 400, and OpenAI rejects the `propertyNames` that comes with it.

An `llm()` call's schema is built from the declared type when its file
is compiled, and `toolbox.agency` is compiled long before a tool's
`Request` exists. There is no hole in type position either. So
`runGeneratedTests` compiles a small program, `casesProgram`, against
the staging directory. It imports `Request` from `impl.agency` and asks
for `{ request: Request; expectedJson: string }[]`. For
`request: "{ name: string }"`, the schema says exactly
`request: { name: string }`. `compile` takes the source as a string, so
nothing is written to staging and nothing has to be removed. `run`
starts it in a subprocess, which raises one `std::run` interrupt per
tested round.

`run` returns JSON, which has no closed schema, so the expected value
comes back as JSON text. `testFileJson` parses it and wraps it in the
Result envelope `main` returns. It also puts each request under
`args.request`, the one parameter `main` takes. A request type that has
an open field of its own still fails the schema, and the round fails
with the provider's message.

### What the handler may return

The answer is text, because that is what a person can type at the
interactive prompt (the line they type is the approval value, and an
empty line rejects). A bare `approve()` or the word `accept` accepts.
Any other text is the feedback for the next draft. A rejection halts
`askUser` and returns the rejection to `rounds`, which returns it. A
non-string answer, or feedback that is only whitespace, fails the call.

## Reading a toolbox

`listTools` raises a `std::toolbox::scan` interrupt for the directory.
It then lists the directory with `ls` from `std::shell` (which raises
`std::ls`), and keeps the directories whose names are not `staging` and
do not start with a dot. The recommended policy gives `std::toolbox::scan` the same `dir` scope
as `std::read`, so a toolbox outside the working directory prompts. `listTools` refuses an empty `dir`, since the
primitives would resolve it to the process cwd, and puts its real
spelling (`_realDir`) in the scan payload, so the payload names one
directory however the caller spelled it and a policy rule written for
reads matches it. `ls` counts every entry
against its cap and does not say when it stopped, so a listing that
reaches the cap is reported as a failure. It is not returned as a
shortened catalog. The per-tool reads
of `impl.agency` and `meta.json` use `_read`, covered by that one scan
approval. `runTool` and the post-publish read in `saveTool` raise the
same scan for the one tool directory they read, so no `_read` runs
without an approval that names its directory. Every one of those reads
takes the toolbox root as its approved directory, so a symlinked tool
directory cannot carry a scan approval elsewhere: `ls` leaves the link
out of the catalog, and `runTool` does not find it. A toolbox directory that does not exist
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
an hour minus that headroom. It then counts the use in
`meta.json`, behind a `std::toolbox::recordUse` interrupt naming the
tool's directory. The write that fulfils the approval takes the toolbox
root as its approved directory, like every other write. The count is best-effort: the tool has already run, so
a declined interrupt or a failed write leaves the count where it was and
`runTool` returns the node's own `Result`. Why the count is an effect of
its own, and what the recommended policy does with it, is in
`docs/dev/agents/approval-policies.md`.

## Two counts: checker attempts and rounds

A draft can be sent back for two kinds of reason, and each has its own
limit.

- **The checker sent it back.** The draft does not parse, typecheck, or
  compile. This happens inside `agencyCodingAgent`, in one conversation,
  so the author sees its own draft and the error. `draftSource` allows
  `CHECK_ATTEMPTS` (6) of these. They are cheap and say nothing about
  whether the tool is right, and a small model needs several: on
  gpt-5-mini half of all tool requests had at least one.
- **The draft was wrong.** Its tests failed, the reviewer blocked it, or
  the user asked for a change. Each of these is a round, and `maxRounds`
  (3) limits them.

An author that uses up its checker attempts does end the round. The
failure carries the last draft as `drafted`, so the next round's author
continues from it and not from the older draft the round started with.

The review agent reports a parse error once. The typechecker parses too,
so `agencyReviewAgent` skips it when the parse already failed.

## Model calls and mocks

Per round: one call in the coding agent (its internal review has no
task, so it draws no separate mock), one in the review agent (it has a task), and, for
a pure tool only, one for the test cases. The review runs before the
tool is assembled, so a draft with the wrong export still draws the
review mock. `tests/agency/toolbox/generate-designTool-mocks.mjs`
regenerates `designTool.test.json`; run it whenever
`fixtures/tools/good/impl.agency` changes. A stale copy fails the coding
agent's own check and silently spends the round's mocks.

The mocks are scoped by module: `coding` and `review` each have a
queue. The test-case call runs in a subprocess under a random module id
(`agency_<random>`), so it always reads the `"*"` queue. Each subprocess
reads that queue from the start, so every tested round gets the same
single cases mock.

`tests/agency/toolbox/writeTool.agency` covers the plain primitive with
no mocks at all, so a model call anywhere on its path fails the suite.

`designTool.agency` and `writeTool.agency` write under
`tests/agency/toolbox/test-output/` (gitignored) and remove what they
made. A `tool.test.json` left there is
picked up by `agency test tests/agency/toolbox` and refused by the full
profile (`args` is sandbox-only), so tests must clean up.

## Later pieces

Revision of an existing tool, retirement, the agency-agent integration,
skills, and one real-LLM end-to-end test once there is a place for
real-LLM stdlib tests (today they run only from `lib/agents`).
