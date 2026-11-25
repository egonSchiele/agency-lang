# Running Eval Tests in a Container: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run and grade each eval test in one Daytona container through a wrapper command, with no container knowledge in agency-lang, and rebuild the `agency-plans` suite on it with no custom runner or grader code.

**Architecture:** A wrapper command, `agency-eval-daytona`, starts a container per test, copies the project in, runs the ordinary `agency eval run --grade` there, and brings the run directory back. agency-lang gains six small changes that mention no containers: a per-test `setup` command, `--grade`, three fixes to `command` graders (they take turns, show the end of their output, and kill what they started), `--no-workdir-snapshot`, `--batch` and `--trial-number`, and `eval ls --json`.

**Tech Stack:** TypeScript, vitest, commander and zod (as agency-lang uses them), `@daytona/sdk` 0.x (wrapper package only), Node 22 type stripping for `.mts` files in this repo.

**Spec:** `docs/superpowers/specs/2026-11-25-eval-test-runners-design.md` (draft 3)

**Reviews applied:** `docs/superpowers/plans/2026-11-25-eval-test-runners-review.md` and `…-review-2.md`. Every decision in the spec is made; no task waits on the user except the steps marked as costing model money.

**Three codebases.** Paths are prefixed:

- `AL/` = `~/agency-lang/packages/agency-lang/`
- `PKG/` = `~/agency-lang/packages/eval-daytona/` (new)
- `AE/` = `~/agency-evals/`

**Four phases, three pull requests.** Phase 0 merges nothing. Phase 1 is one PR to agency-lang. Phase 2 is one PR to agency-lang that adds the package. Phase 3 is one PR to agency-evals and needs an agency-lang build that holds phases 1 and 2.

## Global Constraints

- `agency-lang`'s `package.json` gains no dependency, and no file under `AL/` mentions Daytona, containers or the wrapper. The Daytona SDK appears only in `PKG/package.json`, pinned to `@daytona/sdk@0` (2.x is a different API).
- Three deliberate behavior changes in agency-lang, all to `command` graders: those of one run execute one at a time; their feedback is the end of the output, not the start; and a timeout kills every process the command started. Each gets a changelog line. Everything else behaves as before unless a new flag or field is used, and every existing test in `AL/lib/eval` and `AL/lib/cli/eval` passes unchanged, except tests that asserted the three old behaviors.
- Reuse before adding. `setup` runs through the `command` grader's existing `runShell`. Killing a process group reuses what `AL/lib/eval/run/spawnRunner.ts:83,90` does for agents; do not write a second copy. Results use the existing `{ ok: true } | { ok: false; errorMessage: string }` shape that `EvalInputRunner` returns; do not declare it again. Options are validated with zod. Grades are read with the readers `agency-lang/eval` already exports (`summarizeEvalRun`, `breakdown`).
- The wrapper never leaves a container behind: it is deleted on success, on failure and after a signal, unless `--keep` is given.
- A run directory that exists in a container is always brought back before the container is deleted: after a non-zero exit, after the wrapper's time limit, and after the first Ctrl-C.
- No shell scripts are added to `AE/`. Suite programs are `.mts` files that use only Node's own modules.
- Documentation is in proportion: a paragraph in an existing page for each agency-lang change; one README for the package.
- Do not run `make` or `pnpm install` in `~/agency-lang` on its `main` checkout. Work in a git worktree of agency-lang.
- Ask the user before any step that spends model money. Such steps are marked **(costs model money)**.
- Test first: each behavior change starts with a test that is run and seen to fail.

## Review Focus

Conditions the spec implies that are easy to miss. Each has a test in the task named.

1. **Setup fails or runs out of time.** The agent must not start, the test is an error result that says `setup failed`, and the suite goes on to the next test. (Task 1)
2. **A timed-out command that left processes behind.** The next command must not start while they still run in the same workdir. (Tasks 1 and 2)
3. **An agent that runs as another user.** It must be able to reach its workdir and write its statelog, with the wrapper's real permissions. Checked with no model cost. (Tasks 0, 7 and 12)
4. **A paid run that hits the wrapper's time limit, or Ctrl-C.** Its run directory must still come back. (Tasks 7 and 8)
5. **Oracle mode leaking into a real run.** The switch must not be readable from the host shell or a config file. (Tasks 6 and 12)

---

## Phase 0: Spike (nothing is merged)

### Task 0: Run the framework by hand in a container

**Done on 2026-11-25. The design holds; results are in the spec under "Spike results".** The steps below are kept as the record of what was run.

The design rests on `agency eval run` working inside a Daytona container with the agent as an unprivileged user. Prove it, with the permissions the wrapper will really set, before anything else is written.

**Files:**
- Create (scratch, not committed): `AE/runs/spike/spike.ts`

**Interfaces:**
- Consumes: `AE/lib/sandbox/` as it is on `main` (`createDaytonaSandbox`, `withSandbox`, `mustExec`, `installAgency`).
- Produces: a written answer to each question below, appended to the spec under a new heading "Spike results". The plan is revised if any answer breaks the design.

- [ ] **Step 1: Write `spike.ts`.** It creates one sandbox (`node:22-bookworm`) and installs `agency` from a tarball (ask the user which build to pack; `cli.ts pack` runs `make` in their checkout). Then, printing each command's output:
  1. **Fetch by hash, all fourteen commits.** For the start and solution commit of each of the seven tests, in an empty folder with no credentials: `git init && git fetch --depth 1 https://github.com/egonSchiele/agency-lang <sha> && git checkout FETCH_HEAD`. A solution commit from a squash-merged PR may be reachable only through a PR ref; record which, if any, fail.
  2. **A spike suite whose test seeds a built repo.** Build `unit-literals`' starting commit in a scratch folder, and make that folder the spike test's `files/`. This measures the seeding copy and gives the workdir a built tree. Its `test.json` has no `setup` (that feature does not exist yet).
  3. **The wrapper's permissions.** Upload the spike suite to `/eval/project`, `chmod 700 /eval/project`, leave `/eval` and `/eval/out` open, and create user `bench`.
  4. **The harness, with the agent as `bench`.** Put `noop.agency` (`node main(prompt: string) { return "noop" }`) at `/opt/noop.agency`, and run `agency eval run --agent-cmd "<command>" --suite /eval/project/suite --test spike --out /eval/out` twice. First with `runuser -u bench -- agency run /opt/noop.agency -- {input}`, which should show the failure. Then with the hand-over done inside the agent command, which starts as root and runs after `agent/` exists (`runAgent.ts:195`), so nothing races:

     ```
     sh -c 'chown -R bench . ../agent && exec runuser -u bench -- agency run /opt/noop.agency -- "$1"' sh {input}
     ```

     The second run shows whether handing over those two folders is enough. Note where `agency run` writes its compiled file: if it is beside the source, `bench` cannot write in a root-owned `/opt`, and the run fails for that reason instead.
  5. **Root in a tree `bench` owns, in the real order.** In the workdir after the hand-over: the test's build command as root, then two check commands. If anything calls `git`, note whether "dubious ownership" stops it and whether `git config --system --add safe.directory '*'` fixes it.
  6. `ls -la` of the finished run directory, its `annotations.jsonl`, and the size of its `workdir/` and how long the copy took.

- [ ] **Step 2: Run it** with `pnpm exec tsx runs/spike/spike.ts`. No model is called.

