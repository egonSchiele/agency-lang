# Running eval tests in a container

**Status:** draft 3, 2026-11-25. Rewritten after the architecture review, then corrected after two written reviews (`docs/superpowers/plans/2026-11-25-eval-test-runners-review.md` and `…-review-2.md`). All decisions are made; see "Decisions".
**Touches:** `agency-lang` (the eval framework), a new package `@agency-lang/eval-daytona`, and this repo's `agency-plans` suite.

## The problem

`agency-plans` tests a coding agent on old commits of agency-lang. The agent's work has to be built and run in an isolated place. The eval framework runs everything on the host, so this repo grew its own layer around it:

- a custom runner that puts the agent in a Daytona sandbox,
- a saved patch that carries the work out,
- custom grader classes that rebuild the work in a second sandbox,
- a `task.json` format, a `verify` command, and about 3,000 lines in `lib/sandbox/`.

Every future coding suite would copy that layer. The framework's own `command` grader, which is all the checks really are, cannot be used, because the workdir on the host never holds the repo.

## The idea

**Run the whole test inside the container, the way a CI system runs vitest.** A wrapper command starts a container for each test, copies the project in, and runs the ordinary `agency eval run` there. Inside the container everything is local, so the framework's existing features work unchanged: seeding `files/`, starting the agent, limits, `command` graders.

The framework does not learn about containers, Daytona, runners or remote commands. It gains a handful of small features that are useful anywhere.

```
host                                    container (one per test and trial)
----                                    ---------------------------------
agency-eval-daytona --suite agency-plans
  for each test:
    start a container, copy the project in
                         ───────────►   agency eval run --test <id> --grade
                                           --no-workdir-snapshot
                                           --batch <id> --trial-number <n>
                                          seed files/  →  setup  →  agent  →  graders
    run directory        ◄───────────   run directory (without workdir/)
    delete the container
agency eval upload <group>
```

## Requirements

Stated by the user:

1. Run and grade happen in one container, one after the other.
2. The statelog and the grades come back to the host, so they can be opened later.
3. The results can be uploaded to the statelog web app.
4. No Daytona code and no new dependencies in `agency-lang`.
5. Grading an old run again is **not** required.

Added by this design:

6. A suite needs no custom runner code and no custom grader classes. A test is `test.json`, `files/`, `graderFiles/` and `graders.json`.
7. The framework gains no concept of where a test runs.

## Non-goals

- A runner or environment interface inside the framework. The architecture review weighed a pluggable runner and chose the wrapper: it changes nothing in the framework's core loop.
- Live cost, or `eval logs -f`, for a test that is running in a container. The wrapper prints each test's state and elapsed time.
- Re-grading a container run on the host. Its workdir is deleted with the container.
- Wrapping a suite that is a JSON file or a git source. The wrapper needs `--suite <directory>` inside the project.

## What was checked in the agency-lang source (0.45.4)

Paths are under `packages/agency-lang/`.

| Fact | Where | Consequence |
| --- | --- | --- |
| `eval run` never grades. | `lib/cli/eval/run.ts` | The container must grade before it is deleted, so `eval run` needs a way to grade. |
| A finished run's workdir is copied into the run directory with `fs.cpSync`, and graders run against the copy. | `lib/runDirectory/attachWorkdir.ts`, `lib/eval/grading/gradeRun.ts:337` | A built repo is large, and a copy of a `pnpm` tree may not work. Grading must use the workdir the agent worked in. |
| Must-pass graders run first, one at a time. The rest run together. | `lib/eval/grading/gradeRun.ts:416-430` | A must-pass `builds` grader runs before the checks. But the checks would all run at once in one workdir. |
| The `command` grader runs a shell command in the workdir with a timeout and sets `AGENCY_GRADER_FILES`. Weight 0 is allowed. | `lib/eval/gradersJson/build.ts` (`runShell`, line 213), `schema.ts:11` | The checks can be plain `graders.json` entries, and `setup` can reuse `runShell`. |
| That shell runner keeps the **first** 2,000 characters of output. | `build.ts:164-165, 246-248` | A failed build prints its error last, so the error would be cut off. The runner must keep the end. |
| At a timeout it kills only `sh`. Processes the command started keep running. | `build.ts:231-234` | The next command could start while the old one's processes still work in the same tree. The runner must kill the whole process group, as the agent runner already does (`lib/eval/run/spawnRunner.ts:83,90`). |
| The agent's statelog goes to `<staging>/agent/statelog.jsonl`. The harness creates `agent/` after the files are seeded. | `lib/eval/run/extract.ts:26-33`, `lib/eval/run/runAgent.ts:195` | An agent that runs as another user cannot write its statelog unless something hands it that folder, and at the point `setup` would run, the folder does not exist yet. |
| `--agent-cmd` is split into arguments with no shell. | `lib/eval/run/commandLine.ts` | The agent can be started as another user with `runuser -u bench -- agency agent … {input}`. |
| The batch id and trial number are minted inside `runSuite`. Upload groups runs by batch id. | `lib/eval/run/runSuite.ts`, `lib/cli/eval/upload.ts:296` | The wrapper must be able to give each inner run its batch id and trial number. |
| `agency eval ls` prints text only. | `agency eval ls --help` | The wrapper needs the list of selected tests in a form it can read. |
| `agency eval upload <paths>` exists. | `lib/cli/eval/upload.ts` | Requirement 3 needs configuration, not code. |

