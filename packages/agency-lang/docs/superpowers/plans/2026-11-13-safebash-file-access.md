# Plan: saved output as files, and file access as data

Date: 2026-11-13. Spec: `docs/superpowers/specs/2026-11-13-safebash-file-access-design.md`. Read the spec first; this plan says how to build it and in what order. Both were revised on the same day after a review, and the spec's last section lists what changed.

## For the agent picking this up

You are starting with no context from the conversation that produced this. Here is what you need.

**What you are building.** When a tool result is too long, Agency saves it in the run's memory and today tells the model to call `readSpill` or `grepSpill`. After this work the model is given a path instead, and reads it with whatever it likes: the `read` tool, `tail`, `grep … | head`, `sed -n`, a Python script. The saved text stays in memory. A real copy is written to the temp folder only at the moment a real program is about to run on it.

Separately, and smaller: two functions that read "which files does this command line touch" out of a safeBash plan's effects.

**What the owner cares about.** The model should treat saved output as an ordinary file. Reading it never asks for approval. The store in memory is the only source of truth, so pause and resume keep working. No sandbox.

**Read these before any code, in this order.**

1. `CLAUDE.md` in this package, the section on interrupts, handlers, policies and effects. safeBash is approval infrastructure, and this work leaves out an approval question on purpose. A mistake here is a security bug.
2. `docs/dev/stdlib/safe-bash.md`, all of it. It is long. The sections you will change or depend on are "In process when it translates", "The read family", "grep", "Chains in process", "Why the executors call `_bash`, `_write`, `_grep`, and `_read`", and "`startJob` shares the approval".
3. `docs/dev/stdlib/spill.md`, for where saved output lives and why it raises no effect.
4. `docs/dev/stdlib/contained-files.md` and `docs/dev/runtime/host.md`, for how a file is written through the host.
5. `docs/dev/contributing/anti-patterns.md` and `docs/dev/contributing/coding-standards.md`.
6. `stdlib/safeBash/actions.agency` (the effect and execution types), then the parts of `stdlib/safeBash.agency` each task names.

**Before you start.** This work builds on PR #1472, which adds `tailNotice`, `exitIsFailure` and `modelSafeBash`. It merged to `main` at `a80b90157`. Merge `main` into this branch. Do not rebase.

Three reviews of this plan are beside it: `2026-11-13-safebash-file-access-review.md` (of the first version), `-review-2.md` and `-review-3.md`. The second one explains, with examples, why the read question is left out only under the conditions in Part 2, and the third explains the order of `savedOutputRules` and `bashPlan`. Read both before Part 2.

**Rules of this repository that have caught agents before.**

- Change files with the Edit and Write tools only. Never rewrite a file with `sed`, a script, or a heredoc.
- Commit messages and PR descriptions go in a file passed to git or `gh`. Never force push or amend. The owner merges PRs.
- No dynamic imports. Objects, not maps. Arrays, not sets. Types, not interfaces.
- Do not run `agency fmt` on an existing `.agency` file; it buries the diff. Format only files you add.
- Never put a branch for one tool's name or one tool's result shape in `lib/runtime/`.
- No code to support symlinks. Where one would be needed, refuse the symlink.
- If a test needs to delete files, use the existing safe-delete helpers. Do not run anything locally that could delete the home or root folder if it had a bug.
- Dev docs state the mechanism and the rule. They do not tell the history of how you got there.
- Check every Agency snippet you copy from the spec with `pnpm run ast` before relying on it. The spec's snippets are signatures, not tested code.

## The parts and their order

Three parts, each its own PR, each mergeable alone.

| Part | PR contains | Depends on |
|---|---|---|
| 1 | File accesses read from a plan's effects | nothing |
| 2 | A saved output can be read by path: in process, by a real program, and by `read` | 1 |
| 3 | Notices name the path; agents with a shell drop the spill tools | 2 |

Do them in order. Part 2's one rule function reads what a plan touches through Part 1's `accessesOf`.

**The shape to keep.** Saved output is handled in five places, and nowhere else: `planFor` lists the saved paths a line names, the path resolvers say where a path's bytes are, `textOf` reads them, `savedOutputRules` decides what is asked and what is refused, and the one function that starts a shell writes the copies. If you find yourself adding a saved-output check inside a verb's rule (the `rm` rule, the redirect rule, a read verb), stop: it belongs in one of the five.

## How to test

Build and test once per part, not once per change.

