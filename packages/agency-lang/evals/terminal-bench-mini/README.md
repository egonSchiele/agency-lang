# terminal-bench-mini

Terminal-bench tasks re-expressed as Agency eval suites, so we can benchmark
Agency agents with `agency eval run` instead of the Harbor/Docker harness.
We port the useful parts, not the packaging: each task keeps its original
instruction and verifier logic, adapted where the original assumed Python or
absolute container paths (`/app/...` becomes the run's working directory).

Tasks so far:

- `regex-log/` — write a regex to `regex.txt` matching the last `YYYY-MM-DD`
  date on log lines that contain a valid IPv4 address. No fixture files; the
  whole task is the instruction. The grader (`graders.ts`) ports the original
  pytest verifier's 25 sample lines and expects the same all-or-nothing match
  list, applied with JavaScript RegExp semantics instead of Python `re`.

Run it against an agent whose entry node takes the task text as its argument
(`node main(task: string)`):

```bash
agency eval run --agent path/to/agent.agency:main \
  --inputs evals/terminal-bench-mini \
  --graders evals/terminal-bench-mini/graders.ts
```

Agent runs get 60 seconds of wall clock by default, which a real tool-loop
agent will exceed; the repo `agency.json` raises it via `eval.limits.wallClockSec`.

To benchmark the bundled agency agent (`agency agent`) instead of an .agency
file, use the `agency-agent.agency` wrapper — it execs the agent CLI one-shot
inside the workdir, terminal-bench-adapter style, and the graders read what it
leaves behind. Point `AGENCY_CLI_JS` at a local build:

```bash
AGENCY_CLI_JS=$PWD/dist/scripts/agency.js \
  agency eval run --agent evals/terminal-bench-mini/agency-agent.agency:main \
  --inputs evals/terminal-bench-mini \
  --graders evals/terminal-bench-mini/graders.ts
```

The eval record covers only the wrapper's single exec call; the inner agent's
real tool-call evidence lands in `agent-cli-statelog.jsonl` in the workdir.

Tasks that need environment *setup* (running a script to manufacture broken
state, e.g. fix-git's dangling commit) are not portable yet — the eval
framework only seeds static files. Punted deliberately; see the input `files`
mechanism in `lib/eval/loadInputs.ts` if you're adding one.