- [ ] **Step 3: Answer in the spec:**
  - Which of the fourteen commits can be fetched by hash with no credentials?
  - Does `agency eval run` complete inside the container and write a valid run directory?
  - Does `agency run <file> -- <input>` write the statelog the harness points it at, and where does it write its compiled file?
  - Is handing `bench` the workdir and the `agent/` folder enough for it to run and write its statelog?
  - Can root build and run checks in a tree `bench` owns, and what does `git` need?
  - How long did seeding the built repo take, and how long and how big was the workdir copy?

- [ ] **Step 4: Stop and report to the user** if any answer breaks the design. Otherwise delete `runs/spike/` and continue.

---

## Phase 1: Changes to agency-lang (one PR)

### Task 1: `setup` in `test.json`, on a shell runner that keeps the tail and kills the group

**Files:**
- Create: `AL/lib/eval/shellCommand.ts`, `AL/lib/eval/shellCommand.test.ts`
- Modify: `AL/lib/eval/gradersJson/build.ts` (use the extracted function), `AL/lib/eval/runTypes.ts` (the `Test` type), `AL/lib/eval/loadInputs.ts`, `AL/lib/eval/run/runAgent.ts`, `AL/lib/eval/run/runSuite.ts`
- Test: `AL/lib/eval/gradersJson/build.test.ts`, `AL/lib/eval/loadInputs.test.ts`, `AL/lib/eval/run/runAgent.test.ts`
- Docs: one paragraph in the page that documents `test.json`; two changelog lines under behavior changes

**Interfaces:**
- Consumes: `runShell(command, { cwd, env, timeoutMs })` at `build.ts:213`, and `cut()` at `build.ts:246`. `runCommand` stays in `build.ts` as the grader's thin wrapper: it returns a `Grade` and keeps its "no working directory was captured" check. The process-group spawn and kill in `AL/lib/eval/run/spawnRunner.ts:70-95`, **and the supervisor in `AL/lib/eval/run/childSupervisor.ts`** that `spawnRunner` registers each child with. Read both header comments first. A detached command leaves the terminal's foreground group, so Ctrl-C no longer reaches it by itself; the supervisor is what forwards SIGINT, SIGTERM and SIGHUP to every live child and reaps them on exit. Detaching without registering is half of the mechanism and a regression: today Ctrl-C does reach a grader's `make`.
- Produces:

```ts
// shellCommand.ts
export const OUTPUT_TAIL_CHARS = 2000;
/** Runs `sh -c command` in its own process group. `env` is the whole
 *  environment: the caller merges process.env, as build.ts does today. */
export function runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }):
  Promise<{ status: number | null; output: string; timedOut: boolean }>;
/** The last OUTPUT_TAIL_CHARS characters, with a leading "…" when cut. */
export function outputTail(text: string): string;
```

  - `Test.setup?: string`
  - `Test.dir?: string`: the folder holding `test.json`. Before adding it, search `loadInputs.ts` and `runTypes.ts` for a field that already carries this path and use that one if it exists.
  - `SETUP_TIMEOUT_SEC = 1800`
  - `RunAgentOptions.setup?: { command: string; testDir: string | undefined; timeoutSec: number }`
  - Environment given to setup: `process.env` plus `AGENCY_EVAL_TEST_DIR` (when the test is a folder) and `AGENCY_EVAL_AGENT_DIR`.

- [ ] **Step 1: Extract.** Move `runShell` to `shellCommand.ts` unchanged, with `build.ts` importing it. Run `pnpm exec vitest run lib/eval/gradersJson`. Expected: PASS, unchanged. Commit `Extract the command grader's shell runner`.
- [ ] **Step 2: Write failing tests in `shellCommand.test.ts`:**

```ts
it("kills every process the command started when it runs out of time", async () => {
  const result = await runShell("(sleep 2; touch late) & sleep 5", { cwd, env: process.env, timeoutMs: 500 });
  expect(result.timedOut).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(fs.existsSync(path.join(cwd, "late"))).toBe(false);
});
it("stops everything the command started when the process is interrupted", async () => {
  // the supervisor's signal seam (as childSupervisor.test.ts drives it) delivers SIGINT
  // 300ms into `(sleep 2; touch late) & sleep 5`
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(fs.existsSync(path.join(cwd, "late"))).toBe(false);
});
it("keeps the end of long output", () => {
  const text = `${"progress line\n".repeat(500)}error: the real problem`;
  expect(outputTail(text).endsWith("error: the real problem")).toBe(true);
  expect(outputTail(text).length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS + 1);
  expect(outputTail("short")).toBe("short");
});
it("passes the environment it is given, PATH included", async () => {
  const result = await runShell('echo "$PATH|$EXTRA"', { cwd, env: { ...process.env, EXTRA: "x" }, timeoutMs: 5000 });
  expect(result.output.trim()).toBe(`${process.env.PATH}|x`);
});
```

  and in `build.test.ts`: a command grader whose command prints 500 lines and then `error: the real problem` and exits 1 has feedback that ends with `error: the real problem`.
- [ ] **Step 3: Run.** Expected: the first three and the `build.test.ts` test FAIL. **Implement:** spawn detached, register the child with the supervisor, and signal the group, all through the code `spawnRunner.ts` already uses (extract a shared helper if it is not already one; do not copy it); replace `cut` with `outputTail` in `runCommand`. **Run** `pnpm exec vitest run lib/eval`. Expected: PASS. Fix any existing test that asserted the start of long output. Commit `Command graders show the end of their output and kill what they started`.
- [ ] **Step 4: Write failing tests in `loadInputs.test.ts`:** a test folder whose `test.json` has `"setup": "true"` loads with `setup: "true"` and the folder path; `"setup": 5` is refused with a message that names the field. **Run, implement** beside the `timeoutSec` checks, **run.**
- [ ] **Step 5: Write failing tests in `runAgent.test.ts`**, using the existing fake `runner` seam:

```ts
it("runs setup after the files are seeded and before the agent, with both folders in its environment", async () => {
  // seedFiles has seeded.txt; setup is:
  //   test -f seeded.txt && test -d "$AGENCY_EVAL_AGENT_DIR" && echo "$AGENCY_EVAL_TEST_DIR" > setup-ran
  // the fake runner reads setup-ran when it is called
  expect(seenByAgent).toBe("/suite/a-test\n");
});
it("names the folder the statelog is then written into", async () => {
  // setup writes "$AGENCY_EVAL_AGENT_DIR" to a file; it equals path.dirname(job.statelogPath)
});
it("does not start the agent when setup exits non-zero, and reports the end of its output", async () => {
  // setup: 500 progress lines, then `echo broke >&2; exit 3`
  expect(run.status).toBe("error");
  expect(run.errorMessage).toMatch(/^setup failed \(exit 3\):\n/);
  expect(run.errorMessage.endsWith("broke")).toBe(true);
  expect(runnerCalls).toBe(0);
});
it("does not start the agent when setup runs out of time", async () => {
  // setup: { command: "sleep 30", testDir: undefined, timeoutSec: 1 }
  expect(run.errorMessage).toBe("setup failed: did not finish within 1s");
});
```