## Design

### Part 1: changes to `agency-lang`

Six small changes, none of which mention containers.

**1a. `setup` in `test.json`.** A shell command the framework runs in the workdir after `files/` is copied in and before the agent starts.

```json
{ "input": "Please execute the plan in PLAN.md …",
  "setup": "node \"$AGENCY_EVAL_TEST_DIR/../setup.mts\"" }
```

- It runs with the same shell runner the `command` grader uses.
- It is given two paths in its environment:
  - `AGENCY_EVAL_TEST_DIR`: the folder that holds `test.json`.
  - `AGENCY_EVAL_AGENT_DIR`: the folder the agent will write its statelog into. The harness creates it before `setup` runs. The rule for suite authors is one line: **if your agent runs as another user, give that user the workdir and this folder.**
- A non-zero exit, or running past a fixed limit of 30 minutes, makes the test an error result whose message starts `setup failed` and ends with the last 2,000 characters of the output. The agent does not start.
- Its time and output are not part of the agent's trace.
- It is arbitrary code from the suite, which is the trust a `graders.ts` already has.
- *Why:* a test today can only start from the files in `files/`. A coding test starts from a repo at a commit, with dependencies installed.

**1b. `agency eval run --grade`.** Grade each test as soon as its agent finishes, with the graders the run stored, in the workdir the agent worked in, before that workdir is removed. Grades are written to the run directory exactly as `agency eval grade` writes them. Without the flag nothing changes, and `agency eval grade` still works on any run directory that has a workdir snapshot. A run that was interrupted is not graded: grading can take most of an hour, and whoever interrupted is waiting.

- *Why:* in a container that is about to be deleted, grading has to happen before the run ends, and it has to use the real workdir.

**1c. Three changes to `command` graders. All three change existing behavior on purpose**, and the changelog says so.

- **They take turns.** Command graders of one run execute one after another, in file order. Other grader kinds still run together. The rule is written in `gradeRun`, where the order of grading is decided, not hidden in the command grader: a grader can declare that it needs the workdir to itself, and those graders run in order. A suite with several command graders will grade more slowly than before.
- **Feedback is the end of the output**, not the start. Errors come last.
- **A timeout kills everything the command started**, not just the shell. The command runs in its own process group, registered with the supervisor the agent runner already uses, so Ctrl-C still reaches it and nothing is left running when `agency` exits.
- *Why:* a dozen test commands compiling into one tree at once collide; a build's error is at the bottom; and a timed-out build that keeps compiling collides with the next check.

**1d. `--batch <id>` and `--trial-number <n>` on `eval run`.** Both are ordinary, documented flags.

- `--batch <id>` records the runs under this batch id instead of a new one. A person can use it too: re-run the tests that failed and add them to last night's batch.
- `--trial-number <n>` records this run as trial `n`. It runs each selected test once and writes it flat at `<out>/<testId>/`. It cannot be combined with `--trials`.
- *Why:* the wrapper starts one inner run per test and trial. Left alone, each would invent its own batch id and call itself trial 1.

**1e. `agency eval run --no-workdir-snapshot`.** Do not copy the workdir into the run directory. The run's row records that, and `agency eval grade` skips such a run with a line saying why. Found while building it: grading such a run again fails every grader that reads the workdir, and those failures would be recorded as the run's newest grades, over the real ones.

- *Why:* the wrapper never brings the copy back. Copying a built monorepo for every test costs time, and two copies press on a 10 GB container disk.

