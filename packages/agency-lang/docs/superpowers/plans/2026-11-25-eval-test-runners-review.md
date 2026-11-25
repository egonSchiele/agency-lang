# Review: running eval tests in a container

**Reviewed:** `docs/superpowers/specs/2026-11-25-eval-test-runners-design.md` (draft 2) and `docs/superpowers/plans/2026-11-25-eval-test-runners.md`
**Date:** 2026-11-25
**Checked against:** `~/agency-lang` at `34a06d361` (agency-lang 0.45.4) and this repo's `main`.

## Verdict

The overall shape is right. One wrapper command per container, the ordinary `eval run` inside it, and five small framework changes is much less machinery than the custom layer it replaces. I would not change the architecture.

Some details do need fixing before Phase 1 starts. As written, two of them would make the first real run fail:

1. The agent user cannot reach its own workdir or write its statelog (finding 1).
2. The shell runner that `setup` and the serialized graders build on does not do what the spec says it does (findings 2 and 3).

Most of the rest are small corrections to the plan's interfaces and tests.

---

## Must fix

### 1. `bench` cannot reach the workdir or write the statelog

**Where:** spec Part 2 step 3.3 ("root-only"), Part 3 `setup.mts`; plan Task 7 test (`chmod 700 /eval`), Task 0, Task 11.

**What the source does:**

- The inner run's workdir is `<out>/.staging/<testId>/workdir`, and the statelog goes to `<out>/.staging/<testId>/agent/statelog.jsonl` (`lib/eval/run/runSuite.ts:125,184`, `lib/eval/run/extract.ts:26-33`).
- `agent/` is created by the harness, as root, in `execute()`, which runs *after* seeding (`lib/eval/run/runAgent.ts:195`). Under the plan, that is also after `setup`.

**What goes wrong:**

- With `--out /eval/out` and `chmod 700 /eval`, `bench` cannot get into `/eval` at all. It cannot reach the workdir that `setup` gave it.
- Even if it could, `agent/` does not exist yet when `setup` runs, and it is created owned by root. So `setup` cannot hand it to `bench` unless it creates `../agent` itself. That ties the suite to a private framework layout.
- The spike will not catch the first problem. Task 0 does not `chmod 700 /eval`, so it tests different permissions from the ones the wrapper will set.
- `verify` will not catch either problem. It uses the file agent `noop.agency`, which the harness forks as root. Nothing runs the agent as `bench` until Task 14, the paid run.

**Suggested fix:**

- Make only `/eval/project` root-only, and leave `/eval` and `/eval/out` traversable.
- Decide how the agent's statelog folder becomes writable by the agent user, and make that a documented contract rather than `../agent`. Two options:
  - (a) the harness creates `agent/` before `setup` and passes its path in the environment, for example `AGENCY_EVAL_AGENT_DIR`;
  - (b) the spike shows another way.

  I lean toward (a). It is one line in the `setup` docs: "if your agent runs as another user, give it this folder too". This is a framework-contract choice, so it is yours to make.
- Make the spike use the real permissions: upload with the wrapper's `chmod`, and run as `bench` with `runuser`.
- Give `verify`, or one Task 12 step, an agent that runs through the real `runuser -u bench -- agency …` path, so these problems show up without spending money. `noop.agency` would then need a path `bench` can read.

### 2. The shell runner keeps the *start* of the output, not the end

**Where:** spec fact table row 4 ("keeps the end of its output") and 1a ("ends with the tail of the output"); plan Task 1.

`runShell` stops collecting at 16 MB, and `cut()` keeps the first 2,000 characters (`lib/eval/gradersJson/build.ts:164-165, 222-227, 246-248`).

For `setup`, that is the wrong end. A failed `pnpm install` or `make` prints its error last. The error result would show the first 2,000 characters of install progress and never the actual error.

The Task 1 test (`"setup failed (exit 3):\nbuilding\nbroke"`) passes either way, because its output is short.

**Suggested fix:** keep the tail for setup, and add a test with more than 2,000 characters of output before the error line. Whether command graders should also switch to the tail is a separate choice: grader feedback would change. It is probably better, but it is a second behavior change, so say so if you make it.

### 3. A timed-out command keeps running

**Where:** plan Task 2 ("including after one fails or times out"), Task 1 (setup timeout).

On timeout, `runShell` sends `SIGKILL` to `sh` only (`build.ts:231-234`), and then settles at once. Whatever the command started keeps running in the workdir: `pnpm`, `node`, `tsc`, `make`.