- [ ] **Step 6: Run.** Expected: FAIL. **Implement:** in `runAgent`, create `paths.agentDir` before setup (today `execute()` creates it, at line 195; creating it earlier is harmless since the call is `recursive`). After `seedWorkdir()` and before the job goes to the runner, call `runShell` when `options.setup` is set; on failure return the error shape an agent that failed to start returns. In `runSuite.ts`'s `executeTest`, pass `setup` from the test with `timeoutSec: SETUP_TIMEOUT_SEC`. **Run** `pnpm exec vitest run lib/eval`. Expected: PASS.
- [ ] **Step 7: Document** in one paragraph: the field, the two environment variables, the rule "if your agent runs as another user, give that user the workdir and `$AGENCY_EVAL_AGENT_DIR`", and that setup is arbitrary code from the suite.
- [ ] **Step 8: Commit** `Add a per-test setup command to eval tests`.

### Task 2: `command` graders of one run take turns

**Files:**
- Modify: `AL/lib/eval/grading/baseGrader.ts`, `AL/lib/eval/grading/gradeRun.ts` (the function at lines 405-431), `AL/lib/eval/gradersJson/build.ts`
- Test: `AL/lib/eval/grading/gradeRun.test.ts`
- Docs: two sentences in `AL/docs/dev/evals/graders-json.md`; a changelog line under behavior changes

**Interfaces:**
- Produces:
  - `BaseGrader.needsWorkdirToItself(): boolean`, default `false`. The command grader returns `true`. Check how `grader(fn, options)` in `functionGrader.ts` builds a grader, and pass the trait through its options rather than subclassing if that is how `mustPass` travels.
  - In `gradeRun.ts`, after the must-pass graders: graders that need the workdir to themselves run one after another, in file order, while the others run together as they do now. The rule is written there, in the function that decides grading order, with a comment that says why. No module-level lock.

- [ ] **Step 1: Write failing tests in `gradeRun.test.ts`:**

```ts
it("never runs two graders that need the workdir at the same time", async () => {
  const command = "test ! -e busy && touch busy && sleep 0.2 && rm busy";
  // graders.json: three command graders a, b, c with this command
  expect(grades.map(passed)).toEqual([true, true, true]);
});
it("runs them in file order", async () => {
  // each appends its name to order.txt
  expect(read("order.txt")).toBe("a\nb\nc\n");
});
it("gives the next one its turn after one fails or times out, with nothing of the old one left running", async () => {
  // fails: `exit 1`
  // slow:  `(sleep 2; touch late) & sleep 5`, timeoutSec 1
  // after: `sleep 2.5; test ! -e late`
  expect(grades.map(passed)).toEqual([false, false, true]);
});
it("starts a grader's time limit when its turn starts", async () => {
  // a 1.5s command, then a 1s command with timeoutSec 2: the second passes
});
it("still runs graders that do not need the workdir together", async () => {
  // two function graders that each wait 300ms finish in well under 600ms
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run lib/eval/grading/gradeRun.test.ts`. Expected: the first test FAILS (a command finds `busy`).
- [ ] **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run lib/eval`. Expected: PASS.
- [ ] **Step 5: Document** and add the changelog line. **Commit** `Run a run's command graders one at a time`.

### Task 3: `agency eval run --grade`

**Files:**
- Modify: `AL/scripts/agency.ts` (the option), `AL/lib/cli/eval/run.ts`, `AL/lib/eval/run/runSuite.ts`, `AL/lib/eval/grading/gradeRun.ts`
- Test: `AL/lib/eval/grading/gradeRun.test.ts`, `AL/lib/eval/run/runSuite.test.ts`, `AL/lib/cli/eval/run.test.ts`
- Docs: a short section in `AL/docs/dev/evals/eval-grading.md`

**Interfaces:**
- Consumes: `gradeRun(runDir, ctx)` and `GradingContext` in `gradeRun.ts`; the path `evalGrade` in `AL/lib/cli/eval/grade.ts` uses to write score rows and print its summary. Read `grade.ts` first and call that path; do not write a second one.
- Produces:
  - `GradingContext.workdirOverride?: string`: graders receive this path as the run's workdir in place of `<runDir>/workdir`.
  - `RunSuiteOptions.gradeInPlace?: boolean`, `EvalRunCliOptions.grade?: boolean`
  - CLI: `--grade`, described as "Grade each test as soon as its agent finishes, in the workdir it worked in".

- [ ] **Step 1: Write a failing test in `gradeRun.test.ts`:** a run directory whose `workdir/marker` says `snapshot`, graded with `workdirOverride` pointing at a folder whose `marker` says `live`, and one command grader `grep -q live marker`. Expect a pass with the override and a fail without it.
- [ ] **Step 2: Run.** Expected: FAIL. **Implement** at `gradeRun.ts:337`, where the workdir path is chosen. **Run.** Expected: PASS.
- [ ] **Step 3: Write failing tests in `runSuite.test.ts`**, with the fake agent runner writing `made-by-agent` into the workdir:

```ts
it("grades each run when gradeInPlace is set, and writes the grades to its run directory", async () => {
  // graders.json: [{ kind: "command", name: "made-it", command: "test -f made-by-agent" }]
  const result = await runSuite({ ...opts, gradeInPlace: true }, { runner: writesFile("made-by-agent") });
  expect(scoreRowsIn(result.results[0].runDir).map((row) => row.name)).toEqual(["made-it"]);
});
it("grades in the workdir the agent used, not the copy in the run directory", async () => {
  // the grader writes `pwd` to a file under AGENCY_GRADER_FILES; it is not <runDir>/workdir
});
it("does not grade a test whose agent never started", async () => {});
it("grades a test whose agent started and then failed or ran out of time, as eval grade would", async () => {});
it("does not grade once the suite has been interrupted", async () => {
  // SIGINT arrives while the fake agent runs; the test is folded in as today
  expect(fs.existsSync(path.join(runDir, "statelog.jsonl"))).toBe(true);
  expect(scoreRowsIn(runDir)).toEqual([]);
});
it("keeps the run and goes on to the next test when grading throws", async () => {});
it("does not grade without gradeInPlace", async () => {
  expect(scoreRowsIn(result.results[0].runDir)).toEqual([]);
});
```

- [ ] **Step 4: Run.** Expected: FAIL. **Implement** in `executeTest`: after `fs.renameSync(assembled, runDir)` and before the `finally` removes staging, when `gradeInPlace` is set, grade `runDir` with its stored graders and `workdirOverride: run.workdir`, writing grades as `eval grade` does. Skip grading when the suite's `interrupted` flag is set: a `builds` grader can take 45 minutes, and whoever interrupted is waiting. **Run** `pnpm exec vitest run lib/eval lib/cli/eval`. Expected: PASS.
- [ ] **Step 4b: Find out when score rows are written:** as each grader finishes, or all at the end of a run's grading. Write the answer in the PR description. Task 7's time-limit message depends on it.
- [ ] **Step 5: Add the CLI option**, a test in `run.test.ts` that `grade: true` reaches `runSuite` as `gradeInPlace: true`, and print `eval grade`'s summary after the suite.
- [ ] **Step 6: Document. Commit** `Add eval run --grade: grade each run in its live workdir`.

### Task 4: `--batch`, `--trial-number`, `--no-workdir-snapshot`, and `eval ls --json`

