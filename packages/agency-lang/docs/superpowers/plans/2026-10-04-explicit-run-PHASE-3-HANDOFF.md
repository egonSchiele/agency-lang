# Handoff for Phase 3: remove AsyncLocalStorage

Written 2026-10-04, after Phases 1 and 2 were built. This is everything a
new session needs to do Phase 3 of
`2026-10-04-explicit-run-passing.md` (the plan). Read this first, then the
plan's sections "The design", "Phase 2 is built", and "Phase 3".

The older handoff, `2026-10-04-explicit-run-HANDOFF.md`, covers how Phases
1 and 2 were done. It is still accurate, and its sections on commands,
syntax mistakes, and how the owner wants to be spoken to still apply. This
document repeats the parts Phase 3 needs.

## What this work is

Agency should run anywhere JavaScript runs, starting with an iPad web view.
The one Node feature with no browser replacement is `AsyncLocalStorage`,
which the runtime used to find "the current run".

PR #1167 keeps that hidden variable and makes it work without Node by
rewriting every `async` function. This work takes the other route: pass the
run to every function that needs it, as an ordinary argument.

**The work is exploratory.** The owner is building it to see how large the
change is. Nothing here is meant to merge yet. Report sizes honestly, in
changed lines, split into generated and hand-written.

## Where everything is

