# Baselines for the agency-agent suite

Inventory taken on 2026-09-27, before fixing the routing failure in trace
`idCkNs33UwMumDgWbdCBm`. The local `runs/` tree contains four runs from
this suite. Two contain usable results:

| Test               | Run directory                                      | Harness version | Models recorded                                 | Score  | LLM calls | Time   | Cost  |
| ------------------ | -------------------------------------------------- | --------------- | ----------------------------------------------- | ------ | --------- | ------ | ----- |
| packaging-decision | `runs/2026-09-01-135445-KZOiTD/packaging-decision` | 0.17.1          | claude-sonnet-5 (53 calls), claude-opus-4-8 (1) | 0.7424 | 54        | 11m35s | $4.98 |
| ask-before-tool    | `runs/ask-before-tool-smoke/ask-before-tool`       | 0.21.0          | claude-opus-4-8                                 | 1.00   | 1         | 6s     | $0.08 |

`runs/packaging-decision-local/packaging-decision` and
`runs/2026-09-01-135358-ptRk6x/packaging-decision` ended with errors before
writing a trace. They provide no agent-performance baseline. The other
run groups inspected under `runs/` belong to different suites, including
the standalone coding, research, and writing agents.

These results used different versions and model configurations. Neither
is a full-suite baseline, and the new `verify-agency-project` case has no
previous eval run. Keep the historical results, but collect a fresh
baseline with the same model and settings used for the candidate change.
The run directories are local, gitignored artifacts; this document does
not distribute their contents.

## The reported conversation

The original trace was copied from `log.jsonl` into
`runs/agency-agent-incident/idCkNs33UwMumDgWbdCBm/statelog.jsonl` so it
survives log rotation. It records 85 completed model calls and about
$6.94. The two unsuccessful build dispatches took about 17m28s and
contained 62 completed model calls. The full conversation includes long
waits for user input, so its total elapsed time is not comparable to a
one-shot eval. It has no score against the new fixture.

## Run a comparable baseline and candidate

### Local run excluding Python tasks

The local baseline in `runs/agency-agent-before-non-python-glm` selects
`ask-before-tool`, `fib`, `hollow-creek`, `identity`, `news`,
`packaging-decision`, `run-on-openrouter`, and `verify-agency-project`.
It excludes `cert-and-checker`, `count-by-window`, `name-the-weakness`,
and `pack-archive`, which request Python source changes or new scripts.

This run uses `--policy with-writes`, a fresh agent home inside each
test's workdir, OpenRouter `z-ai/glm-5.3-flash`, one trial, and two workers.
Its effective limits are $5 per test, a $25 batch stopping threshold,
and 15 minutes per test, read from the package's `agency.json`.
The launch script attempted a lower batch limit through
`AGENCY_CONFIG_OVERRIDES`, but that variable applies to compiled runtimes,
not the CLI supervisor. Set supervisor options in an explicit `-c` config
file when changing them. In-flight tests and calls can overshoot the
batch threshold, and grading costs are separate.
Use the same policy and fresh homes for the candidate run. Its results
are a baseline for these eight tests, not for the full twelve-test suite.
The new verification case still requests compiler and test commands;
record any capability or policy refusals when interpreting its result.

The exact invocation, source hashes, settings, build output, and run log
are saved under `runs/verification-checks/non-python-baseline*`,
`runs/verification-checks/run-non-python-glm-baseline.sh`, and
`runs/verification-checks/local-*.log`. These are local, gitignored files.

All eight selected tests ran and reached the 15-minute process timeout.
Six traces recorded `agentEnd` before their processes were killed; for
example, `identity` recorded its answer in about four seconds. Grading
assigned every run zero and skipped the test-specific checks because
the harness outcomes were timeouts. This is evidence of failed process
completion, not a usable comparison of answer quality. The shutdown
cause was reproduced with a canned model response: the agent's root
time-budget timer remained active after the final reply. The creation
stack led through `Runner.beforeStep` in the final `onNodeEnd` hook.