**Files:**
- Modify: `AL/scripts/agency.ts`, `AL/lib/cli/eval/run.ts`, `AL/lib/eval/run/runSuite.ts`, `AL/lib/cli/eval/ls.ts`
- Test: `AL/lib/eval/run/runSuite.test.ts`, `AL/lib/cli/eval/run.test.ts`, `AL/lib/cli/eval/ls.test.ts`
- Docs: the CLI reference lines for the three flags

**Interfaces:**
- Produces:
  - `RunSuiteOptions.batch?: string`, `RunSuiteOptions.trialNumber?: number`, `RunSuiteOptions.workdirSnapshot?: boolean` (default `true`)
  - CLI on `eval run`: `--batch <id>` ("Record these runs under this batch id instead of a new one"), `--trial-number <n>` ("Record this run as trial n; runs each test once"), and `--no-workdir-snapshot` ("Do not copy the workdir into the run directory; such a run cannot be graded later")
  - CLI on `eval ls`: `--json`, printing `[{ "id": string, "timeoutSec"?: number }]` and nothing else on stdout

- [ ] **Step 1: Write failing tests in `runSuite.test.ts`:**
  - with `batch: "nightly-abc"`, every run row's `batch` is `nightly-abc`
  - an empty `batch` throws
  - with `trialNumber: 3`, the run is written flat at `<out>/<testId>/` and its row's `trial` is 3
  - `trialNumber` with `trials: 2` throws `--trial-number runs one trial; it cannot be combined with --trials`
  - `trialNumber: 0` and `trialNumber: 1.5` throw
  - with `workdirSnapshot: false`, the run directory has no `workdir/` and no `workdir.json`; with `gradeInPlace` as well, it is still graded, in the live workdir
  - `agency eval grade` on a run made with `workdirSnapshot: false` fails that run's workdir-reading graders with the framework's existing "no working directory was captured" feedback (this is what happens today for a run with no workdir: `gradeRun.ts:337-341` with `build.ts:189-191`). LLM judges still grade it.
  - `agency eval grade` prints one line for a run directory that has no `workdir/`: `<run>: no workdir was stored with this run; graders that read it will fail`. It detects this from the missing folder; no new field is recorded.
- [ ] **Step 2: Run.** Expected: FAIL. **Implement** where `batch` is minted, where `trial` is passed to `foldIntoRunDirectory`, and where `foldIntoRunDirectory` passes `workdir` to `recordCompletedRun`. **Run.** Expected: PASS.
- [ ] **Step 2b: Check `flags.trials`.** The run row records `trials` from the inner run (`runSuite.ts:150-154`), which will say 1 for a batch that has more. Search agency-lang and `~/statelog` for readers of that field. If anything reads it, let `--trial-number` runs record the batch's real count through a `--trials-total <n>` value on the inner command and add it to Task 6's `innerArgv`; if nothing reads it, write that down in the PR and leave it.
- [ ] **Step 3: Write failing tests in `ls.test.ts`:** with `--json`, the output parses as JSON and lists exactly the tests the same `--test` and `--tags` select without it, each with its `timeoutSec` when it has one.
- [ ] **Step 4: Run, implement, run.**
- [ ] **Step 5: Commit** `Add --batch, --trial-number and --no-workdir-snapshot to eval run, and --json to eval ls`.
- [ ] **Step 6: Run** `pnpm run test:run` in `AL/` and report the result. **Open the agency-lang PR** from a worktree branch.

---

## Phase 2: The wrapper package (one PR to agency-lang)

The package lives at `packages/eval-daytona` in the agency-lang monorepo (decided).

### Task 5: Scaffold the package and move the sandbox core

**Files:**
- Create: `PKG/package.json`, `PKG/tsconfig.json`, `PKG/makefile`, `PKG/vitest.config.ts`, and under `PKG/src/`: `types.ts`, `shell.ts`, `daytona.ts`, `withSandbox.ts`, `fakeSandbox.ts`, `tar.ts`, `longCommand.ts`, each with its `.test.ts`
- Modify: `~/agency-lang/docs/dev/creating-packages.md` (a short section: a tool package has a `bin` and no `index.agency`)
- Read first: `~/agency-lang/docs/dev/creating-packages.md` and `packages/web-fetch/`.

**Interfaces:**
- Consumes: from `AE/lib/sandbox/` on `main`: `types.ts`, `shell.ts`, `daytona.ts`, `withSandbox.ts`, `fakeSandbox.ts` and their tests, copied as they are. `tar.ts` takes `tarDirectory` from `repo.ts`. `longCommand.ts` is `runAgent.ts` cut down to its general part.
- Produces:

```ts
// tar.ts
export function tarDirectory(dir: string, exclude?: string[]): Buffer;
// longCommand.ts
export async function runLongCommand(sandbox: Sandbox, args: {
  argv: string[]; cwd: string; env: Record<string, string>;
  maxSeconds: number;
  onOutput?(chunk: string): void;      // what the command printed since the last poll
  /** The command is started with `setsid`, so it leads a process group of its
   *  own, and that group's id is written to a file beside the exit-code file.
   *  When aborted: `kill -INT -<pgid>`, keep polling for up to
   *  interruptGraceSeconds (default 60), then return what is known. */
  signal?: AbortSignal; interruptGraceSeconds?: number;
  pollSeconds?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<{ exitCode: number; seconds: number; timedOut: boolean; interrupted: boolean }>;
// withSandbox.ts — changed from the copy in AE: it no longer installs signal handlers.
export function withSandbox<T>(create: () => Promise<Sandbox>, use: (sandbox: Sandbox) => Promise<T>,
  options?: { keep?: boolean; log?: (line: string) => void }): Promise<T>;
/** Deletes every sandbox that is live or being created. For the command's signal handler. */
export function deleteAllSandboxes(log: (line: string) => void): Promise<void>;
```

- `package.json`: name `@agency-lang/eval-daytona`, `"type": "module"`, `"bin": { "agency-eval-daytona": "./dist/src/cli.js" }`, dependencies `@daytona/sdk` `^0.233.0`, `commander`, `zod` and `nanoid` at the versions agency-lang uses, peer dependency `agency-lang`.

- [ ] **Step 1: Copy the five files and their tests.** Run `pnpm exec vitest run` in `PKG/`. Expected: PASS.
- [ ] **Step 2: Write failing tests for `tarDirectory`'s `exclude`:** a tree with `node_modules/x`, `.git/y` and `src/z`, excluding `["node_modules", ".git"]`, unpacks to `src/z` only. **Run, implement, run.**
- [ ] **Step 3: Write failing tests for `runLongCommand`** against `FakeSandbox`, carried over from `AE/lib/sandbox/runAgent.test.ts` where they apply: the environment goes into a root-only file and never onto a command line; the exit code is read from a file; five failed polls in a row rethrow; past `maxSeconds` plus 300 seconds the result is exit code 124; and new: `onOutput` receives only the new part of the output on each poll; the background line starts the command with `setsid` and records its group id; when `signal` aborts, exactly one command matching `kill -INT -$(cat <pgid file>)` (a negative id, so the whole group) is run, polling goes on, and the result has `interrupted: true`; if the command has not ended after `interruptGraceSeconds`, it returns anyway. **Run, implement, run.**
- [ ] **Step 3b: Change `withSandbox`** as the interface says, with its tests: remove the signal handlers and their tests from the copied file, and add tests that `deleteAllSandboxes` deletes live sandboxes and ones still being created. **Run.**
- [ ] **Step 4: Commit** `Add the eval-daytona package with the sandbox core`.

