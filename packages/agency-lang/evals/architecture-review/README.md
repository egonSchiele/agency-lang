# architecture-review: does a reviewer catch a bad design?

Each test is a plan or spec for a change to this repository, taken as it was when its author first showed it to the owner. Seven are designs the owner rejected. Four are designs the owner approved, as controls.

Two of the tests are a pair. `hidden-messages` is a rejected plan, and `control-session-transcript` is the plan that replaced it for the same problem.

The rejected designs are the kind that pass tests and still should not be built:

- **The wrong layer.** Shared code changes to serve one caller. For example, `first-tool-call` adds an option to `llm()` for one router.
- **It already exists.** The plan builds something the code already has. For example, `statelog-tags` adds a third way to tag a run.
- **It is too complex.** For example, `message-lifespans` keeps per-message data in a side array instead of on the message.

The owner's objection to each plan is the test's ground truth, in its `graders.ts`.

## The repository as it was

A reviewer has to read the code to know what already exists, and it has to read the code from the day the plan was written. Later code may contain the fix. Each test's `input.commit` is the commit on `main` just before the plan was written.

`lib/prepare-snapshots.sh` unpacks `packages/agency-lang` at each of those commits into `$ARCH_REVIEW_SNAPSHOTS/<commit>/`. That takes about 600 MB in total.

## Run it

```bash
export ARCH_REVIEW_SNAPSHOTS=/abs/path/to/snapshots
bash evals/architecture-review/lib/prepare-snapshots.sh

pnpm run agency eval run \
  evals/architecture-review/lib/reviewer.agency:baseline \
  --suite evals/architecture-review \
  --out runs/architecture-review/baseline -n 3

cd evals/architecture-review/judge
node ../../../dist/scripts/agency.js eval grade ../../../runs/architecture-review/baseline \
  --suite .. -n 4
```

The run directory has to be inside the repository, so the compiled entry node can import `agency-lang`.

Grade from the `judge` folder. Its `agency.json` makes Claude Sonnet 5.5 the judge. The package's default judge, gpt-5-mini, is too lenient for this suite: it gives full marks to findings that keep the flawed design and only say where to put it.

Read the findings behind every passing score. A judge can match a finding to the objection by its words even when the finding argues the opposite.

GLM 5.3 Flash uses the reviewer's whole 10-minute budget on every plan. The `baselineLong` and `withSkillLong` nodes give it 20 minutes. They need `eval.limits.wallClockSec` above 1200 in the `agency.json` of the folder you run from.

To give the reviewer the `architecture-review` skill, set `ARCH_REVIEW_SKILL_DIR` to the folder holding its `SKILL.md` and run the `withSkill` node instead of `baseline`.

## The contract

Input, the entry node's single parameter:

```
{ "plan": string, "commit": string, "task": string }
```

`plan` names the file the test seeds into the working directory. `commit` picks the snapshot. `task` is one sentence saying what the plan is for. Output is the stdlib `Feedback` list. `error: true` marks a problem the plan should not go ahead with.

`lib/reviewer.agency` runs `reviewAgent` from `std::agents/review` on GLM 5.3 Flash through OpenRouter. It adds the `read`, `grep`, `ls`, and `glob` tools. A handler approves those tools inside the snapshot and rejects every other interrupt, so the reviewer cannot write files or reach the network.

## Grading

A rejected plan has two graders:

- `rejects`: the review has at least one error finding.
- `names-the-flaw`: a judge scores whether an error finding raises the owner's objection. A finding that names the problem and points to the same fix scores 1. A finding that notices the area but keeps the flawed design scores 0.5.

A control has two graders:

- `review-finished`: the review returned at least one finding. The reviewer lists satisfied points as well as problems, so an empty list means it ran out of budget before saving anything.
- `no-false-architecture-alarm`: no error finding objects to the design for one of the three reasons above. Findings about tests, wording, or edge cases do not count.

A test passes when every grader scores at least 0.7.

## Adding a test

The owner keeps a log of rejected designs. A new test needs four things:

- the plan as the owner first saw it, from the transcript or the branch's first commit
- the commit on `main` just before the plan was written
- the owner's objection, written as the `reason`
- a check that the existing mechanism the objection names was present at that commit
