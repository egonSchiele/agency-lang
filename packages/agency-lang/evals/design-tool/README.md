# design-tool: an eval suite for `designTool`

`designTool` in `std::toolbox` has a coding agent draft a tool, a reviewer
read the draft, generated tests run against it, and the user accept it.
This suite scores that whole loop on a fixed set of tool requests, so a
change to the brief, the reviewer, or the loop can be measured instead of
tried once by hand.

## Run it

```bash
pnpm run agency eval run \
  stdlib/toolbox.agency:evalMain \
  --suite evals/design-tool \
  --out runs/design-tool

pnpm run agency eval grade runs/design-tool
```

A run stores a copy of its graders. After changing a grader, add
`--suite evals/design-tool` to the grade command to use the current ones.

Add `--trials 3` for means with error bars, and `--test email-note` to run
one test. A test costs about as much as one real `designTool` call, around
a dollar, so the whole suite is a few dollars per trial.

## The contract

A test's input is what a caller passes `designTool`, plus what the pretend
user knows (`DesignToolEvalInput` in `stdlib/toolbox.agency`):

```
{ "name": string, "purpose": string, "request": string, "facts": { [name]: string } }
```

`evalMain` plays the user. It answers every `std::question` with all of the
test's facts, because it cannot tell which fact a question is after, and no
model is involved in the answer. It accepts the first draft it is shown. It
approves the toolbox's own effects, the run of a draft's generated tests,
and reads of the packaged docs, and it rejects everything else, so an
author that goes looking through the file system finds nothing.

The run's working directory ends up with:

- `toolbox/<name>/impl.agency`, the saved tool, when one was saved.
- `design-log.json`: whether the tool was saved and the error if not, every
  question asked, the reviewer's findings on each draft the user saw, and
  the effects `evalMain` refused.
- `last-draft.agency`, the last draft the user saw, so a judge has
  something to read when nothing was saved.

## Grading

Every test carries two graders:

- `saved` (`lib/saved.ts`): a run that saves nothing has failed.
- `reviewer-findings-are-real` (`lib/reviewerFindings.ts`): a judge reads
  each blocking finding the reviewer raised against the draft it was about
  and scores the share that are real problems. This is the number that
  catches a reviewer blocking a draft over the layout of the `Request`
  type, which is the failure that started this suite. It passes when no
  blocking finding reached the user.

A test about asking uses `asked` and `usesAnswers` (`lib/asked.ts`). When
the purpose leaves out a fact (tag `asks`), the author must ask at least
one question and the saved code must contain the answers. When the purpose
says everything, the author must ask nothing: asking without need spends
the user's time.

A pure tool (tag `pure`) has hidden test cases in `holdout/`, which import
`./toolbox/<name>/impl.agency` and call `run`. The framework grades them
with `agency test --agency-only --reject '*'`, and the score is the passing
fraction. `holdout/` is never copied into the working directory. Each
test's `graderFiles/reference.agency` is a tool that passes all of its
cases; rerun the cases against it after changing them.

A tool with no fixed output (tags `effectful`, `outside-info`) uses
`toolJudge` (`lib/toolJudge.ts`): a rubric judge with a reference solution.

Rounds, cost, and time are in each run's record and are reported, not
scored.

## Baseline

Three trials on gpt-5-mini, 2026-09-19, $0.73 for the run and $0.02 to
grade it:

| test | score |
| --- | --- |
| column-stats | 0.905 ± 0.095 |
| email-note | 0.556 ± 0.222 |
| slugify-title | 0.810 ± 0.095 |
| split-bill | 1.000 ± 0.000 |
| topic-news | 1.000 ± 0.000 |
| webhook-notify | 1.000 ± 0.000 |
| all | 0.878 ± 0.019 |

Two email runs saved nothing: the author gave up after three rounds of
parse errors, one on an `if` body and one on a `match` arm. Two slug runs
saved a tool that the hidden cases could not compile, with
`AG4007: Variable 'as' is not defined`. `designTool` accepted those tools,
so its own checks are looser than the sandboxed compile the cases use.