### Task 6: Options and the plan of jobs

Pure code, no sandbox.

**Files:**
- Create: `PKG/src/options.ts`, `PKG/src/options.test.ts`, `PKG/src/jobs.ts`, `PKG/src/jobs.test.ts`

**Interfaces:**
- Produces:

```ts
// options.ts
export const OPTIONS_FILE = "eval-daytona.json";
export type WrapperOptions = {
  image: string; cpu: number; memory: number; disk: number;
  env: string[];
  agency: "same" | { tarball: string };
  graceSec: number;            // default 7200
};
/** Defaults for a missing file; a zod error naming the key for a bad one. */
export function readOptions(projectDir: string): WrapperOptions;
/** The environment for the containers: the named host variables that are set,
 *  then the --env pairs on top. Also the names that were not set. */
export function containerEnv(args: { names: string[]; pairs: string[]; hostEnv: Record<string, string | undefined> }):
  { values: Record<string, string>; missing: string[] };

// jobs.ts
export type CliArgs = {
  agent?: string; agentCmd?: string; suite: string;
  test: string[]; tags: string[]; out?: string; parallel: number; trials: number;
  env: string[];               // --env NAME=VALUE, repeatable
  keep: boolean;
};
export type Job = {
  testId: string; trial: number;
  label: string;                 // "unit-literals" or "unit-literals-2" with trials
  hostRunDir: string;            // <group>/<testId> or <group>/<testId>/<trial>
  logFile: string;               // <group>/.logs/<label>.log
  innerArgv: string[];
  maxSeconds: number;            // (test timeoutSec ?? DEFAULT_TEST_SECONDS) + SETUP_SECONDS + graceSec
};
export const REMOTE_PROJECT = "/eval/project";
export const REMOTE_OUT = "/eval/out";
export const DEFAULT_TEST_SECONDS = 3600;
export const SETUP_SECONDS = 1800;      // agency-lang's fixed setup limit
/** Why these arguments cannot be wrapped, or undefined. */
export function argsProblem(args: CliArgs, projectDir: string): string | undefined;
/** Folders left out of the upload, relative to projectDir. */
export function uploadExclusions(args: { projectDir: string; groupDir: string; runsDir: string }): string[];
export function planJobs(args: {
  cli: CliArgs; tests: { id: string; timeoutSec?: number }[];
  projectDir: string; groupDir: string; batch: string; graceSec: number;
}): Job[];
```

- [ ] **Step 1: Write failing tests in `options.test.ts`:** no file gives the defaults in the spec's table; `{ "image": "x", "env": ["K"] }` overrides those two; `{ "imagee": "x" }` is refused, naming `imagee`. For `containerEnv`: `names: ["A", "B"]` with host `{ A: "1" }` gives `values: { A: "1" }, missing: ["B"]`; `pairs: ["A=2", "C=x=y"]` gives `A: "2"` (the pair wins) and `C: "x=y"`; a pair with no `=` or an empty name throws, naming it; **a name in `pairs` is never looked up in `hostEnv`.**
- [ ] **Step 2: Run, implement with zod (`.strict()`), run.**
- [ ] **Step 3: Write failing tests in `jobs.test.ts`:**

```ts
it("builds the inner command for a command agent", () => {
  expect(job.innerArgv).toEqual([
    "agency", "eval", "run", "--agent-cmd", "agency agent -p -- {input}",
    "--suite", "agency-plans", "--test", "unit-literals",
    "--batch", "nightly-ab12cd34", "--trial-number", "1",
    "--grade", "--no-workdir-snapshot", "--out", "/eval/out",
  ]);
});
it("builds it for a file agent, with the path as given", () => {});
it("makes one job per test and trial, in trial-major order", () => {
  expect(jobs.map((job) => job.label)).toEqual(["a-1", "b-1", "a-2", "b-2"]);
  expect(jobs[2].hostRunDir).toBe("/group/a/2");
});
it("writes a single trial flat", () => {
  expect(jobs[0]).toMatchObject({ label: "a", hostRunDir: "/group/a" });
});
it("allows each job its test's time limit, the setup limit, and the grace", () => {
  // timeoutSec 7200, graceSec 7200 → 7200 + 1800 + 7200
});
it("leaves out node_modules, .git, the runs directory, and a group directory that is elsewhere in the project", () => {
  expect(uploadExclusions({ projectDir: "/p", groupDir: "/p/out/x", runsDir: "runs" }))
    .toEqual(["node_modules", ".git", "runs", "out/x"]);
  expect(uploadExclusions({ projectDir: "/p", groupDir: "/elsewhere/x", runsDir: "runs" }))
    .toEqual(["node_modules", ".git", "runs"]);
});
```

  and for `argsProblem`: a message when neither or both of `agent` and `agentCmd` are given; when `--agent-cmd` has no `{input}`; when the suite is not a directory; when it is outside `projectDir`; when the agent path is absolute or outside `projectDir`; `undefined` otherwise. And `planJobs` throws for a test id that holds `*`, `?`, `[` or `{`.
- [ ] **Step 4: Run, implement, run.**
- [ ] **Step 5: Commit** `Add the wrapper's options and job plan`.

### Task 7: Run one job in a container

**Files:**
- Create: `PKG/src/runJob.ts`, `PKG/src/runJob.test.ts`, `PKG/src/packAgency.ts`, `PKG/src/packAgency.test.ts`

**Interfaces:**
- Consumes: Task 5's `Sandbox`, `withSandbox`, `mustExec`, `tarDirectory`, `runLongCommand`; Task 6's `Job`, `WrapperOptions`, `REMOTE_PROJECT`, `REMOTE_OUT`.
- Produces:

```ts
// packAgency.ts
/** A tarball of the agency-lang package installed in the project. */
export function packInstalledAgency(projectDir: string, destDir: string): string;

// runJob.ts
/** Every flag the inner command passes. Checked against `agency eval run --help`. */
export const REQUIRED_FLAGS = ["--grade", "--no-workdir-snapshot", "--trial-number", "--batch"];
/** `cameBack` says whether a run directory is now at job.hostRunDir. */
export type JobResult = { cameBack: boolean; problem?: string };
export async function runJob(job: Job, args: {
  options: WrapperOptions; projectDir: string; exclude: string[];
  env: Record<string, string>; agencyTarball: string; keep: boolean;
  signal: AbortSignal;
  createSandbox(label: string): Promise<Sandbox>;
}): Promise<JobResult>;
```

- [ ] **Step 1: Write failing tests in `runJob.test.ts`** against `FakeSandbox`:

