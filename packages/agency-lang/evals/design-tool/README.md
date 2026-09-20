# design-tool: an eval suite for `designTool`

`designTool` in `std::toolbox` has a coding agent draft a tool, runs
generated tests against the draft, and has the user accept it.
This suite scores that whole loop on a fixed set of tool requests, so a
change to the brief, the checks, or the loop can be measured instead of
tried once by hand.

## Run it

```bash
pnpm run agency eval run \
  evals/design-tool/agent.agency:main \
  --suite evals/design-tool \
  --out runs/design-tool

pnpm run agency eval grade runs/design-tool
```

A run stores a copy of its graders. After changing a grader, add
`--suite evals/design-tool` to the grade command to use the current ones.

Add `--trials 3` for means with error bars, and `--test email-note` to run
one test. A test costs about as much as one real `designTool` call, around
two cents on gpt-5-mini.

## The contract

A test's input is what a caller passes `designTool`, plus what the pretend
user knows (`DesignInput` in `agent.agency`):

```
{ "name": string, "purpose": string, "request": string, "facts": { [name]: string } }
```

`main` in `agent.agency` plays the user. It answers every `std::question`
with all of the test's facts, because it cannot tell which fact a question
is after, and no model is involved in the answer. It accepts the first
draft it is shown. It approves the toolbox's own effects, the run of a
draft's generated tests, and reads of the packaged docs. It rejects
everything else, so an author that goes looking through the file system
finds nothing.

The saved tool lands in `toolbox/<name>/impl.agency` in the run's working
directory. The node's output is a `DesignLog`: whether the tool was saved
and the error if not, every question asked, the last draft the user saw,
and the effects `main` refused.

## Grading

Every test carries `saved` (`lib/saved.ts`): a run that saves nothing has
failed.

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

`triage-tickets` (tag `model`) has hidden cases too, but its tool calls a
model, so the cases measure how well the tool works and not only whether
the code is right. Each case hands the saved tool one support message and
compares the category, or the urgency, with the one the support team
would give. Many of the messages turn on house rules that are in the
test's facts and not in the purpose, so a tool whose prompt says only
"sort this message" gets them wrong. The cases call `setModel` to run the
tool on a small model: a tool is worth writing when the work a strong
model put into it makes a weak model good. The cases make real model
calls, about 30 per graded run.

A tool with no fixed output (tags `effectful`, `outside-info`) uses
`toolJudge` (`lib/toolJudge.ts`): a rubric judge with a reference solution.

Rounds, cost, and time are in each run's record and are reported, not
scored.

## Baseline

Three trials on gpt-5-mini, 2026-09-19. The first column is `designTool`
as it ships. The second has its review agent on (`review: true`). Both
were graded with a grader for the reviewer's findings that has since been
removed. It passed every run in the first column.

| test | score | with the review agent |
| --- | --- | --- |
| column-stats | 0.905 ± 0.095 | 0.905 ± 0.095 |
| email-note | 0.556 ± 0.222 | 0.556 ± 0.222 |
| slugify-title | 0.905 ± 0.095 | 0.810 ± 0.095 |
| split-bill | 1.000 ± 0.000 | 1.000 ± 0.000 |
| topic-news | 1.000 ± 0.000 | 1.000 ± 0.000 |
| webhook-notify | 0.975 ± 0.025 | 1.000 ± 0.000 |
| all | 0.890 ± 0.029 | 0.878 ± 0.019 |
| time per tool | 85s | 187s |
| cost per tool | $0.014 | $0.041 |

The failures are the same kind in both columns. An author gives up after
three rounds of parse or type errors, or saves a tool that the hidden
cases cannot compile: a TypeScript `as` cast, which Agency reads as two
undefined names, or a JavaScript global the sandbox does not allow.
`designTool` accepts those tools because its own compile leaves the
undefined-name check off.

### triage-tickets

Three trials each, 2026-09-19. The hidden cases ran on gpt-5-nano.

| author | asked the user | hidden cases | score |
| --- | --- | --- | --- |
| gpt-5-mini | 0 of 3 | 0.667, 0.800, 0.867 | 0.593 ± 0.020 |
| gpt-5.6-sol | 0 of 3 | 0.733, 0.767, 0.767 | 0.585 ± 0.004 |
| `graderFiles/reference.agency` | | 0.933 | |

Neither author asked a question, so both guessed the house rules. Every
saved tool called a vague "it does not work" message a bug, and most rated
a bug in one feature as urgency 3. The reference tool has the test's facts
in its prompt and misses 2 of 30. The same authors do ask in `email-note`,
where a fact such as an address is plainly missing. Here nothing looks
missing, because a model can always make up a definition.