| Thing | Where |
| --- | --- |
| Phase 1 | branch `explicit-run`, PR [#1169](https://github.com/egonSchiele/agency-lang/pull/1169), worktree `.worktrees/explicit-run` |
| Phase 2 | branch `explicit-run-phase-2`, PR [#1170](https://github.com/egonSchiele/agency-lang/pull/1170), worktree `.worktrees/explicit-run-phase-2` |
| The other design | PR [#1167](https://github.com/egonSchiele/agency-lang/pull/1167), branch `spike/portable-context`. Leave it open |
| The prototype | local branch `spike/explicit-context` at `34350cf36`, not pushed |
| The plan, its review, both handoffs | `docs/superpowers/plans/2026-10-04-explicit-run-*.md` on the Phase 2 branch |
| The audit script | `scripts/audit-run-reads.mjs` |

All worktrees are under `/Users/adit/agency-lang/packages/agency-lang/`.

To start Phase 3:

```bash
cd /Users/adit/agency-lang/packages/agency-lang
git worktree add .worktrees/explicit-run-phase-3 -b explicit-run-phase-3 explicit-run-phase-2
cd .worktrees/explicit-run-phase-3
pnpm install --frozen-lockfile
cd packages/agency-lang && make
```

**CI only runs for a pull request into `main`.** A PR into another branch
gets no checks. So open the Phase 3 PR against `main`, and say in its first
line that it contains #1169 and #1170 and that the branch is stacked on
`explicit-run-phase-2`. PR #1170 was done this way.

CI on the last Phase 2 push had 21 checks passed and 2 still running when
this was written. Check it before starting: `gh pr checks 1170`.

## What Phase 2 left in place

Read `lib/runtime/asyncContext.ts` from top to bottom before anything else.
It is about 640 lines and holds every piece named here.

- **`Run`** is the frame type. Every generated function, block, handler
  function, init function, and finalize closure takes one as `__run`, and
  every body the runtime calls back declares `__run`.
- **`withRun(run, fn)`** installs `run` in `AsyncLocalStorage` and calls
  `fn(run)` through `callPlain`.
- **`withChildRun(parent, overrides, what, fn)`** makes a child with its
  own state, counts the parent as waiting until `fn` has finished, and
  calls `withRun`. Every step, call, handler, and callback gets its run
  this way.
- **`detachedRun(run, overrides)`** is a copy with its own state, for work
  the caller does not wait for.
- **`sameRun(run, caller)`** throws `WrongRunError` if `run` is not the
  frame `AsyncLocalStorage` holds. 17 call sites. This is the check Phase 3
  deletes.
- **`assertUsable(run, what)`** throws `RunInUseError` if the run is
  waiting for something it started. This check stays.
- **`callPlain(run, fn, args, thisArg?)`** sets one module variable for the
  synchronous part of a call to a plain function and restores it in a
  `finally`.
- **`currentRun()`** returns that variable. It throws after a helper's
  first `await`. Today it also checks the variable against the frame.
  `getRuntimeContext()` is a deprecated alias.
- **`run.log`** is the logging client bound to one branch's tag store and
  span stack (`StatelogClient.logFor`, `forBranch`, `forSpans`). A bound
  logger throws if it is used in a branch other than the current one.
  `ctx.rootLog` is the client itself, for posts made outside any run.
- **`agency.current()`** returns a handle: `call`, `callWith`, `addCost`,
  `addTokens`, `ctx`, `stack`, `threads`.

Generated code makes no mention of `AsyncLocalStorage`. It calls
`__withChildRun` for a function body and `__detachedRun` for the
unsupported `async` call path. **Phase 3 needs no generator change and no
fixture rebuild**, unless you choose to change what generated code calls.

## What Phase 3 has to do

### 1. Decide the reads that have no caller to take a run from

These still read `AsyncLocalStorage`. None is a mechanical edit. Each
needs a decision, and the owner should see the list before you build.
`grep -rn "agencyStore\.\(getStore\|run\)(" lib --include=*.ts | grep -v "\.test\."`
lists them.

| Read | Where | The problem | A way forward |
| --- | --- | --- | --- |
| `warnDroppedData` | `lib/runtime/result.ts:172` | Reached only through the public `failure(error, data)`, which user TypeScript calls with no run in hand | Read the module variable leniently: a helper calling `failure()` before its first `await` still gets the warning in its own log, and one calling it later logs with the plain logger |
| The function-ref reviver's miss | `lib/runtime/revivers/functionRefReviver.ts:154` | `revive()` runs inside `JSON.parse` | Give the reviver a logger when the restore starts, or log through the plain logger |
| `agency.ctxMaybe`, `agency.callsite`, `agency.thread.storeMaybe` | `lib/runtime/agency.ts:86`, `91`, `131` | Documented to return `undefined` with no frame | Read the module variable. After a helper's first `await` they return `undefined`, which looks the same as "not in a run". The plan's section "Reads that accept a missing run" calls this the fault it holds against PR #1167, so say so in the docs, or make them throw after an `await` |
| `std::ui` console capture | `lib/stdlib/ui.ts:106` and `pushCaptured` | Runs inside a `console.log` override that any code can call | Decision 9 in the plan: send captured output to the REPL that installed the capture most recently. Not built yet |
| Helpers that must work with no run | `lib/stdlib/llm.ts:198`, `statelog.ts:29` and `56`, `thread.ts:260`, `297`, `315`, `localModels.ts:1276`, `date.ts:16` | Each returns a default when there is no frame | Read the module variable leniently, before any `await`. Check each one is really on a helper's first lines |
| `withPushedHandler` | `lib/runtime/asyncContext.ts:477` | Reads the live guards from the frame when the caller gives none | Its two callers hold a run. Pass the stack |
| `outerRunOrNone()` | `asyncContext.ts:296`, used by the three root frames in `node.ts` and by `runInTestContext` and `runInBootstrapFrame` | A run started from inside another run inherits the outer run's lineage (call depth, executing handlers) | With no hidden frame, a nested run can only inherit it when it is started before an `await`. Find out whether anything starts a run from inside a run. If so, pass the outer run explicitly |
| The logging client's span storage | `lib/statelogClient.ts:167`, `251`, `332` | It is what a bound logger is checked against | Delete it. `runInBranchContext` then only copies the stack and hands it to `fn` |
| The logging client's unbound fallback | `lib/statelogClient.ts:1638` | `post` on the bare client reads `__globals()` | Delete the read. The bare client is `ctx.rootLog`, and redacts with the top-level globals |

Five posts still go through the bare client from inside a run. After
Phase 3 they would log with the root span stack and skip a branch's
redaction tags, with no error. Fix them or accept each one knowingly:

- `result.ts:175`, the same `warnDroppedData`.
- `recordPaidUsage.ts:51`, `53`, `136`: the diagnostic posts when the
  channel to a parent process is gone.
- `stdlib/threads.ts:242`, `261`: `_eagerSummarizeIfNeeded`.
- The graph engine. `node.ts`, `interrupts.ts`, and `rewind.ts` hand it
  `execCtx.rootLog`, and it posts while the root run is current. On the
  root run the two loggers agree, so this one is harmless.
- The eight `__internal_*` helpers in `stdlib/memory.ts`, which only one
  test uses.

### 1a. Take the span methods off the bare client. BUILT.

Added on 2026-10-05, at the owner's request.

Commit `0e1b7b4cc` gave each fork branch its own span stack, because
branches that shared one popped each other's spans. A run's logger,
`run.log`, holds its branch's stack. The client itself,
`ctx.statelogClient`, holds the root stack that every branch shares. So a
`startSpan` on the bare client from inside a branch is that old bug again.

Today a bound logger throws when its stack disagrees with
`AsyncLocalStorage`. Step 2 deletes that check, and afterwards the mistake
would give wrong span parents with no error. The type checker now catches
it:

- `RootLog` in `lib/statelogClient.ts` is the client without `startSpan`
  and `endSpan`. `ctx.statelogClient` and `ctx.rootLog` have that type.
- `ctx.rootLogWithSpans` is the whole client, for the code that owns the
  root span stack: the `agentRun` span, the graph engine's span around
  each node, the node boundary that closes an `abortUnwind` span, and the
  two functions that make a run's logger (`logOf`, `branchLog`).

Making the change turned up one real case: the eight `__internal_*`
helpers in `lib/stdlib/memory.ts` handed the bare client to the memory
manager, which opens spans on it. They now pass `logOf(ctx, ctx.globals)`.

### 2. Delete AsyncLocalStorage

The plan's Task 15. Once step 1 is settled:

- `withRun(run, fn)` becomes `callPlain(run, fn, [run])`.
- `currentRun()` drops its comparison with the frame. Its two error
  messages become one: with no frame to look at, "read after an await" and
  "read outside a run" cannot be told apart. Write a message that names
  both causes.
- Delete `sameRun` and its 17 call sites, `WrongRunError`, `requireFrame`,
  `ambientRun`, and `agencyStore`.
- The accessors `__threads()`, `__stateStack()`, `__ctx()`, `__globals()`
  are exported from `agency-lang/runtime`. Generated code no longer calls
  them. Delete them, or keep them as lenient reads of the module variable
  if step 1 needs that. Compiled code from before Phase 2 imports them and
  is already broken by Phase 2, so there is nothing to protect.
- In `lib/statelogClient.ts`, delete `spanStorage` and the mismatch checks
  in `currentStack` and `post`.
- `grep -r "async_hooks" lib` must find nothing. Today it finds
  `lib/runtime/asyncContext.ts` and `lib/statelogClient.ts`.

### 3. Fix the tests

This is the largest hand-written part. Twenty-six test files use
`testRun()` 336 times, and 29 lines in tests name `agencyStore`.

`testRun()` in `lib/runtime/__tests__/testHelpers.ts` returns
`ambientRun(...)`: the frame current at the moment it is called, read from
`AsyncLocalStorage`. That is why it works after an `await` and inside a
nested step body. It cannot survive Phase 3.

The replacement is what real code does: use the run a callback was handed.

```ts
// Today. testRun() reads the hidden frame each time.
await runner.step(0, testRun(), async (r) => {
  await r.step(0, testRun(), async () => { ... });
});

// After. The body's own run is passed on.
await inTestFrame(async (run) => {
  await runner.step(0, run, async (r, stepRun) => {
    await r.step(0, stepRun, async () => { ... });
  });
});
```

`withTestFrame(baseIt)` wraps a test body in a frame but does not hand it
the run. Change it to pass the run as the test body's first argument, or
add a form that does. A nested call that uses the outer run will fail the
wrong-run check with `RunInUseError`, which is the check doing its job:
pass the inner run.

`callHelper(fn, ...args)` calls a helper the way the runtime does. It uses
`testRun()`, so it needs the run passed in too.
`adoptCtx(ctx)` mutates the current frame's run so that `run.ctx` is a ctx
the test built after the frame existed. `runner.test.ts` uses it 63 times.
It reads the frame as well.

In Phase 2 a subagent fixed 41 test files from a written brief in about
ten minutes, and later 27 more. Give this to a subagent the same way: one
brief, the files it may edit, the rule above, and a report of every test
whose meaning changed.

### 4. The lint rule

The plan's Task 16. Turn `scripts/audit-run-reads.mjs` into a check that
fails when a function can reach `currentRun()` after an `await`. It should
follow calls, so it also catches a function that awaits and then calls a
helper whose first line is `currentRun()`. Add it to
`pnpm run lint:structure`. The script still has names from before Phase 2
in its lists of readers and installers. Update those first, and rerun it to
see what it reports today.

### 5. New tests

The plan's Task 17 lists eight. Check which already exist before writing:
`tests/agency-js/concurrent-helper-isolation` covers two runs through a
helper that waits, `tests/agency/handler-lineage` covers who is asked,
`lib/runtime/wrongRun.test.ts` covers the wrong-run check on a model, and
`lib/runtime/asyncContext.test.ts` covers `callPlain`.

Still missing:

1. A hand-written `.js` helper awaits a timer, then raises an interrupt
   through the handle, and a `handle` block approves it. The handle has no
   `interrupt` function yet. Add one.
2. The same helper under `agency serve`.
3. A handler function calls a TypeScript helper. The helper awaits a timer
   and then raises the handler's own effect through the handle. The
   handler is skipped, as it is today.
4. A helper makes two `run.call`s at once.
5. Two runs paused and resumed at the same time keep their own globals.
6. A memory call inside `withCostGuard` charges the guard, and an
   over-budget one trips it.

Write each as a prediction and run it on the Phase 2 branch before changing
anything. The owner asked for this after several of my beliefs turned out
false when run.

### 6. Docs

The plan's Task 18.

- Rewrite `docs/dev/runtime/async-context.md` and
  `docs/dev/compiler/codegen-als-accessors.md` for the `Run` parameter.
  Both still describe frames found through `AsyncLocalStorage`.
- Add `docs/dev/runtime/running-without-node.md`, with the goals and the
  branching rule from PR #1167 and this decision in place of that one.
- Update `docs/site/guide/ts-helpers.md`. It says every `agency.*` method
  reads an `AsyncLocalStorage` frame, and its examples call `agency.llm`
  after an `await`. Under the new rule those throw. The page says at the
  top that an LLM wrote it and it may be out of date.
- Update `docs/site/guide/guards.md`, which shows `getRuntimeContext()`.
- Update the `std::ui` docs for Decision 9.
- Update the `CLAUDE.md` index and the matching skill.
- Read `docs/dev/contributing/general-writing-tips.md` and
  `verbal-tics.md` before writing any of it.

### 7. Verify

- All three suites in CI.
- `grep -r "async_hooks" lib` finds nothing.
- Bundle the built context module with esbuild for the browser platform
  and check that it resolves with no Node module. `asyncContext.ts` imports
  `node:process` for nothing once `AsyncLocalStorage` is gone: check.

## What Phase 3 loses, and what protects the work after it

Today every hand-over of a run is compared with `AsyncLocalStorage`. That
comparison found three real things in Phase 2: the subprocess listener's
run, a thread store shared across branches, and the logger of a batched
decision round. After Phase 3 it is gone. What remains:

- **The type checker.** A runtime function that needs a run and is not
  given one does not compile.
- **The shadowed name.** Every body the runtime calls back declares
  `__run`, so generated code cannot reach an outer run by accident.
- **The wrong-run check.** A run that is waiting cannot start work. It has
  passed all three suites, but it has had much less exercise than
  `sameRun`, and it does not cover the unsupported `async` call path.
- **`currentRun()` throwing after an `await`**, and the lint rule from
  step 4.

So before deleting anything, run the full suites one more time on the
Phase 2 branch and confirm they are green. A failure of `sameRun` or of the
bound logger is information you cannot get back later.

One thing to watch for: `withChildRun` adds a `.then` to the promise its
body returns, which is one extra turn of the microtask queue per step and
per call. Nothing has been affected by it. If a timing-sensitive test
starts failing, look there.

## What the three phases cost

Changed lines, added plus removed:

| | Phase 1 | Phase 2 |
| --- | --- | --- |
| Generated: fixtures, package `index.js`, template output | 0 | about 10,360 |
| Runtime source | 245 | about 2,670 |
| Standard library helpers | 0 | about 870 |
| Code generator | 0 | about 330 |
| Hand-written tests | 650 | about 3,280 |
| Plans and docs | 1,950 | about 380 |
| Audit script | 340 | 0 |
| **Total** | **about 3,200** | **about 17,900** |

My estimate for Phase 3 is 2,000 to 3,000 changed lines with nothing
generated: 300 to 500 of source, mostly deletions, 500 to 1,000 of tests,
800 to 1,200 of docs, and a few hundred for the lint rule. It is an
estimate from counts. The estimate I gave for the Phase 2 tail was 800 to
1,500 lines and it took about 1,940, so treat this one the same way.

To measure a phase by category, see `stat.sh` in the section below.

## Things that are open

Ask the owner about these. Do not decide them alone.

1. **An abort that reaches a node boundary now logs its event.** Before
   Phase 2 it read the frame after the frame had ended, so it almost never
   logged. I kept the change because the function's own comment says it
   should log. `lib/runtime/abortBoundary.ts:49`: pass `undefined` to
   restore the old silence.
2. **Peer ranges of the published packages are not raised.** Every
   package's compiled `index.js` was rebuilt, because code from the old
   compiler calls the runtime with the old argument order. A published
   copy needs a new release and a raised peer range, and that needs the
   release number.
3. **The callbacks of `agency.withHandler`, `withCostGuard`,
   `withTimeGuard`, `withLock`, and `thread.with` are not handed a
   handle.** The plan's section "`agency.*` functions that take a callback"
   says they should be. Today such a callback can call `agency.*` on its
   first line and not after an `await`. The guide's example for
   `withCostGuard` awaits and then calls `agency.llm`, which now throws.
4. **`std::ui` loops called from TypeScript with no run throw.** `_runLoop`
   and `_runReplLoop` did not before.
5. **A batched round of decision calls picks its test mock queue by the
   first call's module.** It used the arm that triggered the round. Only
   scoped test mocks can tell.

## Things I got wrong, so you do not repeat them

1. **I used "handler body" when I meant "handler function".** The guide
   (`docs/site/guide/handlers.md`) says the block after `handle` is the
   handler body and the block after `with` is the handler function. The
   owner answered a different question from the one I meant. Use the
   guide's words.
2. **I used the `async` keyword on a call.** It is not a supported part of
   Agency. The guide says Agency has no async/await: concurrency is
   `fork`, `race`, `parallel`, and `seq`. The parser still accepts the
   keyword and three old tests use it. Keep that code path compiling. Add
   nothing for it.
3. **I reported branch isolation as a bug.** A global written by a handler
   function goes to the raising branch's copy when the interrupt came from
   a fork branch or a subprocess call. The guide documents it under state
   isolation.
4. **I repeated a claim from a review without running it.** The review
   said the listener for a subprocess's messages runs with no frame. A
   trace showed it has one.
5. **I named the wrong run to store for that listener.** The plan said
   `s.parentStore`. The right one is the subprocess call's branch run,
   which carries the cloned globals. `sameRun` showed it.
6. **I asked for a decision the guide already answers.** Whether a handler
   function is asked about an interrupt raised by a subprocess it started:
   it is not, because a handler function is never asked about an interrupt
   raised inside itself.

The owner asked me to read every page of `docs/site/guide/` before going
on, and I did. Do the same before you start. It is 72 pages. Three say at
the top that an LLM wrote them and they may be out of date:
`ts-helpers.md`, `memory.md`, `custom-providers.md`.

One bug is known to the owner and is not part of this work: an interrupt
raised by a call inside a method call's arguments is dropped
(`out.push(save(name))`). Do not file it and do not fix it here.

## Commands and rules for this repo

```bash
make build               # about 3 seconds; rebuilds dist
make                     # everything, including the stdlib. Needed after any lib/stdlib change
pnpm run templates       # after editing a .mustache file
make fixtures            # after a generator change
pnpm run typecheck       # three tsc configs
pnpm run lint:structure
pnpm run fmt:ts          # CI fails without it
pnpm test:run            # unit tests, about 2 minutes
node dist/scripts/agency.js test tests/agency/<folder> -p 12
node dist/scripts/agency.js test js tests/agency-js -p 12   # 190 tests
node dist/scripts/agency.js fmt -i <file.agency>
gh pr checks 1170
```

- Do not run the full `tests/agency` suite locally. CI runs it in eight
  shards. The folders that matter here: `handlers`, `handler-lineage`,
  `fork`, `subprocess`, `guards`, `threads`, `substeps`, `ts-helpers`,
  `blocks`, `memory`, `agents`, and the `callback-*` files.
- Save every test and build output to a file, and read the file.
- The Agency-js run rewrites two tracked files. Restore them before
  committing:
  `git checkout -- tests/agency-js/llm-provider-defaults/log.jsonl tests/agency-js/tool-tiers/log.jsonl`.
  Do not run `git checkout tests/agency-js`: it would also discard edited
  test helpers.
- After a generator change, recompile each package's entry file. From
  inside each of `email github kokoro lora mcp tesseract-local web-fetch
  whisper-local`: `node ../agency-lang/dist/scripts/agency.js compile index.agency`.
  Commit generated files (fixtures, package `index.js`) in their own
  commit.
- `make` prints five `AG6019` and `AG3013` errors for two agent files
  under `lib/agents`. They are on the Phase 1 branch too.
- `lib/runtime/prompt.ts` sits at the linter's limit of 1,250 code lines.
  Adding one line fails `lint:structure`. Replace a `ctx` parameter with
  `run` in place and read `run.ctx`.
- A package's unit tests, run from inside a worktree, pick up the main
  checkout's `vitest.config.ts` and find no tests. Give vitest a small
  local config with `-c`.
- Write commit messages and PR bodies to a file and pass the file. Never
  amend, never force push.
- A long Bash command containing `rm -rf` is denied. Clean up in a short
  separate command.
- Agency files cannot be run from `/tmp`. Put scratch files under
  `tests/agency/` in the worktree and delete them afterwards.
- Types, not interfaces. Arrays, not Sets. Objects, not Maps. No dynamic
  imports.

To measure a diff by category, save this as `stat.sh` and run
`bash stat.sh explicit-run-phase-2...HEAD`:

```bash
git diff --numstat $1 | awk -F'\t' '
{ a=$1; d=$2; f=$3; if (a=="-") next;
  if (f ~ /tests\/typescriptGenerator|tests\/typescriptBuilder/) c="fixtures (generated)";
  else if (f ~ /^packages\/[^\/]+\/index\.js$/) c="package index.js (generated)";
  else if (f ~ /lib\/templates\/.*\.ts$/) c="template .ts (generated)";
  else if (f ~ /docs\//) c="docs and plans";
  else if (f ~ /\.test\.ts$|__tests__|\/tests\//) c="tests (hand-written)";
  else if (f ~ /lib\/stdlib\//) c="source: stdlib helpers";
  else if (f ~ /lib\/runtime\/|lib\/serve\/|lib\/statelogClient/) c="source: runtime";
  else if (f ~ /lib\/backends|lib\/ir|lib\/preprocessors|\.mustache$/) c="source: code generator";
  else c="other";
  A[c]+=a; D[c]+=d; N[c]++ }
END { for (c in A) printf "%-32s %4d files  +%-6d -%-6d\n", c, N[c], A[c], D[c] }' | sort
```

## Working with subagents

Three subagents did the mechanical parts of Phase 2: the unit tests, the
standard library helpers, and the tail. What made it work:

- One written brief that says which files the subagent may edit, the rule
  to apply with a before and after example, how to verify, and what to
  report.
- "Do not touch git" and "do not edit outside these files; report what you
  needed instead".
- Asking for the list of tests whose meaning changed, and for anything a
  check revealed that was not the subagent's own mistake.
- Rerunning the checks and the suites yourself when the report comes back.
  Do not relay a subagent's numbers as your own.
- Running only one at a time. They all touch the same signatures.

## How the owner wants to be spoken to

- Lead with the answer, in plain words.
- Name things in full. No single-letter placeholders. Show a program next
  to its output.
- Use the guide's own terms.
- Do not repeat a claim from a doc or a review without testing it. Say what
  was run and what was only read.
- When a question is asked, answer it. Do not build unasked. When the owner
  says pause, stop, including any subagent.
- Give sizes in numbers, and say when a number is an estimate.
