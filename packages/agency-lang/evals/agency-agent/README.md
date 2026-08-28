# agency-agent: an eval suite for the agency agent

Scores `agency agent` as a whole, one brain at a time, on tasks shaped like
the ones it fails on Terminal-Bench 2.0. The tasks are ours: the benchmark's
own tasks carry a do-not-copy canary, so each test here reproduces a failure
pattern from the July benchmark runs with different code and data.

## Run it

The agent writes and runs Python, so it runs in a container. Build the image
once per change to `lib/` or `stdlib/` (it packs the working tree):

```bash
make eval-image
```

Then run the suite with the wrapper as the agent command. `{input}` is the
task text; everything after the script name goes to `agency agent`:

```bash
node dist/scripts/agency.js eval run \
  --agent-cmd 'evals/agency-agent/run-in-docker.sh --brain coordinator --policy approve-all --max-tool-call-rounds 100 -p -- {input}' \
  --suite evals/agency-agent --parallel 2 --out runs/agency-agent-coordinator
node dist/scripts/agency.js eval grade runs/agency-agent-coordinator
```

Grading also runs inside the image (`docker run ... pytest`), so Docker
must be up for `eval grade` too. `--policy approve-all` is right here for
the reason it is right on the benchmark: the container is disposable. The
wrapper mounts the run directory at its own absolute path inside the
container so the framework's statelog handoff keeps working; see the
comment at the top of `run-in-docker.sh`.

To compare brains, run twice with different `--brain` values and
`--trials 3`, and compare `mean` and the must-pass rate per test.

## The tests

Two older tests, `fib` and `news`, predate the Docker setup: `fib` is an
Agency coding task graded by its own harness and `news` a goal-judged
question. They run under the wrapper too. To run only the terminal-bench
shaped tests, pass `--test` for each of the four below.

| test                | pattern from the benchmark                                                                    | must pass                                    |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `pack-archive`      | output contract skimmed: an entry cap that applies to the output root too (`reshard-c4-data`) | round trip, caps                             |
| `cert-and-checker`  | deliverable depends on a package the agent installed (`openssl-selfsigned-cert`)              | cert fields, checker runs under `python3 -I` |
| `name-the-weakness` | exact id in the report; two plausible wrong ids (`fix-code-vulnerability`)                    | repo tests pass, id exact                    |
| `count-by-window`   | off-by-one at a date-window edge (`log-summary-date-ranges`)                                  | CSV exact                                    |

## Grading

Each test's checks are a pytest file, `graderFiles/test_outputs.py`, the
shape the benchmark's own verifiers have. `lib/checks.ts` runs it inside
the image with the workdir mounted and turns each pytest function into one
grader score, named by dropping `test_` and swapping underscores for dashes.
The agent never sees `graderFiles/`. Where a check needs data the agent must
not have seen, the check generates it at grade time (`gen.py` with another
seed).

Two harness graders run on every test at low weight: `rounds-used` and
`wall-seconds`, so a brain that reaches the same score with more turns or
more time shows it.

Every test keeps a reference solution under `graderFiles/solution/`
(`solve.sh` applies it to a workdir). `lib/checks.test.ts` grades each
solution and each untouched starting tree in local mode, so a check that
passes an empty workdir cannot land. That test needs `python3 -m pytest` on
the host and skips, saying so, when it is missing.
