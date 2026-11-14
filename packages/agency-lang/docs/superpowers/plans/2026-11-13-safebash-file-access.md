# Plan: safeBash file access, in-process pipelines, saved output as files

Date: 2026-11-13. Spec: `docs/superpowers/specs/2026-11-13-safebash-file-access-design.md`. Read the spec first; this plan says how to build it and in what order.

## For the agent picking this up

You are starting with no context from the conversation that produced this. Here is what you need.

**What you are building.** `safeBash` turns a shell command into narrow approval questions and runs some commands itself with no shell. This work adds three things: a list of the files a command line touches, as plain data on its plan; a table of "mounts", which are paths that do not live on disk; and a runner for pipelines such as `grep -n FAILED out.log | tail -5` that needs no shell. With those, long tool output that Agency saves in memory can be given to the model as a path, and the model reads it with `cat`, `head`, `tail`, `grep` and pipelines of them.

**What the owner cares about.** Fewer approval prompts for commands that read and search. No sandbox. Saved output is never written to the real disk. The general design (a file-access layer with mounts) is preferred over a special case for saved output, because the owner expects other mounts later.

**Read these before any code, in this order.**

1. `CLAUDE.md` in this package, the section on interrupts, handlers, policies and effects. safeBash is approval infrastructure, and a mistake here is a security bug.
2. `docs/dev/stdlib/safe-bash.md`, all of it. It is long. The sections you will change are "In process when it translates", "Pipelines, dup redirects, and glob words", "Stages that read a pipe", "The read family", "grep", and "Chains in process".
3. `docs/dev/stdlib/spill.md`, for where saved output lives and why it raises no effect.
4. `docs/dev/contributing/anti-patterns.md` and `docs/dev/contributing/coding-standards.md`.
5. `stdlib/safeBash/actions.agency` (the effect and execution types), then the parts of `stdlib/safeBash.agency` each task names.

**Rules of this repository that have caught agents before.**

- Change files with the Edit and Write tools only. Never rewrite a file with `sed`, a script, or a heredoc.
- Commit messages and PR descriptions go in a file passed to git or `gh`. Never force push or amend. The owner merges PRs.
- No dynamic imports. Objects, not maps. Arrays, not sets. Types, not interfaces.
- Do not run `agency fmt` on an existing `.agency` file; it buries the diff. Format only files you add.
- Never put a branch for one tool's name or one tool's result shape in `lib/runtime/`. If the tool loop needs to know something about a tool, the tool carries a marker.
- If a test needs to delete files, use the existing safe-delete helpers. Do not run anything locally that could delete the home or root folder if it had a bug.
- Dev docs state the mechanism and the rule. They do not tell the history of how you got there.

## The parts and their order

Four parts, each its own PR, each mergeable alone. Do them in order: each builds on the one before.

| Part | PR contains | Depends on |
|---|---|---|
| 0 | A measurement, no code in this repository | nothing |
| 1 | File accesses as data on the plan | nothing |
| 2 | Mounts, with the spill store as the first | 1 |
| 3 | Pipelines in process | 1 (and 2 for mounted sources) |
| 4 | Notices name a path; the coding agents drop the spill tools | 2 and 3 |

## How to test

Build and test once per part, not once per change.

- `make` after changing any `.agency` file under `stdlib/` or `lib/agents/`, or any template. `pnpm run build` after changing only TypeScript.
- Run only the tests that cover what you changed, with the capability check, and save the output to a file so a failure does not need a rerun:

  ```
  pnpm run agency test tests/agency/safeBash.agency --check-capabilities > /path/to/scratch/safeBash.log 2>&1
  ```

- `pnpm run typecheck` (not bare `tsc`), `pnpm run lint:structure`, and prettier on the TypeScript files you touched.
- Do not run the whole Agency suite locally. CI runs it on the PR. Watch CI per job and fix what it finds.
- The relevant test files: `tests/agency/safeBash.agency` and its `.test.json` (about 135 cases), `tests/agency/spill.agency`, `tests/agency/agents/toolkits.agency`, `lib/stdlib/spill.test.ts`, `lib/runtime/toolOutputStore.test.ts`, `lib/stdlib/agentToolTrace.test.ts`.

## Part 0: measure before building

