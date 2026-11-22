# plan-design: does an agent design the right change?

Each test gives an agent a problem in this repository and asks it for an implementation plan. No plan is handed to it. Checklists of yes or no questions then check facts about the plan it wrote.

`evals/architecture-review` asks a different question. It hands a reviewer a finished plan and checks whether the reviewer objects to it.

The suite ships no agent. You name the agent on the command line, so the same tests score `agency agent`, one of its brains, or another CLI.

## Why checklists

A good design is not one fixed answer, so no grader compares the plan to a reference plan. Each point is a fact a judge can read off the plan, such as "The plan changes no file under `lib/runtime/`." Any design that has the properties passes.

Every point is written so that yes is the good answer.

## The repository as it was

The agent has to read the code as it was before the change was designed. Later code may contain the fix.

Each test seeds one small file, `snapshot-commit`, which holds a commit hash. `in-snapshot.sh` goes in front of the agent command:

```bash
/abs/path/to/evals/plan-design/in-snapshot.sh agency agent -p -- {input}
```

The script unpacks `packages/agency-lang` at that commit under `$PLAN_DESIGN_SNAPSHOTS`, makes it read-only, changes into it, and runs the agent there. It unpacks a commit once. Each snapshot is about 65 MB on disk.

Put the snapshots folder and the run directory outside the repository. An agent that can walk up from its working directory into today's checkout can read the fix, and can read this suite's `graderFiles`.

## Run it

```bash
export PLAN_DESIGN_SNAPSHOTS=/abs/path/outside/the/repo/snapshots

node dist/scripts/agency.js eval run \
  --agent-cmd "$PWD/evals/plan-design/in-snapshot.sh agency agent --brain coordinator --policy recommended --reject Network,Shell,FileWrite -p -- {input}" \
  --suite evals/plan-design \
  --out /abs/path/outside/the/repo/runs/plan-design-coordinator -n 3

cd evals/architecture-review/judge
node ../../../dist/scripts/agency.js eval grade /abs/path/outside/the/repo/runs/plan-design-coordinator \
  --suite ../../plan-design -n 4
```

The script's path is absolute because the command starts in the run's working directory, not in the folder you ran `eval run` from.

`--policy recommended` approves reads under the working directory, which is the snapshot. `--reject Network` keeps the agent from reading a later version of the code on GitHub.

Grade from `evals/architecture-review/judge`. Its `agency.json` makes Claude Sonnet 5.5 the judge.

To compare two agents, run the suite once for each with a different `--agent-cmd` and `--out`.

## The contract

A test's `input` is the task as one string. It states the problem, names no design, and asks for a plan as the reply. The graded output is the agent's reply.

A command agent has to record its reply with `evalOutput` from `std::statelog`, as `agency agent` does. See `docs/dev/evals/eval-command-agents.md`.

## Grading

A test's `graders.json` holds several checklists, one per property of the design. A checklist's score is the share of its points that passed, so the scores say which property a plan lacks.

`is-a-plan` must pass. It checks that the output proposes a concrete change. Without it, an empty answer would pass every "changes nothing" point.

`graderFiles/notes.md` is the judge's context: facts about the repository that the points depend on, and how to read each point. The reference plans in `graderFiles/` are for a person reading the results. Nothing grades against them.

## The tests

### session-transcript

A reopened agent session shows text the user never typed, such as a cancel note or the output of a `!` command. There are three kinds of fix:

1. Put a mark in the text and have the reader strip it. This is the cheapest to write. Every later feature that adds text then has to know the mark.
2. Put a `hidden` flag on messages. This needs changes to the runtime and the public API, and it splits messages so the flag can apply.
3. Have the session core record what the user typed and what it replied, in a list saved with the checkpoint. The model's conversation is not changed.

The checklists pass the third kind. The first plan written for this task was the second kind.

## Adding a test

A new test needs four things:

- a problem an agent or a person first solved with a design the owner rejected
- the commit on `main` just before that design was written, in `files/snapshot-commit`
- the properties the approved design has and the rejected one lacks, as checklist points
- a check that the rejected plan fails the points and the approved plan passes them

Write each point so that no other point decides its answer. Two points that always pass or fail together count one property twice.

Leave `tags` out of `test.json` until there is a subset someone would run.