```ts
it("installs agency, uploads the project, and runs the inner command from it", async () => {
  expect(sandbox.commands[0]).toContain("npm install -g /tmp/agency-lang.tgz");
  expect(sandbox.background[0]).toContain("agency eval run");
});
it("makes only the project copy root-only, and leaves /eval and /eval/out open", async () => {
  const all = sandbox.commands.join("\n");
  expect(all).toContain("chmod 700 /eval/project");
  expect(all).toContain("chmod 755 /eval /eval/out");
  expect(all).not.toMatch(/chmod 700 \/eval(\s|$)/m);
});
it("stops with a clear message when the agency in the container lacks a flag the wrapper needs", async () => {
  // `agency eval run --help` in the fake prints no --grade
  expect(result).toEqual({ cameBack: false,
    problem: "the agency installed in the container is too old for agency-eval-daytona: eval run has no --grade" });
  expect(sandbox.background).toEqual([]);
});
it("leaves the excluded folders out of the upload", async () => {});
it("passes the environment through a root-only file, never on a command line", async () => {});
it("brings the run directory back and unpacks it at job.hostRunDir", async () => {
  expect(result).toEqual({ cameBack: true });
  expect(fs.existsSync(path.join(job.hostRunDir, "statelog.jsonl"))).toBe(true);
});
it("appends the inner command's output to job.logFile as it arrives", async () => {});
it("brings the run directory back when the inner command exits non-zero but wrote one", async () => {
  expect(result).toEqual({ cameBack: true, problem: "the inner eval run exited with code 1" });
});
it("brings the run directory back when the wrapper's time limit was hit", async () => {
  // word the second half from what Task 3 step 4b found: "some grades may be missing"
  // if rows are written as each grader finishes, "not graded" if they are written at the end
  expect(result).toEqual({ cameBack: true, problem: "stopped at the wrapper's time limit (16200s); some grades may be missing" });
});
it("brings the run directory back after an interrupt", async () => {
  expect(result).toEqual({ cameBack: true, problem: "interrupted, not graded" });
});
it("reports the end of the log when no run directory was written", async () => {
  expect(result).toEqual({ cameBack: false, problem: expect.stringMatching(/^no run directory came back \(exit 137\):\n/) });
});
it("deletes the sandbox on success and on failure, and keeps it when keep is set", async () => {});
```

- [ ] **Step 2: Run.** Expected: FAIL. **Implement** inside `withSandbox`, in the order the spec's Part 2 gives. After `runLongCommand` returns, for any reason, test whether `/eval/out/<testId>` exists and download it if so. **Run.** Expected: PASS.
- [ ] **Step 3: Write a failing test for `packInstalledAgency`:** given a project whose `node_modules/agency-lang` is a small fixture package, it returns a `.tgz` inside `destDir` whose `package/package.json` has the name `agency-lang`, and nothing is written into the package's own folder. **Implement** with `npm pack --pack-destination <destDir>` in the folder found through `createRequire(projectDir + "/package.json").resolve("agency-lang/package.json")`. **Run.**
- [ ] **Step 4: Commit** `Run one eval job in a Daytona container`.

### Task 8: The command

**Files:**
- Create: `PKG/src/pool.ts`, `PKG/src/pool.test.ts`, `PKG/src/summary.ts`, `PKG/src/summary.test.ts`, `PKG/src/signals.ts`, `PKG/src/signals.test.ts`, `PKG/src/cli.ts`, `PKG/src/main.ts`, `PKG/src/main.test.ts`

**Interfaces:**
- Consumes: Tasks 5 to 7; `summarizeEvalRun` and its `RunSummary` type from `agency-lang/eval` (read the type first; use its cost and score fields as they are named there).
- Produces:

```ts
// pool.ts
/** Runs jobs `parallel` at a time, in order. Stops starting jobs once shouldStop() is true. */
export async function runPool<T, R>(items: T[], parallel: number, run: (item: T) => Promise<R>,
  shouldStop: () => boolean): Promise<{ item: T; result: R | "not started" }[]>;
// summary.ts
export function summaryLines(rows: { label: string; result: JobResult | "not started"; summary?: RunSummary }[]): string[];
// signals.ts
/** First signal: onFirst() (stop starting jobs, abort the running ones so they
 *  salvage). Second signal, at least a second later: onSecond() (delete all
 *  sandboxes), then exit with the signal's code. Returns a function that
 *  removes the handlers. A repeat within a second is one signal delivered twice. */
export function onSignals(handlers: { onFirst(): void; onSecond(): Promise<void> },
  deps?: { process?: NodeJS.Process; now?: () => number }): () => void;
// main.ts
export async function main(cli: CliArgs, deps: {
  projectDir: string; env: Record<string, string | undefined>;
  listTests(cli: CliArgs): Promise<{ id: string; timeoutSec?: number }[]>;    // runs `agency eval ls --json`
  agencyConfig(): { runsDir: string; maxBatchCostUsd?: number };              // from agency.json
  runJob: typeof runJob; signal: AbortSignal; log(line: string): void;
}): Promise<number>;   // the exit code
```

- [ ] **Step 1: Write failing tests for `runPool`:** never more than `parallel` running at once; results in input order; once `shouldStop` is true, the remaining items are `"not started"` and the running ones finish.
- [ ] **Step 2: Run, implement, run.**
- [ ] **Step 3: Write failing tests for `onSignals`** with a fake process: the first SIGINT calls `onFirst` once and does not exit; a second SIGINT 100 ms later is ignored; a second one 2 seconds later calls `onSecond` and then exits with 130; SIGTERM and SIGHUP behave the same with 143 and 129. **Run, implement, run.**
- [ ] **Step 4: Write failing tests in `main.test.ts`** with fakes for every dep:

```ts
it("refuses arguments that cannot be wrapped before any container starts", async () => {});
it("says once which env names are not set, and goes on", async () => {
  expect(logged).toContain("not set, so not passed to the containers: STATELOG_API_KEY");
});
it("gives the containers --env pairs without reading the host for them", async () => {});
it("gives every job the same batch id, named after the group directory", async () => {});
it("returns 0 and prints one line per job and the upload command when every job came back clean", async () => {
  expect(logged.at(-1)).toBe("upload with: agency eval upload runs/x");
});
it("returns 1 when a job brought nothing back, and still runs the others", async () => {});
it("starts no more jobs once the returned runs' cost passes the batch cap", async () => {
  // cap 5; the first job's run cost 6; with -n 1, the second job is "not started"
});
it("after an abort, starts no more jobs, lets the running ones salvage, and still prints the summary", async () => {
  // the fake runJob resolves { cameBack: true, problem: "interrupted, not graded" } when its signal aborts
  expect(logged.join("\n")).toContain("a  interrupted, not graded");
  expect(exitCode).toBe(130);
});
it("refuses a group directory that already exists", async () => {});
```

- [ ] **Step 5: Run.** Expected: FAIL. **Implement** `main`, `summaryLines` (with its own small tests: a clean job shows score and cost; a job with a problem shows it, and its score and cost when it came back; a job not started says so), and `cli.ts` (commander, the arguments in the spec, `--env` repeatable). `cli.ts` owns the signals: it creates the `AbortController` whose signal goes to `main` and every `runJob`, and calls `onSignals({ onFirst: abort, onSecond: () => deleteAllSandboxes(log) })`. **Run.** Expected: PASS.
- [ ] **Step 6: Commit** `Add the agency-eval-daytona command`.

### Task 9: Prove it against real Daytona

**Files:**
- Create: `PKG/src/wrapper.integration.test.ts`, `PKG/vitest.integration.config.ts`, `PKG/tests/fixture-project/` (a `package.json` depending on the built `agency-lang`; a suite with two tests, each with `files/hello.txt`, `"setup": "echo ready > setup-ran"`, and a `graders.json` with `test -f setup-ran` and `test -f hello.txt`; and `noop.agency`: `node main(prompt: string) { return "noop" }`), `PKG/README.md`