The benchmark transcripts in `~/bench-agency/jobs/` hold about 21,000 bash commands from real coding runs (jobs `k1-agency-minimal` and `k2-agency-minimal`; each trial folder has `agent/statelog.jsonl`, where every model call lists its tool calls). Write a throwaway script under `~/bench-agency/analysis/` that parses each command with the same bash parser safeBash uses, or approximates it, and counts:

1. Lone commands safeBash already runs in process.
2. Pipelines whose first stage is `cat`, `head`, `tail`, `grep` or `echo` and whose later stages are all read verbs, `grep`, or `tr`. Break this down by filter verb and by flag.
3. Pipelines whose first stage is a real program (`git`, `python`, `pytest`) followed by filters.
4. Everything else.

This decides two things: the order in which to build the filters in Part 3, and which flags are worth supporting. Write the counts into the Part 3 PR description. If group 2 is under a few percent of commands, tell the owner before starting Part 3: the case for it would then rest on saved output alone.

## Part 1: file accesses as data

**Goal.** `Plan` gains `accesses: FileAccess[]`. Nothing a user can observe changes.

**Files.** `stdlib/safeBash/actions.agency` (types, `effectFor`), `stdlib/safeBash.agency` (the rules), `docs/dev/stdlib/safe-bash.md`.

**Steps.**

1. Add `Place` and `FileAccess` to `actions.agency` as the spec gives them. Every access built in this part has `place: { kind: "disk" }`.
2. Find every place a file effect is built. Start from the effect constructors in `actions.agency` (`readEffect`, the grep, ls, write and remove equivalents) and list their callers. `otherVerbEffects`, `redirectEffect`, the grep rules, the listing rules, the `rm` rule, and the shell-free planners are the main ones.
3. For each, build the `FileAccess` and derive the effect from it where the effect is only a path. Where the effect needs more than the path (a grep's pattern, a write's bytes), keep building the effect in the rule and record the access beside it. Do not widen `FileAccess` to carry a rule's private data.
4. Thread `accesses` into `Plan` at the places plans are built (`bashPlan`, the shell-free planners, `tryShellFreeChain`). A chain's accesses are its steps' accesses in order.
5. Add the accesses to `planRecord`, which feeds the `safeBash plan` debug event.

**Tests.**

- Every existing case in `tests/agency/safeBash.agency` passes with its expected output unchanged. This is the main test.
- New cases that read `planFor(...).accesses` for: a lone `cat` of two files; `wc -l a.txt`; `grep -rn x src`; `echo hi > out.txt`; `rm -rf build`; `ls src`; a chain; a broad line (accesses empty, because nothing was understood); `pnpm test` (accesses empty, with a `std::exec` effect).
- One case asserting that for every disk access a matching effect is in `plan.effects`.

**Doc.** A short section in `safe-bash.md`: what an access is, the rule that `plan.accesses` is complete for a narrow plan and empty for a broad one, and that effects for disk paths are unchanged.

## Part 2: mounts

**Goal.** A path under a mount resolves to stored text. `cat`, `head`, `tail` and `grep` of a mounted path work in process and raise nothing. Anything else that names a mounted path is refused with a message.

**Owner decision needed first:** the path spelling (spec, decision 1). The plan below writes `SPILL_MOUNT` for it.

**Files.** A new small module for `MOUNTS` and `mountFor` (it must be importable by both `safeBash.agency` and `stdlib/agents/lib/toolkits.agency` without a cycle; follow `docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md`), `stdlib/safeBash.agency`, `docs/dev/stdlib/safe-bash.md`, `docs/dev/stdlib/spill.md`.

**Steps.**