- `make` after changing any `.agency` file under `stdlib/` or `lib/agents/`, or any template. `pnpm run build` after changing only TypeScript.
- Run only the tests that cover what you changed, with the capability check, and save the output to a file so a failure does not need a rerun:

  ```
  pnpm run agency test tests/agency/safeBash.agency --check-capabilities > /path/to/scratch/safeBash.log 2>&1
  ```

- `pnpm run typecheck` (not bare `tsc`), `pnpm run lint:structure`, and prettier on the TypeScript files you touched.
- Do not run the whole Agency suite locally. CI runs it on the PR. Watch CI per job and fix what it finds.
- The relevant test files: `tests/agency/safeBash.agency` and its `.test.json` (134 cases), `tests/agency/spill.agency`, `tests/agency/agents/toolkits.agency`, `lib/stdlib/spill.test.ts`, `lib/runtime/toolOutputStore.test.ts`, `lib/stdlib/agentToolTrace.test.ts`.
- Tests that write a copy must run with a throwaway temp folder, so they never write into the real `/tmp`. The memory host cannot be used for the real-program tests, because it has no shell. The Node host's `tempDir()` is `os.tmpdir()`, which reads the `TMPDIR` environment variable, so the first thing to try is setting `TMPDIR` to a scratch folder for the test run. Find out whether a test case can set an environment variable; if it cannot, look for a host override. Settle this before writing the Part 2 tests.

## Part 1: file accesses from effects

**Goal.** Two exported functions, `accessesOf(effects)` and `onlyTouchesFiles(plan)`. No rule changes, and nothing a user can observe changes.

**Files.** `stdlib/safeBash/actions.agency`, `stdlib/safeBash.agency` (`planRecord` only), `docs/dev/stdlib/safe-bash.md`.

**Steps.**

1. Add the `FileAccess` type and `accessesOf` to `actions.agency`. It maps each file effect to one access and skips every other effect:

   | Effect | Mode | Path |
   |---|---|---|
   | `std::read` | `read` | `dir` joined with `filename` |
   | `std::grep` | `search` | `dir` joined with `file`, or `dir` when `file` is null |
   | `std::ls` | `list` | `dir` |
   | `std::glob` | `find` | `dir` |
   | `std::write` | `write` | `dir` joined with `filename` |
   | `std::remove` | `remove` | `target` |

   Write it as one match with these six arms and a default that answers nothing. Do not list the git and gh effects. A file effect added later and forgotten here makes `onlyTouchesFiles` answer false, which is the safe answer.
2. Add `onlyTouchesFiles(plan)`: true when the plan is not broad and every effect is one of the six above.
3. Add the accesses to `planRecord`, which feeds the `safeBash plan` debug event.

**Tests** (in `tests/agency/safeBash.agency`).

- `accessesOf(planFor(...).effects)` for: a lone `cat` of two files; `wc -l a.txt`; `grep -rn x src`; `echo hi > out.txt`; `rm -rf build`; `ls src`; `find . -name '*.py'`; a chain.
- `pnpm test`: no accesses, and `onlyTouchesFiles` is false.
- `cat a.txt && git checkout -- a.txt`: one read access, and `onlyTouchesFiles` is false. This is the case a caller would get wrong by looking at accesses alone.
- A broad line: no accesses, and `onlyTouchesFiles` is false.
- Every existing case passes with its expected output unchanged.

**Doc.** A short section in `safe-bash.md`: what an access is, that it is read from the effects and never stored, and that a caller must use `onlyTouchesFiles` before trusting the list to be everything the line does.

## Part 2: a saved output can be read by path

**Goal.** A path that ends in `agency-spill-<id>/<saved name>` reads the stored text. In process it comes from the store. Before a line goes to a real shell, a copy is written. A line that only reads is not asked about the saved output it reads.

**Files.**

- `lib/runtime/toolOutputStore.ts`: `spillPathParts`, `inSpillFolder`, `spillPathsIn`, `spillFolder`, and the same-text check in `storeOutput`.
- `lib/stdlib/spill.ts`: `prepareSpillFiles`, `writeCopy`, and the functions the Agency side calls.
- `lib/host/host.ts` and the three hosts: `userId()` on `HostSystem`.
- `stdlib/spill.agency`, `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`, `stdlib/index.agency` (`read`).
- Docs: `safe-bash.md`, `spill.md`, `host.md`.

**Steps.**