The retained run recorded $0.212453 in API cost, with no grading cost.
The new regression called `codeAgent` with `agencyTask: true` for the
compile request. That tool reported writing a generated Agency program
to `build.log`, which contained only a newline. No compiled module,
test report, test log, or verification JSON was produced. The seeded
source files were unchanged. This reproduces the reported routing
failure independently of the process-exit problem.

The per-test report is
`runs/verification-checks/non-python-baseline-report.md`; its adjacent
`non-python-baseline.glm.results.json` contains the final replies and
harness errors. Fix or account for process completion before using the
suite's scores to compare agent changes.

The earlier groups `agency-agent-before-non-python` and
`agency-agent-before-non-python-corrected` are discarded setup attempts.
Their main calls used GLM, but background memory calls still used the
compiled default, `gpt-5-mini`. They recorded about $0.0305 in total.
Changing the launch environment alone did not change that compiled
default. The baseline recompiles the stdlib, agent, and judges with
`runs/verification-checks/glm-config.json` and verifies the generated
model and provider before starting. Retain those attempts for diagnosis,
but exclude them from the before/after comparison.

### Corrected launch configuration

Omit `agency agent --max-time` for this comparison. The eval supervisor
still enforces the 900-second process timeout and kills the entire
process group when it expires. Keep `--max-cost 5` on the agent and
`eval.limits.maxCostUsd: 5`, `maxBatchCostUsd: 25`, and
`wallClockSec: 900` in the explicit supervisor config. Use this same
configuration for both baseline and candidate; it needs no agent or
runtime source changes.

With the corrected launcher, the real `identity` smoke test completed
in 18 seconds and received a goal score of 1.0. Its raw run and grading
are in `runs/agency-agent-glm-identity-smoke` and
`runs/verification-checks/identity-smoke.grades.json`. The no-cost
reproduction and timer stack are saved under
`runs/verification-checks/exit-probe*`; the diagnosis is in
`runs/verification-checks/process-exit-diagnosis.md`.

The replacement eight-test run uses
`runs/verification-checks/run-non-python-clean-baseline.sh` and writes to
`runs/agency-agent-before-non-python-clean`. The earlier timeout group
is retained for diagnosis and excluded from performance comparisons.
The timer leak itself still needs a separate runtime fix and regression
test.

The replacement run completed on 2026-09-27. All eight cases ran once;
four completed normally and four timed out without recording a final
answer. The mean score was 0.467. Recorded execution cost was $0.144429,
and grading cost was $0.002075.

| Test                  | Outcome   | Score | Model calls |
| --------------------- | --------- | ----: | ----------: |
| ask-before-tool       | Timeout   | 0.000 |           9 |
| fib                   | Timeout   | 0.000 |          33 |
| hollow-creek          | Completed | 0.950 |           2 |
| identity              | Completed | 1.000 |           1 |
| news                  | Completed | 0.867 |           4 |
| packaging-decision    | Completed | 0.920 |           8 |
| run-on-openrouter     | Timeout   | 0.000 |          29 |
| verify-agency-project | Timeout   | 0.000 |          24 |

The new verification case dispatched `codeAgent` with `agencyTask: true`
twice. Neither dispatch produced the compiled module, build log, test
report, test log, or exit-code JSON. Input source files remained unchanged.
The trace also recorded parse and structured-output validation failures.
This gives the routing fix a concrete target: complete verification and
save real results, rather than repeatedly asking a source writer to do it.

The other timeouts identify separate behaviors: `ask-before-tool`
proceeded to `writeToolFor` without obtaining the missing facts; `fib`
spent 33 model calls without completing; `run-on-openrouter` made 29
calls and extensive documentation searches instead of finishing its
restart instructions. None recorded `agentEnd`, so these timeouts are
different from the completed-answer timer leak in the discarded run.

The report is `runs/verification-checks/non-python-baseline-clean-report.md`.
Adjacent `.clean.results.json`, `.clean.grades.json`, `.clean.failures.json`,
and `.clean.sources.json` files preserve replies, grades, tool arguments,
errors, and source hashes. One trial per case provides a comparison point,
not a reliable estimate of success rates.

### Verification fix: isolated regression run