1. Write the module: the `Mount` type, `MOUNTS` with one row, `mountFor(text)`, and `spillPlace(rest)`, which accepts exactly what `isOutputName` accepts and fails on anything else, including a name with a slash or `..`.
2. In `resolveReadPath` and the grep path resolver, ask `mountFor` before `_searchTargetIn`. Return a path whose place is the store. Keep the "must be literal" rules: a variable or glob in a mounted path is still unrecognized.
3. Write `bytesOf(access)` and use it in `printRead` and the in-process grep where they call `_read` and `_grep` today. For grep over stored text, reuse what `grepSpill` does (`lib/stdlib/spill.ts`), so the two cannot drift.
4. `effectFor` returns null for a store access. Check `raiseAll` and the shell-free planners handle an empty effect list; a chain of echoes already produces one.
5. The refusal. In `planFor`, after classification: if the line names a mounted path and the plan does not run in process, return a `refuse` execution with the teaching message from the spec. Also check the raw text for the mount prefix when the string does not parse. A write, redirect, `rm`, or listing that targets a mount is refused the same way, with a message that says a mount is read-only.
6. Make sure the refusal wins over the broad path. A test must show `python x.py SPILL_MOUNT/<name>` never reaches `_bash`.

**Tests** (in `tests/agency/safeBash.agency`, using `keepOutput` to put text in the store, as `longOutputIsKept` does).

- `cat`, `head -n 5`, `tail -n 5`, `grep -n x` of a mounted name return the stored text, raise no interrupt (run under a handler that rejects everything and still succeed), and match what `readSpill` and `grepSpill` return.
- A name that was never saved fails with the store's "no longer available" message.
- `cat SPILL_MOUNT/../etc/passwd`, a name with a slash, and a name that is not an output name are refused.
- `python x.py SPILL_MOUNT/<name>`, `cat SPILL_MOUNT/<name> > out.txt` into the mount's own folder, `rm SPILL_MOUNT/<name>`, `ls SPILL_MOUNT`, and an unparseable string naming the mount are refused with the right message, and no shell runs.
- A chain mixing a disk read and a mounted read raises only the disk read's effect.
- A checkpoint round trip: save output, checkpoint, restore, read through the mount.

**Doc.** A "Mounts" section in `safe-bash.md` with the table, the four rules (no effect, read-only, flat names, refused when it cannot run in process), and how to add a mount.

## Part 3: pipelines in process

**Goal.** A pipeline whose first stage is an in-process source and whose later stages are in-process filters runs with no shell.

**Files.** New `lib/stdlib/pipeFilters.ts` and its test; `stdlib/safeBash/actions.agency` (`PipeExec`, `Filter`, `StepExec`); `stdlib/safeBash.agency` (planner and runner); `docs/dev/stdlib/safe-bash.md`. The Linear ticket ADI-261 is this runner; link it in the PR.

**Steps.**