1. **Recognize the path.** One pattern, in one constant beside `isOutputName`, with the folder prefix `agency-spill-` as its own named constant. Three functions are built from it. `spillPathParts(path)` returns `{ folder, name }` when the whole path ends in an `agency-spill-<id>` folder and a name `isOutputName` accepts, and null otherwise. `inSpillFolder(path)` is true when the path is an `agency-spill-<id>` folder or anything below one, judged by the path's parts so that a real spelling under `/private/…` counts. `spillPathsIn(text)` finds every saved-output path in raw command text; a match must end at whitespace, a quote, a shell operator, or the end of the text, so a longer path that starts the same way does not match. Unit test all three before using them.
2. **The folder.** Add `userId(): string` to `HostSystem`: `process.getuid()` on the Node host, or a fixed value where it does not exist (Windows); a fixed value on the browser and memory hosts. `spillFolder(host)` is the temp folder joined with the prefix constant and the user id, with a trailing separator.
3. **Where the bytes are.** Add the `ReadSource` type from the spec; its `saved` variant carries the folder as written and the name. The read verbs and input redirects resolve through `resolveReadPath`. grep resolves through `resolveTarget` (`safeBash.agency`, the grep rule), because a grep target can be a folder; do not route grep through `resolveReadPath`, which refuses a folder. Both ask `spillPathParts` first, through one small shared function, and answer a `saved` source with no stat for a saved-output path. The "must be literal" rules stay: a variable or a glob in the path is still unrecognized. A rule builds its `std::read` or `std::grep` effect for a `saved` source with the folder as `dir` and the name as the file. `ReadExec` and `GrepExec` carry the source, so an executor never looks at path text to ask whether it is a saved output.
4. **Reading the bytes.** Add `textOf(source)`: `_read` for a `disk` source, the store for a `saved` one. `printRead` and the in-process grep call it where they call `_read` today. For a search of a `saved` source, call what `grepSpill` calls (`lib/stdlib/spill.ts`), so the two cannot drift. No executor matches on the source's kind except `textOf` and that one search.
5. **The plan decides once.** Add `savedPaths: SavedPath[]` to `Plan`. `planFor` fills it from the parsed words of every command on a line that parses, and from `spillPathsIn(text)` on a line that does not. Nothing after `planFor` scans command text for saved outputs.
6. **What is asked and what is refused.** Add `savedOutputRules(effects, savedPaths)` as the spec gives it, and call it as the last step of `planFor`, on the finished plan, after `bashPlan` and every other builder. It fails the plan for a `write`, `remove`, `list` or `find` access for which `inSpillFolder` is true, with one message: the folder holds saved output, and a file in it can be read with `read`, `tail`, `head`, `grep`, `wc` or any other command. It drops a `read` or `search` effect of a path in `savedPaths` only when every effect of the plan is `std::read`, `std::grep`, `std::ls` or `std::glob`. It never adds an effect. Do not touch the redirect, `rm`, listing or read-verb rules for this.
7. **A shell line with no effects.** The owner has decided this (spec, decision 3). `bashPlan` does not change: because `savedOutputRules` runs after it, a shell plan ends with no effects only when a read of a saved output was dropped. `echo <saved path>` still asks `std::bash`. Rewrite the comments in `bashPlan` and `runBash` to state the new rule. Check that `raiseAll` and everything after it handle an empty list for a shell plan.
8. **Write the copy.** `prepareSpillFiles(run, paths)` as the spec gives it. `writeCopy`:
   - creates the folder with mode `0700` in an explicit step, not through `makeFolders`, which takes no mode. If the host has no call that creates a folder with a mode, add one;
   - then checks the folder every time: a real folder and not a link, owned by this user, with no access for anyone else. It fails otherwise, with a message that names the folder and says to remove it or run `chmod 700` on it. It does not fix the mode itself;
   - writes the file through `host.files.root(...)`, as `lib/stdlib/clipboard.ts` does for its temp file, with `fileMode` `0600`, overwriting.

   Its failure fails the line. `spillFolder`, the notices and the `folder !== here` check all use `host.system.tempDir()` as given, never a real path: on a Mac the two differ (`/var/folders/…` and `/private/var/folders/…`).