- [ ] **Step 1: Write the integration test.** It runs the built command on the fixture project with the file agent, `-n 2` and `--trials 2`, and expects: exit code 0; four run directories at `<group>/<test>/<trial>/`, each with a statelog, a run row carrying the same batch id and its own trial number, two passing score rows, and no `workdir/`; a non-empty log per job; and no sandbox left with the wrapper's labels. A second case uses a fixture test whose `setup` is `sleep 300`, sends SIGINT to the command once it has logged that the inner run started, and expects: the summary is printed, the exit code is 130, and no sandbox is left. A third case runs the fixture's command agent as another user, `--agent-cmd "runuser -u bench -- agency run /opt/noop.agency -- {input}"`, with a `setup` that creates `bench`, copies `noop.agency` to `/opt`, and hands `bench` the workdir and `$AGENCY_EVAL_AGENT_DIR`; it expects a run directory whose statelog is not empty.
- [ ] **Step 2: Run** `pnpm run test:integration` in `PKG/` with `DAYTONA_API_KEY` set. No model is called. Expected: PASS. This is the first time phases 1 and 2 meet; fix what it finds. It is not part of the default test run or CI.
- [ ] **Step 3: Write `PKG/README.md`:** what it is, the command, `eval-daytona.json` with the options table, what a suite must do itself (`setup`, running the agent as another user), what Ctrl-C does (runs in flight come back ungraded, and the exit code is 130 even when all of them came back), and a "not supported yet" list: live cost, grading a run again later, and a prebuilt image (so tools like `iptables` are installed in every container).
- [ ] **Step 4: Commit** `Test the wrapper against real Daytona`. **Open the PR.**

---

## Phase 3: Rebuild `agency-plans` on it (one PR to agency-evals)

Needs an agency-lang build that holds phases 1 and 2 installed in `AE/` (a release, or packed tarballs while the PRs are open; say which in the PR).

### Task 10: Split `task.json` into `repo.json` and `graders.json`

**Files:**
- Create, for each of the seven tests: `<test>/repo.json`, `<test>/graders.json`
- Delete, for each test: `<test>/files/task.json`, `<test>/graders.ts`
- Modify, for each test: `<test>/test.json` (add `"setup": "node \"$AGENCY_EVAL_TEST_DIR/../setup.mts\""`)
- Create: `AE/agency-plans/lib/suiteFiles.test.ts`

**Interfaces:**
- Produces:
  - `repo.json`: `{ "startCommit", "solutionCommit", "packageDir", "buildCommand", "checksDest" }`, copied from `task.json`.
  - `graders.json`, for a test whose `packageDir` is `packages/agency-lang`:

```json
[
  { "kind": "command", "name": "builds", "mustPass": true, "weight": 0, "timeoutSec": 2700,
    "command": "(cd packages/agency-lang && pnpm --filter @agency-lang/tui run build && make) && mkdir -p packages/agency-lang/tests/agency/units && cp -R \"$AGENCY_GRADER_FILES/checks/.\" packages/agency-lang/tests/agency/units" },
  { "kind": "command", "name": "unitLiterals", "weight": 0.5,
    "command": "cd packages/agency-lang && pnpm run agency test tests/agency/units/unitLiterals.agency" }
]
```

  No `cost`, `agent-seconds` or `agent-finished` grader: the score is the checks only (decided). Cost and time are still recorded with every run.

- [ ] **Step 1: Write the failing test `suiteFiles.test.ts`.** For every test folder in `agency-plans/`: `repo.json` has the five fields; `graders.json` starts with a must-pass `builds` grader of weight 0 whose command contains the test's `buildCommand` and its `checksDest`; every other grader's command starts with `cd <packageDir> && ` unless `packageDir` is `.`; grader names are unique; `test.json` has the `setup` line; and there is no `files/task.json` and no `graders.ts`.
- [ ] **Step 2: Run** `pnpm exec vitest run agency-plans/lib/suiteFiles.test.ts`. Expected: FAIL for all seven.
- [ ] **Step 3: Convert** with a one-off script in the scratchpad (not committed) that reads each `task.json` and writes the two files; delete `files/task.json` and `graders.ts`. **Run** the test and `pnpm exec agency eval ls --suite agency-plans`. Expected: PASS, and seven tests listed.
- [ ] **Step 4: Commit** `Split each test's task.json into repo.json and graders.json`.

### Task 11: `setup.mts`

**Files:**
- Create: `AE/agency-plans/setup.mts`, `AE/agency-plans/lib/setupSteps.mts`, `AE/agency-plans/lib/setupSteps.test.ts`, `AE/agency-plans/noop.agency`
- Move: `lockScript` and its tests from `AE/lib/sandbox/network.ts` into `setupSteps.mts`
- Modify: `AE/tsconfig.checks.json` (include `agency-plans/*.mts` and `agency-plans/lib/*.mts`)

**Interfaces:**
- Consumes: `AGENCY_EVAL_TEST_DIR` and `AGENCY_EVAL_AGENT_DIR` (Task 1), `<test>/repo.json` (Task 10), and the spike's answers on fetching by hash and on what `git` needs.
- Produces:

```ts
export const AGENT_USER = "bench";
export const REPO_URL = "https://github.com/egonSchiele/agency-lang";
export const NOOP_AGENT = "/opt/agency-plans/noop.agency";
export const ORACLE_NOTICE = "ORACLE: checking out the solution commit";
export type RepoJson = { startCommit: string; solutionCommit: string; packageDir: string; buildCommand: string; checksDest: string };
/** The commands setup runs, in order. Pure. */
export function setupSteps(args: {
  repo: RepoJson; oracle: boolean; allowHosts: string[];
  workdir: string; agentDir: string; suiteDir: string;
}): { label: string; command: string }[];
export function lockScript(user: string, allowHosts: string[]): string;
```

- `setup.mts` reads `repo.json` from `$AGENCY_EVAL_TEST_DIR`, prints `ORACLE_NOTICE` first when in oracle mode, runs each step with `sh -c`, prints its label, and exits non-zero with the step's output at the first failure. `oracle` is `process.env.AGENCY_PLANS_ORACLE === "1"`. Hosts come from `PLAN_EVAL_ALLOW_HOSTS`, default `openrouter.ai`. It fails at once, before any step, when `AGENCY_EVAL_AGENT_DIR` is not set.

- [ ] **Step 1: Write failing tests for `setupSteps`.** The labels are, in order:
  1. `install iptables`
  2. `create the agent user`
  3. `fetch the repo`: names `startCommit`, or `solutionCommit` when `oracle` is true
  4. `let root use git in the agent user's repo`: `git config --system --add safe.directory '*'`, which the spike showed is needed and enough
  5. `install dependencies`: runs in `packageDir`
  6. `place the do-nothing agent`: copies `<suiteDir>/noop.agency` to `NOOP_AGENT`, and makes `/opt/agency-plans` owned by `bench`. The spike showed `agency run` writes its compiled file beside the source, so `bench` must own the folder.
  7. `hand the workdir and the statelog folder to the agent user`: names both `workdir` and `agentDir`
  8. `lock the agent user's network`
  9. `check the lock`: as `bench`, `github.com` must be unreachable **and** the first allowed host must be reachable; it exits non-zero otherwise, saying which half failed

  Nothing after step 8 needs the network as root.
- [ ] **Step 2: Run, implement, run.** **Step 3: Write `setup.mts` and `noop.agency`** (`node main(prompt: string) { return "noop" }`) and run `pnpm run typecheck`. Expected: clean.
- [ ] **Step 4: Commit** `Add the suite's setup program`.

