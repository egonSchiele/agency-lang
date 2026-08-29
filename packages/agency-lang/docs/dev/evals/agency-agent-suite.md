# The agency-agent eval suite

`evals/agency-agent/` scores `agency agent` as a whole, one `--brain` at a
time, on tasks shaped like the ones it fails on Terminal-Bench 2.0.

## Why the agent runs in Docker

The tasks are Python, and Python the agent writes can do anything, so the
agent runs in a container we own (`evals/agency-agent/docker/Dockerfile`,
built by `make eval-image` from a tarball of the working tree). The
framework runs any CLI as the agent (`eval-command-agents.md`), so the
agent command is `run-in-docker.sh`, a `docker run` wrapper.

The framework hands a command agent the host path of the statelog it must
write, in `AGENCY_CONFIG_OVERRIDES`, and runs it in the run's `workdir/`.
The wrapper mounts the run directory at the same absolute path inside the
container, so that path is valid on both sides and grading reads the
agent's output as usual. Skip that and every judge sees no output.

## Why the checks are pytest files

Terminal-bench verifies a task by running `tests/test_outputs.py` with
pytest over the container's files. The suite keeps that shape: each test's
checks are `graderFiles/test_outputs.py`, run by `lib/checks.ts` inside the
same image with the workdir mounted, and each pytest function becomes one
grader score by name. Reading a check as a plain test is the point; a
grader in TypeScript that shells out per assertion would say the same
thing less directly.

`graderFiles/` is never seeded into the workdir. Where a check needs data
the agent must not have seen, it runs the test's `gen.py` with another seed
at grade time.

## The discrimination test

`lib/checks.test.ts` applies each test's reference solution
(`graderFiles/solution/solve.sh`) to a copy of its starting tree and grades
both the solved and the untouched copies in local mode: the solution must
pass every check, the untouched tree must fail every must-pass check. It
needs `python3 -m pytest` on the host; the unit-test workflow installs
pytest so the test runs in CI rather than skipping.

## Files

- `evals/agency-agent/lib/checks.ts` — pytest runner, JUnit parsing, one grader per check, the two harness graders
- `evals/agency-agent/run-in-docker.sh` — the `--agent-cmd` wrapper
- `evals/agency-agent/docker/Dockerfile` — the image; `make eval-image` builds it
- `evals/agency-agent/<test>/` — `test.json`, `files/`, `graderFiles/{test_outputs.py,solution/,gen.py}`, `graders.ts`
