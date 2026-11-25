# Re-review: running eval tests in a container (draft 3)

**Reviewed:** `docs/superpowers/specs/2026-11-25-eval-test-runners-design.md` (draft 3) and `docs/superpowers/plans/2026-11-25-eval-test-runners.md`
**Date:** 2026-11-25
**Checked against:** `~/agency-lang` at `34a06d361` (0.45.4).
**First review:** `2026-11-25-eval-test-runners-review.md`. It is kept as it is, because the spec links to it.

## Verdict

Every finding from the first review is addressed, and addressed well. The fixes are specific, each has a test, and the spec now records them as decisions. The plan is ready to execute once the first finding below is folded into Task 1. The rest are small.

| First-review finding | Where it is fixed | Status |
| --- | --- | --- |
| 1. `bench` cannot reach the workdir or write the statelog | spec 1a (`AGENCY_EVAL_AGENT_DIR`), Part 2 step 3.3; plan Tasks 0, 1, 7, 9, 11, 12 | Fixed. `verify` now starts its agent as `bench`, so this is proven before any paid run. |
| 2. The tail of the output | spec 1c; Task 1 | Fixed, with a test that uses long output. |
| 3. Timeout leaves processes running | spec 1c; Tasks 1 and 2 | Fixed, but the fix creates a new problem (finding 1 below). |
| 4. Oracle mode from the shell | `--env`; Tasks 6, 11, 12 | Fixed, with a test that the config does not name it and a log check. |
| 5. Time budget, always bring the run back | `graceSec` 7200 plus the setup limit; Task 7 | Fixed. |
| 6. Ctrl-C | spec "Ctrl-C"; Tasks 5, 8, 9 | Fixed, by salvaging runs and moving signal handling out of `withSandbox`. |
| 7. Extract `runShell`, `process.env`, `timeoutSec` | Task 1 | Fixed. |
| 8. Hidden lock | Task 2, `needsWorkdirToItself` in `gradeRun` | Fixed. |
| 9. Spike gaps | Task 0 | Fixed. |
| 10. Workdir snapshot | `--no-workdir-snapshot` | Fixed. |
| Smaller points | Tasks 3, 4, 6, 7, 9, 11, 13 | All taken. |

---

## Should fix

### 1. Detached commands no longer get Ctrl-C unless the supervisor forwards it

**Where:** plan Task 1 step 3 ("spawn detached and signal the group as `spawnRunner.ts` does").

Detaching puts the command in its own process group. That is what lets a timeout kill the whole tree. It also takes the tree out of the terminal's foreground group, so Ctrl-C no longer reaches it. `spawnRunner.ts:75-83` says exactly this in its comment. For agents, the gap is closed by `childSupervisor.ts`: it forwards SIGINT, SIGTERM and SIGHUP to every live child, and on exit it reaps them all (see its header comment, lines 3-22).

The plan copies the detach and the group kill, but not the supervisor registration. Without it:

- **On the host,** Ctrl-C during `setup` or grading ends `eval run` or `eval grade`, and the `make` or `pnpm install` it started keeps running, orphaned. Before this change, Ctrl-C reached it. That is a regression.
- **In the container,** the wrapper's interrupt reaches `eval run`, but not `setup` or the grader that is running. `eval run` waits for them: up to 30 minutes for setup, 45 for `builds`. The wrapper gives up after 60 seconds and salvages what is there. During setup, that is nothing.

**Fix:** register each `runShell` child with the same supervisor `spawnRunner` uses, so it is signalled with the group and reaped on exit. That reuses the existing code instead of half of it. Add a test to `shellCommand.test.ts`: a fake process sends SIGINT while `(sleep 2; touch late) & sleep 5` runs, and `late` never appears.

### 2. After an interrupt, `--grade` should not start grading

**Where:** plan Task 3 step 4; spec "Ctrl-C".

When the wrapper interrupts a run whose agent is working, `runSuite` folds the test into a run directory, as intended. Then, under `--grade`, `executeTest` goes on to grade it. That starts the `builds` grader, which takes up to 45 minutes.

The wrapper packs at 60 seconds. At that moment the grades are either not written yet or being written. Either way, the run comes back half-done at best, and the container keeps compiling until it is deleted.

**Fix:**

- Once `runSuite` has seen an interrupt, skip in-place grading. The run comes back ungraded, and the summary says "interrupted, not graded".
- Add one test in Task 3: `gradeInPlace` with an interrupt during the agent produces a run directory with no score rows.

Related: check whether score rows are written as each grader finishes or all at the end. Task 7's message for the wrapper's time limit, "grades may be missing", should then say which of the two it means: "some grades missing" or "not graded".

---

## Small points

- **The spike's hand-over races the agent.** Task 0 step 1.4 has a second shell run `chown -R bench` on the workdir "as soon as `.staging/spike/` appears". With a built monorepo that `chown` takes seconds, and the do-nothing agent may already have started, so the result can be flaky in either direction. The agent command runs as root before `runuser`, so the spike can do the hand-over there, in the same order `setup` will:

  ```
  --agent-cmd "sh -c 'chown -R bench . ../agent && exec runuser -u bench -- agency run /opt/noop.agency -- \"$1\"' sh {input}"
  ```

  `../agent` exists by then, because `execute()` creates it before the runner starts (`runAgent.ts:195`).

- **Where `agency run` writes its compiled file.** `verify` starts `agency run /opt/agency-plans/noop.agency` as `bench`. If `agency run` writes its compiled `.js` beside the source, `bench` cannot write in a root-owned `/opt/agency-plans`. I could not confirm where the output goes in the time I spent. The spike's step 4 will show it. If it fails, `setup` should make `/opt/agency-plans` owned by `bench`, or compile the file as root first. Name that fallback in Task 11 step 6 so the executor does not have to invent one.

- **`runLongCommand`'s process group.** Its interrupt goes to "the command's process group". That only works if the background command was started in a group of its own (for example with `setsid`) and its group id was recorded. Say so in the Task 5 interface, and check it in the `FakeSandbox` test. The `kill` must name `-<pgid>`.

- **What `eval grade` says about a run with no snapshot.** Spec 1e says `eval grade` "cannot grade such a run later, and says so". Task 4 asserts something weaker: each grader that reads the workdir fails with "no working directory was captured", and LLM judges still grade. Either relax the spec's wording to match, or record `workdirSnapshot: false` in the run and have `eval grade` print one line saying so. The second is friendlier, but it is optional.

- **Exit code after Ctrl-C.** Task 8 returns 130 even when every in-flight run came back. That is the usual convention and fine. Put it in the README's Ctrl-C paragraph so a script that checks the exit code knows what it means.

## What I checked this time

- The detach comment and the group kill in `spawnRunner.ts:70-95`, and the supervisor's forwarding and reaping in `childSupervisor.ts:1-60` (finding 1).
- That `execute()` creates `agent/` with `recursive: true` (`runAgent.ts:195`), so creating it earlier, before setup, is harmless, as Task 1 says.
- That a run directory with no `workdir/` gives command graders "no working directory was captured" (`gradeRun.ts:337-341` with `build.ts:189-191`), which Task 4's assertion relies on.