**1f. `agency eval ls --json`.** Prints the selected tests as JSON: `[{ "id": …, "timeoutSec": … }]`.

- *Why:* the wrapper must select tests exactly as `eval run` would, and it must know each test's time limit.

### Part 2: the wrapper package

`@agency-lang/eval-daytona`, with one command, `agency-eval-daytona`. It is the only place the Daytona SDK is a dependency. Most of its code moves from this repo's `lib/sandbox/` (`daytona.ts`, `withSandbox.ts`, `shell.ts`, the tar helper, and the long-command polling from `runAgent.ts`).

**Command line.** The arguments of `agency eval run` that make sense for a suite, passed through to the inner command:

```bash
agency-eval-daytona [agent] --agent-cmd <command> --suite <directory> \
  [--test <pattern>]… [--tags <tags>]… [--out <dir>] [-n <count>] [--trials <count>] \
  [--env NAME=VALUE]… [--keep]
```

`--env NAME=VALUE` sets a variable in the containers for this invocation only. It is for switches that must never leak in from a shell, such as this suite's oracle mode.

**Options** are read from `eval-daytona.json` in the project directory. They are not in `agency.json`, which agency-lang validates and which should not know this package exists.

| Option | Default | Meaning |
| --- | --- | --- |
| `image` | `node:22-bookworm` | The container image. |
| `cpu`, `memory`, `disk` | 4, 8, 10 | Resources. |
| `env` | `[]` | Names of host environment variables to pass in. One that is not set is left out, and the wrapper says so once at the start. |
| `agency` | `"same"` | Which `agency` to install inside. `"same"` packs the `agency-lang` package installed in the project. Or `{ "tarball": "<path>" }`. |
| `graceSec` | 7200 | Time allowed for grading, on top of the test's own time limit and the 30 minutes `setup` may take. Fixed, because the wrapper cannot know the time limits of graders written in a `graders.ts`. |

**What it does:**

1. Read the options. Ask the project's `agency eval ls --json` for the selected tests. Refuse a suite that is not a directory inside the project, and a test id that holds glob characters (the inner `--test` would read it as a pattern).
2. Choose the group directory (`--out`, or `runs/<timestamp>-<suffix>`) and mint one batch id for the whole invocation.
3. Run the jobs, one per test and trial, `-n` at a time. For each:
   1. Create a container, labeled with the test and trial.
   2. Install `agency` globally. Check that `agency eval run --help` lists every flag the wrapper passes; if not, fail with a message that says the `agency` in the container is too old for the wrapper.
   3. Upload the project to `/eval/project`, leaving out `node_modules`, `.git`, the runs directory from `agency.json` (default `runs`) and the group directory. **Only `/eval/project` is root-only.** `/eval` and `/eval/out` stay open, because the agent's workdir is under `/eval/out` and an agent running as another user must be able to reach it.
   4. Run, from `/eval/project`, in the background: `agency eval run <agent arguments> --suite <path> --test <id> --batch <batch> --trial-number <n> --grade --no-workdir-snapshot --out /eval/out`. Poll until it ends or the time is up, appending its output to `<group>/.logs/<test>[-<trial>].log`.
   5. **Whenever `/eval/out/<id>` exists, bring it back**: pack it, compressed, download it, and unpack it at `<group>/<id>/`, or `<group>/<id>/<trial>/` with trials. This holds after a non-zero exit and after the wrapper's own time limit. A run directory with some grades missing is far better than a paid run that vanishes.
   6. Delete the container, also on failure. `--keep` leaves it running.
4. After each job, add the run's cost to a total. Once the total passes `eval.limits.maxBatchCostUsd` from `agency.json`, start no more jobs.
5. Print one line per job (state, score, cost) and the `agency eval upload <group>` command. Exit non-zero if any job produced no run directory.

**Ctrl-C.** On the first SIGINT, SIGTERM or SIGHUP the wrapper starts no more jobs and sends an interrupt to each inner `eval run`, which already knows how to fold an interrupted test into a run directory. It waits up to a minute for each, brings back whatever run directory exists, deletes the containers, and prints the summary. Those runs come back with their trace and no grades. The exit code is 130 even when every run came back. A second signal deletes every container at once and exits.

