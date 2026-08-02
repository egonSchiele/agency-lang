# terminal-bench-mini

Terminal-bench tasks re-expressed as Agency eval suites, so we can benchmark
Agency agents with `agency eval run` instead of the Harbor/Docker harness.

These tests are hard on purpose — they measure how good an agent is. When you
need to know whether the harness itself is working, run `evals/smoke` instead:
four small deterministic tests, each with a no-LLM reference solution.
We port the useful parts, not the packaging: each task keeps its original
instruction and verifier logic, adapted where the original assumed Python or
absolute container paths (`/app/...` becomes the run's working directory).

Tasks so far:

- `regex-log/` — write a regex to `regex.txt` matching the last `YYYY-MM-DD`
  date on log lines that contain a valid IPv4 address. No fixture files; the
  whole task is the instruction. The test's own grader
  (`regex-log/graders.ts`) ports the original pytest verifier's 25 sample
  lines and expects the same all-or-nothing match list, applied with
  JavaScript RegExp semantics instead of Python `re`.
- `gcode-to-text/` — read a Prusa G-code file and figure out what text the
  print head traces; write it to `out.txt`. One vendored fixture
  (`files/text.gcode`, decompressed the way terminal-bench's image presents
  it). Terminal-bench labels it medium, and our agent has historically
  engaged hard without landing the exact answer — a good discriminator. The
  grader compares a sha256 of the trimmed output rather than the answer
  itself: this repo is public, and the expected text IS the answer, so no
  plaintext answer and no `solution.agency` for this one (both would leak
  benchmark data the fixture's canary asks to keep out of corpora).

Run it against an agent whose entry node takes the task text as its argument
(`node main(task: string)`):

Each test carries its own `graders.ts` beside its `test.json` — the loader
picks it up automatically, so there is no suite-level grader to name:

```bash
# the whole suite
agency eval run --agent path/to/agent.agency:main \
  --inputs evals/terminal-bench-mini

# one test
agency eval run --agent path/to/agent.agency:main \
  --inputs evals/terminal-bench-mini/regex-log
```

Agent runs get 60 seconds of wall clock by default, which a real tool-loop
agent will exceed; the repo `agency.json` raises it to 900s (terminal-bench's own budget) via `eval.limits.wallClockSec`.

To benchmark the bundled agency agent (`agency agent`) itself, use a command
target — the agent's own statelog becomes the eval record:

```bash
# absolute path inside --agent-cmd: the command runs with the isolated
# workdir as its cwd, so a relative dist/ path would not resolve
node dist/scripts/agency.js eval run \
  --agent-cmd "node $PWD/dist/scripts/agency.js agent --agent code --policy approve-all --max-tool-call-rounds 100 --verbose -p -- {task}" \
  --inputs evals/terminal-bench-mini
```

See "Command agents" in `docs/site/cli/eval.md` for the rules (headless
one-shot required, no `--log` in the command, agent flags go inside the
command).

Tasks that need environment *setup* (running a script to manufacture broken
state, e.g. fix-git's dangling commit) are not portable yet — the eval
framework only seeds static files. Punted deliberately; see the input `files`
mechanism in `lib/eval/loadInputs.ts` if you're adding one.
