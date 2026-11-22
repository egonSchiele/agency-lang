# plan-design: does an agent design the right change?

Each test gives an agent a problem in this repository and asks it for an implementation plan. No plan is handed to it. A checklist of yes or no questions then checks facts about the plan it wrote.

`evals/architecture-review` asks a different question. It hands a reviewer a finished plan and checks whether the reviewer objects to it.

## Why a checklist

A good design is not one fixed answer, so no grader compares the plan to a reference plan. Each point is a fact a judge can read off the plan, such as "The plan changes no file under `lib/runtime/`." Any design that has the properties passes.

Every point is written so that yes is the good answer.

## The repository as it was

The agent has to read the code as it was before the change was designed. Later code may contain the fix. Each test's `input.commit` is that commit on `main`.

The suite shares its snapshots with `evals/architecture-review`:

```bash
export ARCH_REVIEW_SNAPSHOTS=/abs/path/to/snapshots
bash evals/architecture-review/lib/prepare-snapshots.sh evals/plan-design
```

Each snapshot is about 65 MB on disk. Put the folder outside the repository.

## Run it

```bash
pnpm run agency eval run \
  evals/plan-design/lib/designer.agency:baseline \
  --suite evals/plan-design \
  --out runs/plan-design/baseline -n 3

cd evals/architecture-review/judge
node ../../../dist/scripts/agency.js eval grade ../../../runs/plan-design/baseline \
  --suite ../../plan-design -n 4
```

The run directory has to be inside the repository, so the compiled entry node can import `agency-lang`.

Grade from `evals/architecture-review/judge`. Its `agency.json` makes Claude Sonnet 5.5 the judge.

## The contract

Input, the entry node's single parameter:

```
{ "commit": string, "task": string }
```

`commit` picks the snapshot. `task` states the problem and names no design. Output is the plan as text.

`lib/designer.agency` runs `oracleAgent` from `std::agents/oracle` on GLM 5.3 Flash through OpenRouter. A handler approves reads, greps, listings, and globs inside the snapshot and rejects every other interrupt, so the agent cannot write files or reach the network.

## Grading

A test's `graders.json` has two checklists:

- `is-a-plan` must pass. It checks that the output proposes a concrete change. Without it, an empty answer would pass every "changes nothing" point.
- The second checklist holds the design properties. Its score is the share of points that passed.

`graderFiles/notes.md` is the judge's context: facts about the repository that the points depend on, and how to read each point. The reference plans in `graderFiles/` are for a person reading the results. Nothing grades against them.

## Adding a test

A new test needs four things:

- a problem an agent or a person first solved with a design the owner rejected
- the commit on `main` just before that design was written
- the properties the approved design has and the rejected one lacks, as checklist points
- a check that each point is false for the rejected plan and true for the approved one

Write the task so it states the problem and names no design. Keep a `tags` field out of `test.json` until there is a subset someone would run.