9. **One function starts a shell.** safeBash starts a shell in two places: `runBash` calls `_bash`, and `startJob` calls `_startJob`. Write one function that calls `prepareSpillFiles(run, plan.savedPaths)` and returns its failure, and have both go through it. After this step, `_bash(` and `_startJob(` each appear once in the file.
10. **The `read` tool.** Add `_savedOutputAt(dir, filename)` to `lib/stdlib/spill.ts`: the saved-output name the two arguments point at, or null. It handles the whole path given as `filename` and the folder given as `dir`. In the stdlib's `read` (`stdlib/index.agency`), call it first and return `_readSpill(saved, offset, limit)` for a saved output, before the `std::read` interrupt and before `_prepareContainedPath`, which refuses an absolute path.
11. **Do not store the same text twice.** In `storeOutput`, when an entry already holds the same text, return its name and store nothing. Import both functions from `agency-lang/stdlib-lib/spill.js`, as `index.agency` imports its other TypeScript helpers. Do not import `std::spill` there: `index.agency` is the prelude every stdlib module gets, so that would be a cycle. No agent bundle changes for this; `readCapped` and the verifier's `read` both call `read`.

**Tests** (in `tests/agency/safeBash.agency`, using `keepOutput` to put text in the store, as `longOutputIsKept` does; plus unit tests beside the TypeScript).

In process:

- `cat`, `head -n 5`, `tail -n 5`, `grep -n x` of a saved-output path return the stored text and match what `readSpill` and `grepSpill` return. Run each under a handler that rejects everything; it must still succeed. That is the test that no effect is raised.
- The same with a folder part from another machine (`/var/folders/zz/T/agency-spill-501/<name>`): it still reads the store.
- A name that was never saved fails with the store's "no longer available" message.
- A chain mixing a disk read and a saved-output read raises only the disk read's effect.

Real programs:

- `wc -l <path>` returns the right count, and the copy exists afterwards with the stored text. Run it under a handler that rejects everything; it must still succeed. Its plan has no effects.
- `grep -c x <path> | cat` and `tail -n 3 <path> | head -n 1` do the same, and return what the same command returns on a real file with the same text.
- `wc -l < <path>`, an input redirect, does the same.
- `sed -n '2,3p' <path>` asks `std::exec` for `sed` and nothing more, and under approval prints the right lines.
- A copy that a test overwrites with other text is restored by the next command that names it.
- `sh -c 'cat <path>'` asks its `std::exec` or `std::bash` question as today, and under approval prints the stored text.
- A path with another machine's folder, given to a real program, fails with the message that names this machine's path, and no shell runs.
- `cat <folder>/'<name>'`, with part of the path in quotes, gets its copy. The parsed word is a saved output even though the raw text never holds the path in one piece.
- An unparseable string that names a saved output gets its copy and asks `std::bash`.
- A background job started on a saved-output path finds the copy.
- A path built on a Mac from the notice's own text passes the `folder !== here` check.

Safety:

- `ln -sf <some other file> <path>; cat <path>`, with `std::exec` approved and `std::read` rejected: the line fails. This is the test that a line which does more than read keeps its read question.
- A folder planted with the wrong mode (open to others), and a symlink planted where the folder should be: `writeCopy` fails each time and no shell starts. If the test can make a folder owned by another user, test that too; if it cannot, test the check function directly with a made-up owner.
- `cat <folder>/<name>/../../etc/passwd` is not a saved output: it asks `std::read` for the real path.
- `cat /etc/x/agency-spill-501/<stored name>` reads the store's text, and `wc -l` of the same path fails before bash runs.
- A redirect into the folder (to a saved-output name and to `notes.txt`), `rm <path>`, and `ls <folder>` are refused, and no shell runs.
- `echo <saved path>` still asks `std::bash`: no read of a saved output was dropped.
- `cat` of a large saved output leaves one entry in the store, not two.
- A checkpoint round trip: save output, checkpoint, restore, read by path in process, and read by path with a real program.

`read` tool (in `tests/agency/agents/toolkits.agency`):

- The whole path as `filename`; the folder as `dir`; with and without `offset` and `limit`. None raises an interrupt. Run these against the coding bundle's `read` and the verifier's.

**Doc.**

- `spill.md`: a section "Reading saved output by path": the shape of the path, the three ways it is read, the rule that makes leaving out the approval safe, and the other-machine case.
- `spill.md` also states what is accepted: a background job that an earlier line started, and that was approved for a command naming the folder, could change a copy in the moment before it is read; and a line that names a saved output no longer in the store fails, even if it only mentions it. And the two known gaps from the spec: `exec` writes no copy, and `sed -n` asks a question.
- `safe-bash.md`: the one function that starts a shell and why both `_bash` and `_startJob` go through it; the only-reads rule with the `ln` example; the new wording of "every shell start raises an effect"; the read-only refusals.
- `host.md`: `userId()`, and the folder call if one was added.