So after a timed-out check, the next check can start while the old one's processes are still compiling in the same tree. That is the exact collision Task 2 exists to prevent.

The test `sleep 5` with `timeoutSec: 1` will not show this, because the shell may `exec` the single command and the kill then reaches it.

**Suggested fix:**

- Spawn the command detached and kill the process group, as `lib/eval/run/spawnRunner.ts:83,90` already does for agents. Reuse that code rather than writing a second copy.
- Change the test to a command that starts a background child, for example `(sleep 2; touch late) & sleep 5`, and check that `late` never appears.

### 4. `AGENCY_PLANS_ORACLE` as a forwarded environment variable

**Where:** spec Part 3 `setup.mts`; plan Task 12 (`eval-daytona.json` env list), `verify.mts`.

`eval-daytona.json` forwards `AGENCY_PLANS_ORACLE` from the host shell on every run. If it is ever left exported, a real paid agent run starts from the *solution* commit, scores close to 100%, and could be uploaded.

The spec rejects environment variables for `--batch` for exactly this reason: "a variable left set in a shell would silently merge unrelated runs". The same reasoning applies here, and the damage is worse.

**Suggested fix:**

- Remove it from the config file.
- Give the wrapper a per-invocation `--env NAME=VALUE`, repeatable. `verify.mts` passes `--env AGENCY_PLANS_ORACLE=1`, and the host shell is never read for it.
- Have `setup.mts` print `ORACLE: checking out the solution commit` loudly, so it shows in the log.

---

## Should fix

### 5. The time budget can cut off a run that has already cost money

The spec sets a fixed `setup` limit of 1800 s, and `graceSec` defaults to 3600 for "setup and grading". The `builds` grader alone has `timeoutSec: 2700`, and each check defaults to 600 s (`build.ts:163`). With eight checks, setup plus build plus checks can go well over the grace in the worst case.

When the wrapper's limit is hit, the plan's flow is not clear on whether it still packs whatever `/eval/out/<id>` holds. The run directory exists by then, because Task 3 grades after the rename. If the wrapper does not pack it, a run whose agent cost $4 disappears from the batch.

**Suggested fix:**

- In Task 7, state and test that the run directory is always packed and downloaded when it exists, including after the wrapper's own timeout. A run directory with partial grades is far better than none.
- Either compute the default grace from the limits (setup + the sum of grader timeouts) or document why 3600 is enough.

### 6. Ctrl-C loses the runs that are in flight

**Where:** plan Task 8 ("`main` only has to make `shouldStop` true on the first signal").

`withSandbox`'s handler deletes every live sandbox and then calls `process.exit` (`lib/sandbox/withSandbox.ts:41-49`). So:

- `main` never prints its summary or the upload command.
- Every in-flight run is destroyed, statelog included. The inner `eval run` has its own Ctrl-C behavior that folds the in-flight test into a run directory (`runSuite.ts:133-145`), but the wrapper never forwards the signal into the container.

This may be acceptable, but the spec should say so as a decision rather than leave it to `withSandbox`'s current behavior. The alternative: on the first signal, send SIGINT to each inner command, wait briefly, download what exists, then delete.

Also, the sentence in Task 8 is not accurate: the process exits from inside `withSandbox`, so `shouldStop` only matters for jobs that start before the deletes finish.

### 7. Task 1 extracts the wrong function, and drops `process.env`

- Task 1 says to move `runCommand` into `shellCommand.ts`. But `runCommand` returns a `Grade` and holds the grader-only "no working directory was captured" check. The reusable part is `runShell` (`build.ts:213`). Extract that, and leave `runCommand` as the grader's thin wrapper around it.
- The planned signature takes `env: Record<string, string>`, and "`build.ts` passes `{ AGENCY_GRADER_FILES: graderFiles }`". Today the env is `{ ...process.env, … }` (`build.ts:194`). If the new function does not merge `process.env`, every command grader loses `PATH`, and `setup` loses `PLAN_EVAL_ALLOW_HOSTS` and the forwarded keys. Say which side merges, and test that `PATH` reaches the command.
- The Task 1 test passes `SETUP_TIMEOUT_SEC` as 1, but `RunAgentOptions.setup` is `{ command; testDir }`, which has no field for it. Add `timeoutSec` to that option.

### 8. Task 2: a hidden module-level lock

The plan serializes command graders with a module-level map, keyed by workdir, inside `commandGrader`. It works, but:

- Someone reading `gradeRun.ts` (`:411-430`, gates in order, then `Promise.all`) cannot see that commands take turns. The rule lives in a global in another file.
- The map never forgets a workdir, so it grows in a long-lived process like the optimizer.

You have said future agents copy patterns from this code. An explicit rule in `gradeRun` would be easier to find and copy correctly, for example: "graders that declare they need the workdir to themselves run in order." The lock is the smaller change, though. Pick one on purpose.

### 9. The spike checks too little in two places

- **Fetch by hash:** check all fourteen commits (the start and solution commits of all seven tests), not just one. A solution commit from a squash-merged PR may only be reachable through a PR ref. The oracle pass of `verify` depends on every one of them.
- **Building in a tree `bench` owns:** step 1 builds as root *before* the hand-over, and step 4 runs only one check. The real order is setup → `chown` → agent → the `builds` grader as root in a tree `bench` owns. Run the build command in that order. If `make` or any check calls `git`, git's "dubious ownership" check will refuse to run as root in a repo `bench` owns.
- **How the workdir gets in:** step 2 says "with the built repo copied into the workdir by hand first". The framework creates the workdir during the run, so there is no workdir to copy into beforehand. The simplest way is to make the spike test's `files/` the built repo, which also measures the seeding copy.

### 10. The workdir snapshot is still made, then thrown away

With `--grade` in a container, `foldIntoRunDirectory` still copies the whole built workdir into the run directory. That copy happens before grading, and the wrapper then excludes it from the download. The cost is time, and disk on a 10 GB container holding two copies of a built monorepo. The spike measures the size, and that is the right first step.

Decide in advance what happens if the copy is slow or fails, for example on pnpm symlinks. Either `--grade` skips the snapshot, or `eval run` gains a way to skip it. Otherwise this becomes an unplanned change in Task 9.

---

## Smaller points

- **Upload exclusions.** Spec step 3.3 leaves out "the group directory's parent". With `--out` outside the project, `runs/` (hundreds of MB of old statelogs) would be uploaded. Always leave out `eval.runsDir` (default `runs`) as well.
- **The run row's `flags.trials`.** With `--trial-number 3`, the inner run's row says `trials: 1` (`runSuite.ts:150-154`), but the batch has more. Check whether anything reads it (batch statistics, statelog). If something does, add `--trials` to the inner command as information.
- **`--grade` for a test whose agent timed out or errored.** Plan Task 3 tests "never started", but not "started and then failed". The second should be graded, as `eval grade` would grade it. Add the test.
- **Open decisions gate tasks.** Decision 2 (where the package lives) blocks Task 5. Decision 1 (cost and time leave the score) blocks Task 10. Decision 3 (fetch the repo from GitHub by hash) blocks Task 11. Phase 1 can start without them. Say this at the top of Phase 2, so an executing agent stops there instead of assuming.
- **`packInstalledAgency`.** Use `npm pack --pack-destination <destDir>`, or the tarball is written into the pnpm store folder.
- **The network lock checks only one direction.** `check the lock` proves `github.com` is blocked for `bench`, not that `openrouter.ai` is reachable. A lock that also blocks the model would fail fast and cheaply, so this is a nice-to-have.
- **`iptables` is installed on every run.** Installing it from apt in every container adds time to every test. A prebuilt image is a later optimization; note it in the README's "not supported yet" list.
- **Task 13's grep.** `run\.ts` and `cli\.ts` will also match unrelated names in docs. Expect to read the matches rather than expect "no result".
- **The spec says 0.45.3.** The checkout is now 0.45.4. The line references I checked still hold (`gradeRun.ts:337`, `:411-430`).

## What I checked and found correct

- Must-pass graders run first, one at a time, and the rest run together (`gradeRun.ts:411-430`).
- The batch id is `<group basename>-<nanoid(8)>` (`runSuite.ts:163`), so the wrapper minting one in the same form keeps the batch URL behavior (`upload.ts:296-312`).
- With trials, runs are laid out as `<group>/<testId>/<trial>/`, and a single trial is flat (`runSuite.ts:330-333`). The wrapper's layout matches.
- `summarizeEvalRun` and `breakdown` are exported from `agency-lang/eval` (`lib/eval/public.ts:33,42`).
- `eval.limits.maxBatchCostUsd` exists (`lib/config/config.ts:630`).
- The command agent gets its statelog path through the environment, which `runuser -u` (without `-l`) keeps.
- `agency-lang`'s `package.json` has no `prepack` script, so packing the installed package runs no build.