**A job that produces no run directory** (the container was lost, or setup of the container itself failed) is reported in the summary with the end of its log. No run directory is invented for it, so it will be missing from the batch in the statelog app. A test whose *agent* failed, or whose `setup` failed, is different: the inner `eval run` records that in a real run directory, and it comes back like any other.

A statelog has reached 400 MB here. Compressed, it is a small download.

### Part 3: the `agency-plans` suite, rewritten on top

```
agency.json                 eval limits; log.host and log.projectId for upload
eval-daytona.json           image, env
agency-plans/
  setup.mts                 one setup program for every test
  noop.agency               an agent that does nothing, for verify
  verify.mts                runs the two verify passes and reads the grades
  unit-literals/
    test.json               input, timeoutSec, tags, setup
    repo.json               startCommit, solutionCommit, packageDir, buildCommand, checksDest
    files/PLAN.md
    graderFiles/checks/     the check files (unchanged)
    graders.json            the checks, as command graders
```

- **`task.json` is split.** What the checks are goes in `graders.json`. What the repo is goes in `repo.json`, beside `test.json` and outside `files/`, so the agent never sees it.
- **`setup.mts`** reads `repo.json` and prepares the workdir: fetch agency-lang at `startCommit`, install dependencies, create the unprivileged `bench` user, give it the workdir and `$AGENCY_EVAL_AGENT_DIR`, and lock that user's network to the model provider. It then checks the lock in both directions: `github.com` must be unreachable for `bench`, and the model provider must be reachable.
- **Oracle mode.** With `AGENCY_PLANS_ORACLE=1`, `setup.mts` checks out `solutionCommit` instead and prints `ORACLE: checking out the solution commit` so the log shows it. The variable is never read from the host shell or a config file: `verify.mts` passes `--env AGENCY_PLANS_ORACLE=1` to the wrapper for that one invocation.
- **`graders.json`** is one must-pass `builds` grader with weight 0 (build, then copy `$AGENCY_GRADER_FILES/checks/.` into the repo), then one `command` grader per check, with today's weights.
- **The agent command** is `runuser -u bench -- agency agent … -p -- {input}`.
- **`verify`** is two ordinary wrapped runs with a do-nothing agent: one must fail every check, and one in oracle mode must pass every check. The do-nothing agent is started exactly as a real one is, `runuser -u bench -- agency run /opt/agency-plans/noop.agency -- {input}`, so `verify` also proves, at no model cost, that `bench` can reach the workdir and write the statelog. `setup.mts` puts `noop.agency` at that path. `verify.mts` reads the grades with the readers agency-lang already exports and says which checks broke the rule.

**Deleted from this repo:** `lib/sandbox/` (moved or dropped), `agency-plans/run.ts`, `agency-plans/cli.ts`, `agency-plans/lib/graders.ts` and `task.ts`, the per-test `graders.ts`, `files/task.json`, and their tests.

## Decisions

All made by the user on 2026-11-25.

| Decision | Outcome |
| --- | --- |
| Wrapper command or pluggable runner | Wrapper. |
| Command graders take turns | Yes, as an explicit rule in `gradeRun`. |
| Command grader feedback | The end of the output, for graders and for `setup`. |
| `--batch` and `--trial-number` | Ordinary, visible flags. |
| How the agent user gets a statelog folder | The harness creates it before `setup` and passes `AGENCY_EVAL_AGENT_DIR`. |
| The workdir copy | `--no-workdir-snapshot`, added now. |
| Ctrl-C | Salvage runs in flight; a second signal deletes at once. |
| Oracle mode | `--env NAME=VALUE` on the wrapper; never from the host shell. |
| Cost and time in the score | Out. The score is the checks only. Cost and time are still recorded with every run and shown in the statelog app. |
| Where the package lives | `packages/eval-daytona` in the agency-lang monorepo. `docs/dev/creating-packages.md` gets a short section on tool packages, which have a `bin` and no `index.agency`. |
| How the repo gets into the container | `setup.mts` fetches the commit from GitHub by its hash, before the agent's network is locked. The spike checks all fourteen commits (start and solution of each test) with no credentials. |

## Spike results

Run on 2026-11-25 in a Daytona container (`node:22-bookworm`, 4 CPU, 8 GB, 10 GB disk) with agency-lang 0.45.3 packed from a fresh worktree of `origin/main` (`34a06d361`). No model was called. Three passes; the logs are in `runs/spike/` (git-ignored).