1. **Filters in TypeScript.** One pure function per verb, `(input: string, flags: ParsedFlags) => { output: string; exitCode: number }`. Build them in the order Part 0 found. For each, implement exactly the flags its `READ_VERBS` row lists (and grep's flag table for a stdin grep, `TR_SET_COUNTS` for `tr`). Reuse `_renderReadView` (`lib/stdlib/readDialect.ts`) for `head`, `tail` and `cat -n`, and the grep query code (`compileGrepQuery`, `firstMatchingLines`) for grep, so a lone command and a filter cannot disagree.
2. **A filter that cannot match the real program is left out.** If a flag's output differs across GNU, BSD and busybox, either pick GNU under `LC_ALL=C` and say so in the dev doc, or do not accept that flag in process. Do not approximate.
3. **Types.** `Filter = { verb: string; flags: ...; }` and `PipeExec = { kind: "pipe"; source: StepExec; filters: Filter[] }`. Add `PipeExec` to `Execution` and to `StepExec`. `outcomeOf` and `stepExecOf` have exhaustive matches that will fail to compile until you decide each; a pipe is `shellFree` and is a valid chain step.
4. **Planner.** `tryShellFreePipe(stages, cwd)`: the first stage plans through `tryShellFreeStep`; every later stage must be a simple command (no group) that its verb's rule says reads stdin, with no redirect. Any stage that fails sends the whole line down today's path, unchanged. Call it where `tryShellFreeChain` handles a link, so a pipe can be a chain link, and for a lone pipeline.
5. **Runner.** `runPipe`: run the source through the existing step runner, then fold the filters over its text. The result's exit status is the last filter's. A non-zero exit is an `exitFailure`-style failure carrying `data.type == "commandExit"`, so the agents' `bash` returns it as a result. Send the final text through `keepOutput`.
6. **Bounds.** A source larger than the read tool's own limit fails with a message; do not hold unbounded text.
7. **The refuse wall.** Confirm `flattenOne` still sees every stage of a pipeline that runs in process. Add a test: `cat a.txt | shred` is refused, not run.

**Tests.**

- `lib/stdlib/pipeFilters.test.ts`: for each filter and each accepted flag, fixed input and expected output, including empty input, no trailing newline, and CRLF.
- A comparison suite that runs each filter and the real program on the same inputs and compares bytes. It needs a shell, so gate it the way the real-git cases in `tests/agency/safeBash.agency` are gated, and keep it out of the browser-safe unit set.
- In `tests/agency/safeBash.agency`: `planFor` on `grep -n x a.txt | head -3` gives a `pipe` execution with the grep's effect only; the same line runs and prints what bash prints; `cat a.txt | grep zzz` fails with exit 1; `git log | head` and `pytest | tail` still plan as bash, unchanged; a pipe as a chain link; a pipe over a mounted source raises nothing.
- Every existing safeBash case still passes. Some expected plans will change from `narrow` to `shellFree`; list each one in the PR description with the before and after.

**Doc.** Replace the sentence "a pipeline needs a runner of its own (ADI-261)" with a "Pipelines in process" section: what counts as a source and a filter, the all-or-nothing rule, the exit status, and each place the output is defined to differ from a given coreutils.

## Part 4: saved output as files

**Goal.** Notices name a path. The coding agents read saved output with `bash` and `read` and no longer carry the two spill tools.

**Owner decisions needed first:** which agents drop the tools (spec, decision 2) and whether the stdlib keeps `readSpill` and `grepSpill` (decision 3). The plan assumes the recommendations.

**Files.** `lib/runtime/toolOutputStore.ts` (`outputNotice`, `tailNotice`), `lib/runtime/toolInvocation.ts` (`spillSettings`), `stdlib/agents/lib/toolkits.agency` (`readCapped`, `codingFileAndShellTools`, `bashTool`), `lib/stdlib/agentToolTrace.ts`, and the docs `spill.md`, `coding-agent.md`, `tool-output.md`.

**Steps.**

1. `readCapped` reads a mounted path from the store, with `offset` and `limit`, and raises no interrupt for it. It uses `mountFor` from the Part 2 module. The model may pass the whole path as `filename`, or the mount folder as `dir`; handle both.
2. The notices. When the call's tools can read a path (see step 3), the notice ends `Full output: SPILL_MOUNT/<name>`. Otherwise it keeps today's wording, which names `readSpill` and `grepSpill`. `safeBash` does not know the call's tool list (`spill.md` says so); decide how `keepOutput` learns which wording to use, and prefer passing it in over reading the tool list from inside the tool.
3. `spillSettings` refuses a call that sets `spillToolResultsOver` with no reader in its tools, by finding the readers by module and registered name. Extend that same mechanism so a function can declare "I read saved output by path". Do not test for the names `bash` or `read`.
4. `codingFileAndShellTools()` returns four tools. Update the `bash` and `read` descriptions to say that a path under `SPILL_MOUNT` is saved output. Keep `spillTools()` for the agents that fetch pages and have no shell.
5. The agent trace (`agentToolTrace.ts`) shows `output of <command>` when a spill reader runs. Give a `cat` or `read` of a mounted path the same line.
6. `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency` checks every agent for the two readers. Change it to "every agent that can receive a saved-output notice has a way to read it".

**Tests.** The notice wording for each tool list; `read` of a mounted path with and without `offset`; the trace line; the tool-list test above; a tool loop run where a long result is saved and then read back with `bash`.

**Measure.** Before asking for a merge, run the coding agent on the 100-task SWE-bench set against `main` at the same time (`~/bench-agency`; read `CHECKLIST.md` there and the notes in the owner's memory first). Ask the owner before spending. Report pass count, model calls, input tokens, and for each arm how many saved outputs were read back and by which command. The change is worth merging if the pass count holds and the model reads saved output at least as often as before.

## What to bring back to the owner

- The Part 0 counts, before Part 3.
- The three decisions in the spec, before Parts 2 and 4.
- Any accepted flag whose in-process output you could not make match the real program.
- Any place where keeping "effects for disk paths do not change" turned out to be impossible in Part 1.
