# Command agents: running a CLI under `agency eval run`

`--agent-cmd '<command with {input}>'` runs a CLI as the agent instead of
compiling an `.agency` file (the positional `<agent>` argument) — the way
the bundled `agency agent` is benchmarked. This page is the architecture; user-facing rules live in
`docs/site/cli/eval.md` ("Command agents").

## The target union

`resolveEvalTarget` (`lib/agentTarget.ts`) returns a discriminated union:

```ts
type EvalTarget =
  | { kind: "file"; agentFile: string; node: string; label: string }
  | { kind: "command"; tokens: string[]; label: string };
```

"What runs and what evidence it produces" is a property of the target
kind. A future non-Agency variant (no statelog, output-only grading) would
be a third kind — that is the extension point, deliberately unbuilt.

Commands come ONLY from the CLI flag, never from suite content: suites can
be remote git sources, and a suite that named its own agent command would
be remote code execution by suite. (Graders are the deliberate exception —
they are test-side code, and pulling a suite means trusting it.)

## Tokenize, then substitute

The command string is tokenized by a tarsec grammar
(`lib/eval/run/commandLine.ts`): whitespace splits, single/double quotes
group, adjacent chunks join (`--flag="a b"` is one token), and NOTHING
shell-like — no expansion, operators, or escapes, because no shell ever
runs. `{input}` substitution happens AFTER tokenization, per token, so a
hostile task is inert bytes inside one argv entry. `{input}` is required
exactly when the tests carry an input, and refused when they carry none —
`assertTargetMatchesInputs` (`lib/agentTarget.ts`) checks that once, before
any run, for command and file agents alike; an object task substitutes as
JSON. Two hard-won notes in
the file: tarsec's `between(char, char, manyWithJoin(noneOf))` takes ~14s
to FAIL on an unclosed quote (pathological backtracking) — `quotedString`
with a first-char guard is used instead; and the argv byte total is capped
before spawn (the OS's own failure is an opaque E2BIG).

## One pipeline, two runners

`runAgent` (`lib/eval/run/runAgent.ts`) serves both kinds; only two steps
branch. Seeding: command targets copy the input's `files` plus the
invoking cwd's `agency.json`/`.env` (`commandFilesToCopy`) and compile
nothing. Execution: file jobs fork over IPC (`makeSubprocessRunner`),
command jobs spawn (`runCommandInSpawn`, `lib/eval/run/spawnRunner.ts`).
Extraction, salvage, and error-writing are one shared path — that is the
reason to branch inside one pipeline rather than fork a parallel runner
class.

## The statelog handoff (why the eval record is the agent's record)

The spawn runner sets two env vars:

- `AGENCY_CONFIG_OVERRIDES` → `{ observability, log.logFile: <harness
  statelog path> }`. Every compiled Agency process applies this at
  RuntimeContext construction, and the var inherits through intermediate
  processes (the `agency` CLI wrapper is not a compiled agent; the
  `agent.js` it spawns is). So the agent's own record — tool calls, cost,
  interrupts, its whole process tree — lands exactly where the harness
  folds it into the run directory, and grading/judging work unchanged.
- `AGENCY_TRACE_ID` (`lib/config.ts`) → one trace id for the whole tree,
  ROOT INCLUDED: the harness mints the id (`runSuite`), and
  `resolveInvocation` (`lib/runtime/invocationOptions.ts`) uses it for a
  fresh run below an explicit per-invocation `traceId` and above `nanoid()`
  (before 2026-08-18 only the context-level client honored it, so the root
  run of a command agent minted its own id and the harness could not key
  its workdir). IPC descendants inherit identity anyway; the env var covers
  descendants started WITHOUT IPC (an agent shelling out to `agency run`).
  The eval FORK runner deletes this var from file-target child env
  (`evalForkOptions`) and passes the minted id as `identity.runId` on the
  run instruction instead, so a stray value cannot merge unrelated runs.

Two sharp edges, both mitigated: `runBundledAgent` merges flag-derived
config overrides ONTO the inherited env value ("env first, flags on top"),
so `--trace` in a command survives the handoff — but an explicit `--log`
still wins the logFile key, and the resulting missing-statelog error names
that cause. Concurrent line-appends to the shared statelog stay parseable
(per-event `appendFileSync`); writes are sequential in the dominant case
(parents block on children).

One more consequence of "the record is the agent's record": grading reads
the agent's OUTPUT from the statelog too, never from stdout. A grader's
`output` is the last `evalOutputRecorded` event (`lastOutput` in
`lib/eval/run/runAgent.ts`; `gradeRun` reads `evalOutputs` the same way).
So a command agent must call `evalOutput(reply)` (and `evalValue(prompt)`
for the input) from `std::statelog`, or every judge sees `output: null`.
The Agency agent does this in `oneShotAgent` (`agent.agency`), which also
keeps the recorded output clean — the `Session cost` trailer is printed
after the reply is recorded.

## Process-group lifecycle (the part that bites)

The spawned command is `detached: true` — its own process group — and
every kill is a GROUP kill (`kill(-pid)`): wall clock, cost cap, and
signal forwarding. The bug this fixed: killing only the direct child left
the CLI wrapper's grandchild (the actual agent) running and spending for 8
more minutes, holding the harness's pipes open so `close` never fired.

Detaching removes the tree from the terminal's foreground group, so the
harness's forwarding IS the delivery mechanism: SIGINT, SIGTERM, and
SIGHUP are forwarded as group kills, and a `process.on("exit")` hook reaps
the group with SIGKILL on any harness death. The one hole no supervisor
can close is SIGKILL of the harness itself — the orphaned tree's remaining
protection is EPIPE on its next write to the dead pipes. (File targets are
safer here: IPC children carry a disconnect watchdog and die with their
parent no matter how it dies; that chain covers every money-spending
descendant.)

Limits: `wallClock` from `eval.limits.wallClockSec` (per-test `timeoutSec`
overrides it), enforced by a SIGTERM-then-SIGKILL timer. Memory via
`NODE_OPTIONS --max-old-space-size` — V8 heap of Node processes only,
weaker than the fork sandbox, acceptable because command targets are
Agency (Node) CLIs. Stdout is drained always (an unread pipe blocks a
chatty agent at ~64KB) and capped for display only — a deliberate
divergence from the fork runner, which FAILS the run at its stdout limit;
a benchmark must not zero a chatty-but-correct agent.

## Cost

The cost cap (`eval.limits.maxCostUsd`, default $50) has two feeds sharing
`makeCostCapTracker` (`subprocess.ts`): the fork runner bills the IPC cost
telemetry every child streams (`handleTelemetryMessage`'s pattern), and
the spawn runner tails the statelog (`makeStatelogCostTailer`,
`lib/eval/run/costTail.ts` — promptCompletion events carry per-call cost).
The same tailer feeds the parallel status board's live cost column.
Enforcement lags by one LLM call; it is an accident stopper, not a budget.

## Provenance

Command runs record the command string verbatim (keep credentials in the
environment, never argv), the harness version, and — when the command
invokes the agency CLI — that CLI's `--version`. This trades away file
targets' sha-comparability (#733); the versions are what anchor
comparisons over time.