| Question | Answer |
| --- | --- |
| Can the commits be fetched from GitHub by hash with no credentials? | **Yes, all fourteen** (start and solution of each test), in 12 seconds together. |
| Does `agency eval run` work inside the container and write a valid run directory? | **Yes.** `agency eval ls`, `eval run` and `eval grade` all worked from a root-only project folder. |
| Does `agency run <file> -- <input>` write the statelog the harness points it at? | **Yes**, when it can write the folder. |
| Where does `agency run` write its compiled file? | **Beside the source** (`noop.js` next to `noop.agency`). As `bench` in root-owned `/opt` it failed with `EACCES`. So the folder holding `noop.agency` must be owned by `bench`. |
| Is handing `bench` the workdir and `agent/` enough? | **Yes.** With neither handed over, the agent ran but the harness reported "run completed but wrote no statelog". With both handed over inside the agent command, the run succeeded and the statelog was written. |
| Can root build and run checks in a tree `bench` owns? | **Yes.** The build and both checks passed as root. `git` refused ("detected dubious ownership") until `git config --system --add safe.directory '*'`; after that it worked. |
| Does a `command` grader see `AGENCY_GRADER_FILES`? | **Yes.** It ran as root with the stored workdir copy as its folder. |
| How expensive are the framework's copies of a built repo? | The built tree is 1.0 GB and about 159,000 files. Seeding it through `files/` took about 30 seconds. **The copy into the run directory filled the 10 GB disk and the run died with an I/O error**, deep inside the workspace's linked `node_modules`. A plain `cp -a` of the same tree took 3 seconds. |

**What this changes:**

- `--no-workdir-snapshot` (1e) is required for this suite, not just a saving. Without it a run cannot finish.
- The repo must come from `setup`, not from `files/`. That was already the design.
- `setup.mts` gives `bench` the folder that holds `noop.agency`, and marks the repo safe for root's `git`. Both are now plain steps in the plan, not fallbacks.

Nothing in the results breaks the design.

## Trade-offs and risks

| Trade-off or risk | What it means | What is done about it |
| --- | --- | --- |
| **The agent and the framework are one install.** | In this suite the agent is `agency` itself, so the build in the container both runs the agent and grades it. An `agency` older than this work cannot be evaluated this way. And across versions, a change in the framework can look like a change in the agent. | Accepted to start with. The wrapper checks the installed `agency` has the flags it needs and fails clearly if not. If it becomes a problem, the wrapper can install the agent's build beside the framework's. |
| The framework has never run inside a container here. | Something may not work as assumed. | Phase 0 of the plan is a spike, by hand, before any other work. |
| The agent runs as `bench`, but the harness, as root, chooses where the statelog is written. | `bench` could not write it, or reach its workdir. | `AGENCY_EVAL_AGENT_DIR` (1a); only `/eval/project` is root-only; the spike uses the wrapper's real permissions; and `verify` starts its agent as `bench`. |
| Root builds and runs checks in a tree `bench` owns. | `git` refuses to run in a repo owned by another user. | `setup.mts` marks the repo as safe for root. The spike runs the build in the real order: setup, hand-over, then build as root. |
| Every container installs `iptables` from apt. | It adds time to every test. | Accepted for now. A prebuilt image is a later optimization, noted in the package README. |
| The agent and the graders share a container. | A misbehaving agent could tamper with grading. | Accepted for grading our own agents. The agent is unprivileged and the project copy is root-only. |
| Scores change again. | Old runs are not comparable, and not re-gradable. | By design. |
| A second scheduler. | The wrapper has its own small loop for `-n` and `--trials`, beside the framework's. | It is about a page of code, and it is the price of leaving the framework's loop alone. |

## Alternatives considered

- **A pluggable runner interface in the framework.** The first draft of this spec. It reuses the framework's scheduling and budget, but adds a second path through its core loop, a second meaning for the word "runner" there, and a public interface to keep stable, all for one user. Rejected in review.
- **A fine-grained environment interface in the framework (Harbor's shape).** Every part of the framework that touches the workdir would go through it. More change for nothing the requirements ask for.
- **Keep run and grade in two sandboxes (today's design).** It allows re-grading, which is not needed, at the cost of everything this spec removes.
- **Batch id and trial number by environment variable.** Invisible in logs, unchecked, and a variable left set in a shell would silently merge unrelated runs.
- **A git source as the test's `files`.** The framework can seed a workdir from a repo and commit. But the plan file must also be in the workdir, and dependencies still need installing. A setup command covers all of it in one place.
