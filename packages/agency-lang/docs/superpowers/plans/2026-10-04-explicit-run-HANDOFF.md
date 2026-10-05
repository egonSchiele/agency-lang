# Handoff: passing the run explicitly

Written on 2026-10-04, at the end of Phase 1. It holds what the next session
needs to do Phases 2 and 3. Paths are relative to `packages/agency-lang`
unless they start with `/`.

Read these three, in this order, before doing anything:

1. This file.
2. `docs/superpowers/plans/2026-10-04-explicit-run-passing.md`, the plan.
   It has the design, every decision, and the task list.
3. `docs/superpowers/plans/2026-10-04-explicit-run-passing-REVIEW.md`, the
   owner's review. Its findings are folded into the plan. One of them was
   wrong: see "Things I believed that were false".

## The goal, in one paragraph

Agency should run anywhere JavaScript runs, starting with an iPad web view.
The one Node feature with no browser replacement is `AsyncLocalStorage`,
which the runtime uses to find the current run. PR #1167 keeps the hidden
variable and makes it work by rewriting every `async` function and replacing
`Promise.prototype.then`. This work takes the other route: pass the run to
every function that needs it, as an ordinary argument. The owner prefers
this route because it is easier to understand and costs less to maintain.

## This work is exploratory

The owner said so directly: it is being built to see how large the change
is. Nothing is meant to merge yet. So the PRs stack, which is otherwise
against the rule in this repo:

- Phase 2 is based on the `explicit-run` branch.
- Phase 3 is based on the Phase 2 branch.
- Each PR says in its first line what it is stacked on.

## Where everything is