Before the full candidate comparison, `verify-agency-project` completed in
256 seconds for $0.1034 using the same model and policy. All correctness
gates passed: compiled output, actual passing test results, unchanged input
files, and an accurate final report. Its weighted score was 0.992; the
remaining deduction was for calls, time, and cost. This isolated run used
one worker and is a smoke check, not the full-suite comparison.

Artifacts: `runs/agency-agent-after-verification-smoke-network/` and
`runs/verification-checks/verification-candidate.smoke.grades.json`.
An earlier attempt without network access was stopped before any model
completion and is excluded (`agency-agent-after-verification-smoke`).

### Full non-Python candidate comparison

The candidate completed all eight attempts with the same settings as the
baseline. Mean score rose from **0.467 to 0.571**. Execution cost
rose from **$0.144429 to $0.493662**; grading cost was
$0.006901. Seven processes finished, but only five tests had
nonzero scores. A completed process is not necessarily a successful task.

| Test | Baseline score | Candidate score |
| --- | ---: | ---: |
| ask-before-tool | 0.000 | 0.000 |
| fib | 0.000 | 0.000 |
| hollow-creek | 0.950 | 0.875 |
| identity | 1.000 | 1.000 |
| news | 0.867 | 0.000 |
| packaging-decision | 0.920 | 0.800 |
| run-on-openrouter | 0.000 | 0.900 |
| verify-agency-project | 0.000 | 0.990 |

The verification regression passed every correctness gate in both the
isolated smoke run and the full comparison. The full-suite attempt finished
in 364 seconds, used 21 model calls, and cost $0.117488. It compiled and tested
the fixture, saved actual output, and preserved the input files.

Three cases still failed. `ask-before-tool` asked a question but proceeded
without an answer, invented mail configuration, and timed out after 48
calls. `fib` received an empty provider completion and never dispatched the
coding worker or wrote the file. `news` returned a digest after 12m23s,
failing its required five-minute gate; its content was not graded after
that failure. The tool-writing and news cases account for most of the
increased spending. Changes on routes that were not edited can reflect
model variability; one trial does not establish their cause.

These results support the verification fix, not a claim that all agent
behavior is fixed. The next work is to stop implementation when required
user facts are missing, handle empty model/worker results, and enforce
stated deadlines before further delegation.

Full report: `runs/verification-checks/agency-agent-comparison.md`.
Raw candidate runs: `runs/agency-agent-after-non-python-clean/`.
The adjacent candidate settings, source hashes, diff, grades, and trace
findings preserve the comparison. The build, type checks, 70 TypeScript
unit tests, 37 focused Agency cases, five grader tests, formatting, and
focused structural lint passed. No Python-requesting cases or full local
Agency test suite were run.

### Full suite in Docker

No fresh full-suite baseline has been collected. The Docker wrapper
isolates the agent only. The Python graders run on the host, and several
execute the agent's generated scripts. Isolate that grading step too
before running all twelve tests on unreviewed output.

Configure the model at compilation time as well as through the agent's
model flags: background memory calls use the compiled client defaults.
Use an explicit CLI config for compilation, the eval supervisor, and
grading. Setting AGENCY_CONFIG_OVERRIDES alone does not change the CLI's
resolved configuration. Rebuild the image after changing agent sources
or compilation settings, and retain its image ID.

### Comparing runs

Keep the selected tests, model, policy, fresh agent homes, limits, trials,
and worker count fixed between the baseline and candidate. Save the Git
revision, uncommitted diff, and compilation config with each group.
Output directories must not already exist.

The spending limits are approximate. The per-test limit reacts after a
completed model call. The batch limit sums completed tests and stops
starting new tests once spending exceeds its threshold; in-flight tests
continue under their individual caps. Grading is a separate command and
is outside those execution budgets. Hitting the batch limit can leave
part of the suite unrun; report that as an incomplete comparison.

The installed OpenRouter client reads the provider's usage.cost field.
Cost tracking does not depend on a local price entry for this model.
Compare each test's pass rate, score, model calls, time, and dollars.
The grading engine stops at a failed correctness gate, so advisory
economy grades may be absent for failures. Their raw metrics remain
available in the statelog and runs list output. Include failures in
cost and time comparisons.
