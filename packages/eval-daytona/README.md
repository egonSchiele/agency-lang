# @agency-lang/eval-daytona

Run an Agency eval suite with each test in its own [Daytona](https://www.daytona.io) container.

Use it when a test's work has to be built and run somewhere isolated: for example, a coding agent that changes a repository, which is then built and tested. The command plays the role a CI system plays for a test runner. It starts a container for each test, copies your project in, runs the ordinary `agency eval run --grade` there, and brings the run directory back. `agency-lang` itself knows nothing about containers.

## Use

```bash
npm install --save-dev @agency-lang/eval-daytona
export DAYTONA_API_KEY=…

npx agency-eval-daytona \
  --agent-cmd "agency agent --policy approve-all -p -- {input}" \
  --suite my-suite -n 4
```

Run it from your project's top folder, the one that has `agency-lang` installed. The arguments are the ones `agency eval run` takes for a suite:

| Argument | Meaning |
| --- | --- |
| `[agent]` or `--agent-cmd <command>` | The agent: a `.agency` file inside the project, or a command with `{input}` where each test's input goes. |
| `--suite <directory>` | A directory of tests, inside the project. |
| `--test <pattern>`, `--tags <tags>` | Select tests, as `agency eval run` does. |
| `--out <dir>` | Where the runs go. Default `runs/<timestamp>`. |
| `-n <count>` | How many containers to run at once. Default 1. |
| `--trials <count>` | Run every test this many times. |
| `--env NAME=VALUE` | Set a variable in the containers for this invocation only. |
| `--keep` | Leave each container running afterwards, for looking inside. |

When it finishes it prints one line per test, and the command to upload the results:

```
unit-literals  score 0.750  $2.05
layout-table   score 1.000  $1.10
upload with: agency eval upload runs/2026-11-25-101500-a1b2c3
```

The run directories are ordinary ones. `agency eval logs`, `agency runs list` and `agency eval upload` work on them.

## What happens to one test

1. A container is created.
2. The `agency-lang` installed in your project is packed and installed in it, so the container runs the same agency you do.
3. Your project is copied to `/eval/project`. `node_modules`, `.git` and your runs directory are left out. The copy is readable by root only, because it holds the suite's grader files.
4. `agency eval run --test <id> --grade --no-workdir-snapshot …` runs from that copy. It seeds the test's files, runs the test's `setup`, runs the agent, and grades in the workdir the agent used.
5. The run directory is downloaded: the trace and the grades, not the workdir.
6. The container is deleted.

## Options

Put these in `eval-daytona.json` in your project's top folder. All are optional.

```json
{
  "image": "node:22-bookworm",
  "env": ["OPENROUTER_API_KEY"]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `image` | `node:22-bookworm` | The container image. |
| `cpu`, `memory`, `disk` | 4, 8, 10 | Cores, GB of memory, GB of disk. |
| `env` | `[]` | Names of your environment variables to pass into the containers, such as API keys. A name that is not set is left out, and the command says so once. |
| `agency` | `"same"` | Which agency to install in the container: the one in your project, or `{ "tarball": "path/to/agency-lang.tgz" }`. |
| `graceSec` | 7200 | Seconds allowed for grading, on top of the test's own time limit and the 30 minutes its `setup` may take. |

`--env NAME=VALUE` is for a switch that must never leak in from your shell. A name given that way is never read from your environment.

## What your suite has to do

The container starts as a bare image. Anything a test needs goes in its `setup` command (see `test.json` in the Agency eval docs): fetching a repository, installing dependencies, installing system packages.

**If your agent should not run as root,** the suite does that too:

- In `setup`, create the user, and give it the workdir and the folder named by `AGENCY_EVAL_AGENT_DIR`. The agent writes its trace into that folder.
- Start the agent as that user: `--agent-cmd "runuser -u bench -- agency agent … -p -- {input}"`.
- `agency run <file>` writes its compiled file beside the source, so a program the user runs must be in a folder the user owns.

Graders run as root, in the workdir.

**A file agent** (`agency-eval-daytona agent.agency …`) is compiled and run inside the container, from a workdir that has no `node_modules`. If it cannot find `agency-lang` there, use the command form: `--agent-cmd "agency run /eval/project/agent.agency -- {input}"`.

## Limits and spending

Inside each container, `agency eval run` applies your `agency.json` as usual: `eval.limits.wallClockSec`, a test's own `timeoutSec`, and `eval.limits.maxCostUsd`. The command adds one check of its own: once the runs that have come back cost more than `eval.limits.maxBatchCostUsd`, it starts no more containers.

A container gets the test's time limit, plus 30 minutes for `setup`, plus `graceSec` for grading. If that runs out, the run directory is still downloaded when one exists; it will have no grades.

## Ctrl-C

The first Ctrl-C starts no more tests and interrupts the ones running. Each has up to a minute to stop. Whatever run directory it wrote is downloaded, without grades, and its container is deleted. The summary is printed and the exit code is 130, even when every run in flight came back.

A second Ctrl-C deletes every container at once and exits.

## Not supported yet

- **Live cost.** While a test runs you see when it starts and ends. Its output is appended to `<out>/.logs/<test>.log` as it arrives.
- **Grading a run again later.** The workdir is deleted with the container, and `agency eval grade` skips these runs.
- **A prebuilt image.** Whatever `setup` installs is installed in every container.
- **A record of a container that was lost.** A test whose container died before it wrote a run directory is listed in the summary as failed, and has no run directory, so it is missing from the batch once uploaded. A test whose agent or `setup` failed is different: that is recorded in a run directory like any other.
- **Suites that are a JSON file or a git source.**

## Development

```bash
pnpm run build
pnpm run test:run            # unit tests, no network
pnpm run test:integration    # real containers; needs DAYTONA_API_KEY; calls no model
```

This is a tool package: it has a `bin` and no `index.agency`.