### Task 12: Configure the wrapper, and `verify`

**Files:**
- Create: `AE/eval-daytona.json`, `AE/agency-plans/verify.mts`, `AE/agency-plans/lib/verifyProblems.mts`, `AE/agency-plans/lib/verifyProblems.test.ts`
- Modify: `AE/package.json` (add `@agency-lang/eval-daytona`; remove `@daytona/sdk`)

**Interfaces:**
- Consumes: `breakdown` or `summarizeEvalRun` from `agency-lang/eval` to read a run directory's grades. Read their types first and use them; do not parse `annotations.jsonl` by hand. `NOOP_AGENT` from Task 11.
- Produces:

```ts
type Graded = { testId: string; grades: { name: string; passed: boolean; feedback: string }[] };
/** Every check must fail in `start` and pass in `oracle`. */
export function verifyProblems(args: { start: Graded[]; oracle: Graded[] }): string[];
/** The agent verify uses: nothing, started exactly as a real agent is. */
export const VERIFY_AGENT_CMD = "runuser -u bench -- agency run /opt/agency-plans/noop.agency -- {input}";
```

- `eval-daytona.json`: `{ "image": "node:22-bookworm", "env": ["OPENROUTER_API_KEY", "PLAN_EVAL_ALLOW_HOSTS"] }`. **`AGENCY_PLANS_ORACLE` is not in it**, and a unit test asserts that.

- [ ] **Step 1: Write failing tests for `verifyProblems`:** no problems when every check fails at the start and passes with the oracle; `builds` is ignored at the start (the starting tree builds); a check that passes at the start is reported as `<test>: check "<name>" passes on the starting tree`; a check that fails with the oracle is reported with its feedback; a test missing from either group is reported; a run whose statelog is empty is reported as `<test>: the agent wrote no statelog (could bench write it?)`. And a test that `eval-daytona.json`'s `env` does not contain `AGENCY_PLANS_ORACLE`.
- [ ] **Step 2: Run, implement, run.**
- [ ] **Step 3: Write `verify.mts`.** It runs `agency-eval-daytona --agent-cmd "<VERIFY_AGENT_CMD>" --suite agency-plans [--test <id>]… -n 4 --out runs/verify-<stamp>-start`, then the same with `--env AGENCY_PLANS_ORACLE=1` and `…-oracle`, reads both groups' grades, prints `verifyProblems`, and exits non-zero when there are any. It also checks that the oracle group's logs contain `ORACLE_NOTICE` and the start group's do not. No model is called.
- [ ] **Step 4: Run** `node agency-plans/verify.mts` on all seven tests. Expected: no problems. This proves three things at no model cost: the checks behave in the new shape as they did in the old; `bench` can reach its workdir and write its statelog under the wrapper's real permissions; and the network lock lets the model host through. Fix what it finds.
- [ ] **Step 5: Commit** `Run agency-plans through the Daytona wrapper, with verify`.

### Task 13: Delete the old layer

**Files:**
- Delete: `AE/lib/sandbox/` (all of it), `AE/agency-plans/run.ts`, `AE/agency-plans/cli.ts`, `AE/agency-plans/lib/graders.ts`, `AE/agency-plans/lib/task.ts`, `AE/agency-plans/lib/probeArgs.ts`, their tests, `AE/vitest.integration.config.ts`
- Keep: `AE/agency-plans/lib/checkKit.mts` and its copies, the check files, and the unit tests of `markdown.mts`, `astShape.mts`, `sleepVerdict.mts`
- Modify: `AE/package.json` scripts, `AE/tsconfig.json`

- [ ] **Step 1: Delete**, then run `pnpm run test` and `pnpm run typecheck`. Expected: PASS, with only the kept tests and the new ones left.
- [ ] **Step 2: Search for leftovers:** `grep -rn "lib/sandbox\|task\.json\|eval-sandbox\|cli\.ts\|run\.ts" . --include=*.ts --include=*.mts --include=*.md --include=*.json` outside `node_modules`, `runs` and `docs/superpowers`. Read each match: `run\.ts` and `cli\.ts` also match unrelated names. Expected: none that refers to the deleted files.
- [ ] **Step 3: Ask the user** whether to delete the old runs under `runs/` (git-ignored), which can no longer be graded.
- [ ] **Step 4: Commit** `Remove the custom runner, graders and sandbox library`.

### Task 14: One real run, upload, and the docs

- [ ] **Step 1 (costs model money, ask first):** run one test with the real agent:

```bash
pnpm exec agency-eval-daytona \
  --agent-cmd "runuser -u bench -- agency agent --brain coordinator --provider openrouter --model z-ai/glm-5.3-flash --effort high --policy approve-all --max-cost 4.5 --max-time 60m -p -- {input}" \
  --suite agency-plans --test literate-weave --out runs/wrapper-check
```

  Expected: a run directory at `runs/wrapper-check/literate-weave/` with a statelog, score rows for `builds` and each check, no `workdir/`, and no sandbox left. Report the score and what the agent did, and check that the checks it passed are the ones its changes should pass.

- [ ] **Step 2: Upload.** Ask the user for the statelog host and project id, add `log.host` and `log.projectId` to `agency.json`, and run `STATELOG_API_KEY=… pnpm exec agency eval upload runs/wrapper-check`. Expected: it prints the batch URL, and the run shows in the app with its grades.
- [ ] **Step 3: Rewrite `AE/agency-plans/README.md`:** what a test is (five files), how to run the suite, how to add a test (plan, `repo.json`, check files, `graders.json`, `verify`), how to upload, and what is not possible (grading an old run again). Add a short `AE/CLAUDE.md`: a suite is plain framework files; no custom runner or grader classes; no shell scripts; `agency-plans` is the worked example.
- [ ] **Step 4: Commit and open the PR.**

---

## Self-review notes

- **Spec coverage.** Part 1a → Task 1. 1b → Task 3. 1c → Tasks 1 (tail, group kill) and 2 (turns). 1d, 1e, 1f → Task 4. Part 2 → Tasks 5 to 9, with Ctrl-C in Tasks 5 and 8. Part 3 → Tasks 10 to 14. Requirement 3 (upload) → Task 14 step 2.
- **Second review.** 1 (supervisor for detached commands) → Task 1. 2 (no grading after an interrupt, and when score rows are written) → Tasks 3, 7, 8. Small points → Tasks 0, 4, 5, 9, 11.
- **Review findings.** 1 (agent user and statelog) → Tasks 0, 1, 7, 9, 11, 12. 2 (tail) and 3 (group kill) → Task 1. 4 (oracle) → Tasks 6, 11, 12. 5 (time budget, always bring back) → Tasks 6, 7. 6 (Ctrl-C) → Tasks 5, 8, 9. 7 (extract `runShell`, keep `process.env`, `timeoutSec`) → Task 1. 8 (explicit rule) → Task 2. 9 (spike) → Task 0. 10 (snapshot) → Task 4. Smaller points → Tasks 3, 4, 6, 7, 9, 11, 13.
- **Not in this plan.** Live cost for container runs, installing the agent's build beside the framework's, a prebuilt image, and moving `checkKit.mts` out of the per-test copies (a run directory stores only its own test's `graderFiles/`).