## Part 3: notices name the path, and agents drop the spill tools

**Goal.** A notice gives the model a path. Agents with a shell no longer carry `readSpill` and `grepSpill`.

**Owner decision needed first:** which agents stop offering the two spill tools (spec, decision 1). The plan assumes the recommendation: the bundles that carry `bash` or `safeBash`.

**`readSpill` and `grepSpill` are not removed.** They stay public functions in `std::spill`. This part makes them accept a path, and stops some agents from offering them.

**Files.** `lib/runtime/toolOutputStore.ts` (`outputNotice`, `tailNotice`, `spillReaders`, `DEFAULT_READERS`), `lib/runtime/toolInvocation.ts` (`spillSettings`), `lib/stdlib/spill.ts`, `stdlib/spill.agency`, `stdlib/safeBash.agency`, `stdlib/llm.agency` (the `spillToolResultsOver` doc), `stdlib/agents/lib/toolkits.agency`, `lib/stdlib/agentToolTrace.ts`, and the docs `spill.md`, `coding-agent.md`, `tool-output.md`.

**Steps.**

1. **The spill readers take a path.** At the top of `_readSpill` and `_grepSpill`, pass the `filename` through `spillPathParts` and use the name it gives when it gives one. A bare name works as before. Say in both docstrings that the argument is the path from the notice, or the name alone.
2. **One notice wording.** `outputNotice` and `tailNotice` name the path and nothing else, as the spec's "The notices" gives them. Build the path from `spillFolder` of the run's host. Both lose their `readers` parameter. `keepOutput` uses the same wording as everything else, so `jobOutput` needs no change.
3. **The loop stops asking about the tools.** Remove `spillReaders` and `DEFAULT_READERS`, and the refusal in `spillSettings` for a call that sets `spillToolResultsOver` with no `readSpill`. Keep `isSpillReader`: a result that `readSpill` or `grepSpill` returns is still not saved a second time. After this step nothing in `lib/runtime/` looks at a call's tools to word a notice. Update the `spillToolResultsOver` documentation to say what the model needs: `read`, a shell tool built on `safeBash`, or `readSpill`.
4. **The bundles.** The bundles that carry `bash` or `safeBash` stop offering `readSpill` and `grepSpill`. Update the `bash`, `safeBash` and `read` descriptions: output past the limit is saved, the notice gives its path, and the path can be read like any file. Remove "read the rest with readSpill or grepSpill, not with bash" from `safeBash`'s docstring. Keep `spillTools()` for the agents that fetch pages and have no shell, and for the coordinator's main agent, which gets job notices and has no shell; they read the path with `readSpill`.
5. **The trace.** `agentToolTrace.ts` shows `output of <command>` when a spill reader runs. Give a `read`, or a `bash` command whose only path is a saved output, the same line. `TAIL_NOTICE`, `SPILL_NOTICE_PREFIX` and `SPILL_NOTICE_LAST_LINE` match the old wording; update them with the notices.
6. **The tool-list test.** `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency` checks every agent for the two readers. Change it to: every agent has `read`, a shell tool, or `readSpill`.

**Tests.**

- `readSpill` and `grepSpill` with the path, with another machine's path, and with the bare name return the same text.
- The two notices' wording, with the path followed by a space.
- A call that sets `spillToolResultsOver` with no `readSpill` in its tools is accepted.
- A result from `readSpill` is still not saved a second time.
- The trace line and the tool-list test above.
- Three tool loop runs where a long result is saved and then read back: with `bash`, with `read`, and with `readSpill` given the path.
- A job's long output, read back by an agent with `spillTools()` and no shell.

**Measure.** Before asking for a merge, run the coding agent on the 100-task SWE-bench set against `main` at the same time (`~/bench-agency`; read `CHECKLIST.md` there and the notes in the owner's memory first). Ask the owner before spending. Report pass count, model calls, input tokens, and for each arm how many saved outputs were read back and by which command. The change is worth merging if the pass count holds and the model reads saved output at least as often as before.

## What to bring back to the owner

- Owner decision 1 in the spec (which agents stop offering the spill tools), before Part 3. The other four are made.
- Any way a shell starts that you could not route through the one function in Part 2, step 9.
- Any place where leaving out the read question could apply to a path whose bytes are not the store's.
- How the tests set the temp folder, if neither way in "How to test" works.
- The benchmark numbers, before asking for the Part 3 merge.