| Thing | Where |
| --- | --- |
| Phase 1 worktree | `/Users/adit/agency-lang/packages/agency-lang/.worktrees/explicit-run` |
| Phase 1 branch and PR | `explicit-run`, PR [#1169](https://github.com/egonSchiele/agency-lang/pull/1169), based on main at `ad1d7ec9b` |
| The other design, for comparison | PR [#1167](https://github.com/egonSchiele/agency-lang/pull/1167), branch `spike/portable-context`, worktree `.worktrees/portable-context`. Leave it open. |
| The prototype | `.worktrees/explicit-context/packages/agency-lang/scripts/explicit-context-spike/`, branch `spike/explicit-context`, committed at `34350cf36`. The branch is local and not pushed. |
| The audit script | `scripts/audit-run-reads.mjs`, committed in Phase 1 |

The Phase 1 worktree has `node_modules` and a built `dist`. `make build`
takes about 3 seconds. `make` rebuilds everything, including the stdlib.

To start Phase 2, make a new worktree from the Phase 1 branch:

```bash
cd /Users/adit/agency-lang/packages/agency-lang
git worktree add -b explicit-run-phase-2 .worktrees/explicit-run-phase-2 explicit-run
cd .worktrees/explicit-run-phase-2 && pnpm install --frozen-lockfile
cd packages/agency-lang && make
```

## What Phase 1 did

Four of the six `AsyncLocalStorage` instances are gone. The call depth, the
handler chain depth, the executing-handler list, and the active-callback
list are required fields of the frame (`AgencyStore` in
`lib/runtime/asyncContext.ts`).

- `lineageOf(outer)` gives a new frame the outer frame's four values. Every
  frame built from scratch spreads it in.
- `requireFrame(caller)` throws when there is no frame. `withCallDepth`,
  `runHandlerChain`, `runAsHandler`, `executingHandlers`, `fireWithGuard`,
  and `isInsideCallback` all call it.
- `inTestFrame` and `withTestFrame` in `lib/runtime/__tests__/testHelpers.ts`
  give a unit test a frame. Sixteen test files use `withTestFrame`.
- The two that remain are `agencyStore` in `asyncContext.ts` and
  `spanStorage` in `lib/statelogClient.ts`.

Two tasks moved from Phase 1 to Phase 2: the small readers, and `run.log`
with the span stack. Both need callers that hold a run.

### CI on PR #1169

The first run passed everything except two unit tests in `packages/mcp`,
which called an Agency function with no frame. They now build a frame with
`agency.withTestContext`. Every check passed on the later pushes. Check
again after any new push with `gh pr checks 1169`.

## Decisions

All ten are in the plan under "Decisions". The short form:

| # | Question | Answer |
| --- | --- | --- |
| 1 | One PR or three? | Three, stacked |
| 2 | PR #1167 | Leave it open |
| 3 | Logging | `run.log.toolCall(...)`, and `ctx.rootLog` for posts outside a run |
| 4 | Wrong-run check always on? | Yes. Confirm again after Phase 2 |
| 5 | `getRuntimeContext()` | Rename to `currentRun()`, keep the old name as an alias for one release |
| 6 | Helper code breaks | Accepted. `run.call(fn, ...)`, and `agency.*` after an `await` needs a handle |
| 7 | A subprocess started in a handler function | Keep both cases as they are. The guide already says so. See below |
| 8 | Handlers written in TypeScript | Keep the shape `(interrupt) => verdict` |
| 9 | Console capture with two REPLs | Send output to the most recently installed REPL |
| 10 | Work that outlives its helper | Keep the handle usable |

### Decision 7 is settled by the guide

The guide names the two parts of a handler: the block after `handle` is the
**handler body**, and the block after `with` is the **handler function**.

- A subprocess started in the handler body: that handler is asked about the
  subprocess's interrupts. The owner called this critical.
- A subprocess started in the handler function: that handler is not asked.
  Every handler outside it is. This is the guide's rule, "a handler function
  never triggers for an interrupt raised in itself", applied to a
  subprocess.

Phase 1 keeps both. `tests/agency/subprocess/handler-function-starts-child`
pins the second. I listed this as an open question for a while because I
first asked it with "body" where I meant "function". It was never open: do
not ask the owner again.

## Things I believed that were false

Each of these was caught by running something. Do not repeat them.

1. **"The listener for a subprocess's messages runs with no frame."** False.
   `AsyncLocalStorage` carries the frame from where the subprocess was
   started into that listener. The comment at `lib/runtime/ipc.ts:1124` says
   otherwise and is wrong. The review's finding 1 rests on this. In Phase 3,
   with `AsyncLocalStorage` gone, the listener really will have no frame and
   needs the stored run (`s.parentStore`).
2. **"A handler whose body starts a subprocess is asked about its
   interrupts."** I meant the handler function, and for the handler function
   it is false.
3. **"Comments must be on their own line."** The guide said so and was out
   of date. Trailing comments work. The guide is fixed in PR #1169.
4. **"No production code runs without a frame."** True for `agency-lang`,
   and checked with a temporary trace. But `packages/mcp` tests did, and CI
   found it. Run the other packages' tests too.

5. **"`async record("a")` is a way to run a call concurrently."** The
   `async` keyword on a call is not supported. The guide's basic-syntax page
   says Agency has no async/await, and the concurrency page lists `fork`,
   `race`, `parallel`, and `seq`. I used the keyword because the parser
   accepts it and `docs/dev/runtime/async.md` describes it. A dev doc is not
   the guide. I then reported two "bugs" in it, which were not bugs in
   anything supported.
6. **"A global written by a handler function and then lost is a bug."** It
   is branch isolation, as the guide describes under "Isolation across
   concurrent branches". See below.

The lesson the owner drew, and asked me to act on: write each belief as a
test first, run it on main, and only then change code. And read the guide
(`docs/site/guide/`) before using a feature. I read all of it on 2026-10-04
after the owner asked twice. The notes that matter for this work are under
"What the guide says that this work depends on".

## Things found on the way that are not for this work

1. **An interrupt raised by a call inside a method call's arguments is
   dropped.** `out.push(save(name))`: the node finishes, `save` never runs,
   and nobody is asked. `const saved = save(name)` then `out.push(saved)`
   pauses correctly. The owner already knows about this one. Do not file it
   and do not fix it here.
2. **A global written by a handler function goes to the raising branch's
   copy.** When the interrupt came from a fork branch or from a subprocess
   call, the handler function runs on that branch's copy of the globals, and
   the copy is dropped when the branch ends. This is the documented branch
   isolation, not a bug. `tests/agency/handler-lineage/handler-global-writes`
   pins it so this work cannot change it by accident.

## What the guide says that this work depends on

Every feature below reads the frame today, so each is a place where the
wrong run would show up as wrong behaviour.

- **Handlers.** Every handler in the chain is asked. Reject beats
  propagate, which beats approve. A handler that returns nothing has
  passed. A handler function is never asked about an interrupt raised
  inside itself, and such an interrupt must be answered in code by an outer
  handler: reaching the user is an error.
- **Branches.** `fork`, `race`, `parallel`, and the `fork [...]` and
  `race [...]` comprehensions each give a branch its own copy of the
  globals. `shared: true`, `forkShared`, and `raceShared` share them.
  Locals are always shared.
- **Per-branch state besides globals.** The memory config stack
  (`enableMemory`, `memory(...) as { }`) is per fork branch. `lastReply()`
  reads the branch's own thread. A draft saved with `saveDraft` is per
  branch, and a `race` loser's draft is discarded and its `finalize` does
  not run.
- **Guards.** A guard around a fork is one budget for all branches, and a
  trip pauses all of them. A guard inside a branch pauses only that branch.
  A trip raises `std::guard`. Guards also apply to subprocesses.
  `agency.withCostGuard` and `withTimeGuard` install on the active branch's
  stack, and `ctx.getAbortSignal(stack)` needs the branch's stack.
- **No interrupts allowed in:** callback bodies, `finalize` blocks, and
  splice generators.
- **Tool calls.** `llm()` calls inside a tool run on a separate thread
  unless the function is a `handoff def`. `endTurn()` and `handBack()` only
  count inside a tool invocation, so they read the tool invocation stack.
- **Decision models.** Calls in one `parallel` block batch into one
  request. `docs/dev/llm/decision-models.md` says the collector lives on
  the async frame. Read that doc before touching `runBatch` in Phase 2.
- **TypeScript helpers.** `docs/site/guide/ts-helpers.md` documents the
  `agency.*` namespace this plan changes. Phase 3 rewrites that page.
- **Locks.** `agency.withLock` is per run, and a subprocess asks its parent
  for the lock.

## Tests

### Written in Phase 1

| Test | What it pins |
| --- | --- |
| `lib/runtime/runner.test.ts`, "runInScope keeps the lineage" | A step keeps each of the four lineage values. Each test fails if `runInScope` drops the value |
| `tests/agency/subprocess/handler-function-starts-child` | Decision 7 |
| `tests/agency/handler-lineage/function-origins` | An interrupt raised inside a handler function, through a call, a fork, and a tool call. That handler is not asked |
| `tests/agency/handler-lineage/body-origins` | An interrupt raised inside a handler body, through a fork and a tool call. The handler is asked |
| `tests/agency/handler-lineage/handler-global-writes` | A handler function's write to a global goes to the raising branch's copy |
| `tests/agency-js/concurrent-helper-isolation` | Two runs through a TypeScript helper that waits. Each sees only its own cost |

`concurrent-helper-isolation/helper.js` calls `agency.addCost` after an
`await`. Under this plan that throws, so Phase 2 has to move the helper to
the handle. The test's point, that the two runs stay separate, does not
change.

### Still to write, agreed with the owner

Write each as a prediction and run it before changing the code it covers.

- **Each limit across each boundary.** Call depth, handler recursion depth,
  and the callback recursion guard, across a fork branch, a tool call, a
  handler function, a callback, and a resume after an interrupt.
- **Every feature in the guide that depends on the branch.** `lastReply()`
  in a `parallel` branch, a memory id per fork branch, redaction per
  branch, `shared: true`, a guard that trips in one branch only. Check
  whether a test exists before writing one.
- **An interrupt raised from every position a call can appear.** Method
  argument, function argument, object field, array element, string
  interpolation, condition, `return`, match scrutinee, comprehension. The
  method argument position is known to drop the interrupt today, so leave
  it out or mark it skipped with that reason.

## How to do Phase 2

The plan's Phase 2 has Tasks 5 to 14. The order below is the one to follow.
The central idea is the check that makes this safe: keep `AsyncLocalStorage`
in place, pass the run explicitly, and compare the two at every read. Read
"How we know nothing broke" in the plan before starting.

1. **Rename `AgencyStore` to `Run` and add `sameRun(run)`** (Task 7). Each
   of the 18 installers calls `sameRun` on the run it was handed, builds one
   child object, and gives that object to both `agencyStore.run` and the
   function it calls. Run `node scripts/audit-run-reads.mjs . > out.json` to
   list the installers and readers.
2. **Thread the run through the runtime with the type checker** (Task 8).
   Add a required `run: Run` first parameter to a reader, compile, and fix
   each error by adding the parameter to the caller. Start with the files
   where frames are installed and read each by hand: `runner.ts`,
   `runBatch.ts`, `interrupts.ts`, `prompt.ts`, `promptRunner.ts`,
   `toolInvocation.ts`, `hooks.ts`, `resumableScope.ts`, `node.ts`,
   `ipc.ts`, `agencyFunction.ts`, `call.ts`.
3. **The small readers** (Task 5) and **`run.log`** (Task 6), now that
   callers hold a run. `run.log` takes the span stack with it, and the last
   small `AsyncLocalStorage`, `spanStorage`, goes.
4. **The stored callbacks** (Task 9). The plan has a table of all eleven.
   They do not share one rule.
5. **`callPlain` and the handle** (Task 10). One function sets a module
   variable to the run, calls the plain function, and restores the previous
   value in a `finally`. Five places use it. The `agency.*` functions that
   take a callback hand that callback a handle.
6. **The code generator** (Task 11). Four rules, in the plan under
   "Generated code". Then `pnpm run templates`, `make`, `make fixtures`,
   and commit the fixtures separately.
7. **The wrong-run check** (Task 12), as its own commit, only after the
   suites are green on everything above.
8. **The stdlib helpers** (Task 13) and **the other packages and test
   helpers** (Task 14).

The audit's numbers, to size the work: 339 functions need the run, 208 uses
come after an `await` in 114 functions, and 33 sit inside a nested callback.
The heaviest files are `runtime/runner.ts` (41), `runtime/memory/manager.ts`
(25), `runtime/prompt.ts` (21), and `stdlib/ui.ts` (13).

Phase 2 can split in two if the diff is too large: Tasks 13 and 14 can come
after the rest, because `getRuntimeContext()` keeps working while
`AsyncLocalStorage` is in place.

## How to do Phase 3

Tasks 15 to 18 in the plan. Delete `agencyStore`, `sameRun`, and the two
frames generated code installs. Add the lint rule from the audit script.
Rebuild the fixtures. Rewrite `docs/dev/runtime/async-context.md` and
`docs/dev/compiler/codegen-als-accessors.md`, update
`docs/site/guide/ts-helpers.md` and `guards.md`, and add
`docs/dev/runtime/running-without-node.md` with the goals from PR #1167.

## Safety features that must still hold

The plan has a table, "Safety features that must remain", with one row per
feature that reads the frame and the test that protects it. Run every test
in that table at the end of each phase. The owner's own list is in the
review, under "Safety features in the guide".

One row is new with this design. Today each request's frame follows its own
chain of `await`s. Under this plan one module variable serves the whole
process. If a throw skipped its restore, the next helper would read another
request's run. So `callPlain` restores in a `finally`, and has its own test.

## Commands and rules for this repo

```bash
make build               # about 3 seconds; rebuilds dist
make                     # everything, including the stdlib
pnpm run typecheck       # three tsc configs
pnpm run lint:structure
pnpm run fmt:ts          # CI fails without it
pnpm test:run            # unit tests, about 2 minutes
node dist/scripts/agency.js test tests/agency/<folder> -p 12
node dist/scripts/agency.js test js tests/agency-js -p 12   # 189 tests, a few minutes
node dist/scripts/agency.js fmt -i <file.agency>
gh pr checks 1169
```

- Do not run the full `tests/agency` suite locally. CI runs it in eight
  shards. Run the folders that matter: `handlers`, `handler-lineage`,
  `fork`, `subprocess`, `guards`, `threads`, `substeps`, `ts-helpers`, and
  the `callback-*` files.
- Save test output to a file, so a failure does not need a rerun.
- Running the Agency-js suite rewrites tracked `log.jsonl` files. Restore
  them with `git checkout tests/agency-js` before committing.
- Building a package rewrites its tracked `index.js`. Restore it too.
- A package's unit tests, run from inside a worktree, pick up the main
  checkout's `vitest.config.ts` and find no tests. Give vitest a small
  local config with `-c`.
- Write commit messages and PR bodies to a file and pass the file. Never
  amend, never force push.
- A long Bash command containing `rm -rf` is denied outright. Clean up in a
  short separate command.
- Agency files cannot be run from `/tmp`. Put scratch files under
  `tests/agency/` in the worktree and delete them afterwards.

## Agency syntax I got wrong

- Raise an interrupt as a statement with `raise("message", { data })`. That
  is what `agency fmt` produces. `raise interrupt(...)` and a bare
  `interrupt(...)` also compile. A named effect is
  `raise foo::write("message", { data })`.
- Run `agency fmt -i` on every Agency file before committing it, and read
  what it changed.
- `match` arms use `=>`. There is no ternary: use `if ... then ... else`.
- `llm("...", tools: [fn])` and `llm("...", { tools: [fn] })` both work.
- The guide in `docs/site/guide/` has 72 pages. All were read in this
  session. Three say at the top that an LLM wrote them and they may be out
  of date: `ts-helpers.md`, `memory.md`, `custom-providers.md`.

## How the owner wants to be spoken to

- Lead with the answer, in plain words.
- Name things in full. No single-letter placeholders, in prose or in
  output. Show a program next to its output and walk through it line by
  line.
- Use the guide's own terms. "Handler body" and "handler function" are not
  interchangeable.
- Do not repeat a claim from a doc or a review without testing it. Say what
  was run and what was only read.
- When a question is asked, answer it. Do not build unasked.
