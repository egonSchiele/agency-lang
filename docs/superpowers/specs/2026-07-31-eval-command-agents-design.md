# Command agents: benchmarking a CLI under `agency eval run`

**Status:** draft for review
**Depends on:** the input-format cleanup (PR #739) — inputs carry a `task`;
nothing in a test describes the agent.
**Scope decision (already made):** Agency-CLI agents only. The command must
start an Agency process, because the evidence contract (the statelog) comes
from the Agency runtime. Arbitrary/non-Agency agents are future work; the
target model below is shaped so they can be added without rework.

## Background: the two shapes of "an agent"

The eval framework's only agent target today is an `.agency` file:
`runSuite` walks its import closure, seeds it into an isolated workdir,
compiles it there, forks a subprocess, and invokes a node with the input's
task. Its statelog becomes the eval record; graders read the record and the
workdir.

But our flagship agent is not invoked that way. `agency agent` is a CLI: it
spawns the precompiled bundle in `lib/agents/agency-agent/` with forwarded
argv (`--agent code`, `--policy approve-all`, `-p <prompt>` for one-shot).
There is no node to point `--agent` at — the agent parses its own flags,
manages its own home directory, selects its own subagent. To benchmark the
thing users actually run, the eval framework must be able to run **a
command** rather than compile a file.

This is exactly Harbor's model (the harness terminal-bench runs on): an
agent is an install step plus a run command; the task substitutes into the
command; the harness runs it in the task environment and grades what it
left behind.

## The rejected design, for the record

A wrapper `.agency` agent that `exec()`s the CLI was built and reverted
(#738 review). Its flaw: the eval record captured one `exec` call — the
agent's real behavior (tool calls, cost, interrupts) was invisible to
graders, judges, and the optimizer. It treated our own agent as a black
box when everything already speaks statelog natively. The design below is
that wrapper done right: the framework runs the command itself and hands
the child the statelog path, so the eval record **is the agent's record**.

## CLI surface

```bash
agency eval run \
  --agent-cmd 'agency agent --agent code --policy approve-all --max-tool-call-rounds 100 -p -- {task}' \
  --inputs evals/terminal-bench-mini \
  --graders evals/terminal-bench-mini/graders.ts
```

- `--agent-cmd <string>` — mutually exclusive with `--agent`; exactly one
  is required. The string is tokenized by a minimal shell-like splitter:
  whitespace separates tokens, single and double quotes group them, and
  **nothing else** — no variable expansion, no globbing, no subshells,
  because the command never passes through a shell.
- `{task}` must appear at least once (its absence is an error — a command
  that never receives the task is the silent-drop bug in new clothing). It
  may appear anywhere inside any token (`-p={task}` works); every
  occurrence is replaced. A string task substitutes as its text; an object
  task substitutes as its JSON serialization.
- Substitution happens **after** tokenization, so a task containing
  quotes, spaces, or leading dashes lands as (part of) exactly one argv
  entry and can never re-split the command. And because no shell ever
  runs, a hostile task is inert: `; rm -rf /` inside a task is four bytes
  of argv, not a command — there is nothing to interpret it. The `-p --`
  idiom in the example guards dash-leading tasks at the agent's own
  parser, a lesson from the terminal-bench adapter.
- `agency eval optimize` does not accept `--agent-cmd` in this iteration:
  the optimizer mutates *agent files*, which a command target does not
  expose. It errors with that explanation.

## The target model

`resolveEvalRunTarget` today returns `{ agentFile, node, label }`. It
becomes a discriminated union — "what kind of thing runs, and what
evidence it produces" is a property of the target:

```ts
export type EvalTarget =
  | { kind: "file"; agentFile: string; node: string; label: string }
  | { kind: "command"; argv: string[]; label: string };  // label = the original string
```

`runSuite` accepts the union (the CLI resolves flags into it). Everything
downstream that only reads `label` (summary.json's `agentLabel`) is
untouched. The `kind: "command"` arm is also where a future non-Agency
variant would live, carrying its own (weaker) evidence contract — that is
the extension point, deliberately not built now.

## What changes per pipeline stage

**Seeding.** A command target has no import closure and nothing to
compile: the workdir is seeded from the input's `files` plus the invoking
cwd's `PROJECT_CONFIG_FILES` (see "Workdir config files" below). The
seed-collision rule ("tests must not ship agent files") loses its object —
there is no agent ingredient to collide with — so the input's files are
simply copied. The one-parameter entry-node check
(`assertEvalEntryNodeTakesOneParameter`) does not apply; its analog is the
`{task}`-presence check at tokenization.

**Provenance.** `config.json` records the command string where it records
the agent closure today — which means command-target runs lose the
property provenance was built for (#733): "two runs are comparable exactly
when their shas match." Named as an accepted trade for v1, softened where
it is cheap: the record also carries the harness's own version and, when
the command's first token is the `agency` CLI, that CLI's `--version`
output — since comparing benchmark runs over time is the entire point of
the exercise. A content hash of the bundled agent is future work.

**Execution.** A new runner beside the fork runner. The current
`EvalInputRunner` signature is file-shaped (`compiledEntryPath`, `node`,
`task`); it generalizes to a per-kind union mirroring `EvalTarget` — the
runner receives either the compiled-entry description or the substituted
`argv`, plus the shared fields (`cwd`, `statelogPath`). `RunSuiteDeps.runner`
stays the single injection seam for tests. The command arm spawns:

```ts
spawn(argv[0], argvRest, {
  cwd: workdir,
  env: {
    ...process.env,   // API keys etc. inherit
    [CONFIG_OVERRIDES_ENV]: serializeConfigOverrides({
      observability: true,
      log: { logFile: statelogPath },   // the harness's expected path
    }),
  },
  stdio: pipeOutput ? "inherit-ish" : "pipe",
})
```

`spawn`, not `fork` — there is no IPC channel. Non-zero exit is an error
result, same as today. SIGINT forwarding matches the fork runner (which
forwards since #738); at a terminal the spawned child is in the same
process group, so it may be signalled twice — double-SIGINT on a dying
process is benign, and forwarding is what covers the programmatic-signal
case. runSuite's salvage-and-summary behavior is unchanged.

**stdio, precisely** (the fork runner gets this right by construction;
spawn must not get it wrong): with `pipeOutput` true, the child's stdout
and stderr pipe to the parent's, as the fork runner does. With
`pipeOutput` false, streams are still piped **and drained** — read,
counted against the `stdout` limit, and discarded — never left as unread
pipes, because a full ~64 KB pipe buffer blocks a chatty agent forever
and the wall clock would report a timeout with no cause. `agency agent`
is chatty; this is the default path, not an edge case.

**Which limits carry over.** The fork machinery enforces four
(`wallClock`, `memory`, `ipcPayload`, `stdout`). For command targets:

- `wallClock` — enforced by the runner: a timer sends SIGTERM, then
  SIGKILL after a grace period; the error names the limit (and notes that
  an interactive command waiting for input is a likely cause).
- `memory` — enforced via `NODE_OPTIONS=--max-old-space-size=…` in the
  child env, which every Node descendant honors. Effective exactly
  because the scope is Agency-CLI commands (Node processes); a future
  non-Agency target loses this and must say so.
- `stdout` — enforced on the drained streams.
- `ipcPayload` — not applicable; there is no IPC channel.

**Workdir config files.** File targets seed `agency.json`/`.env` from the
agent's `baseDir`; a command target has no `baseDir`, and config
resolution walking up from the workdir would otherwise find whatever
project happens to enclose the runs directory — a real behavioral
difference between two machines running the same benchmark. Rule: command
targets seed `PROJECT_CONFIG_FILES` from the **invoking cwd** when
present, so the config the benchmarker sees is the config the agent gets.
API keys ride `process.env` regardless.

**The label is stored verbatim — keep secrets out of argv.** `agentLabel`
in `summary.json` is the command string as typed, and run directories get
shared. No redaction is attempted (secret-shaped-flag heuristics rot);
instead the rule is stated in the CLI docs: credentials belong in the
environment, which the child inherits — never in the command.

**Invariant: the command comes only from the CLI flag.** Suites can be
loaded from remote git sources (#733). A suite that could name its own
agent command would be remote code execution by suite. `--agent-cmd` is
runner-side input, never suite content — recorded here so a future
"convenience" field doesn't look like a nice idea.

**Oversized tasks.** A JSON-serialized object task substitutes into argv
and is subject to the OS argument-size limit; the raw failure is an
opaque `E2BIG`. The runner checks the substituted command's total size
before spawning (conservatively, 128 KB) and errors naming the task and
its size.

**The statelog handoff — why this works.** Every compiled Agency process
reads `AGENCY_CONFIG_OVERRIDES` at RuntimeContext construction
(`lib/runtime/state/context.ts:263`) and honors `log.logFile` +
`observability`. The env var inherits through intermediate processes: the
`agency` CLI process itself is not a compiled agent, but the `agent.js` it
spawns is, and it sees the inherited var. So the agent writes its statelog
to exactly the path the record extractor reads, and grading/judging works
on it with zero changes — disk-first grading paying off again.

Two sharp edges. Review demanded evidence and fixes rather than
documentation, and got both:

1. **Flags in the command that rebuild the overrides env var.**
   `runBundledAgent` reconstructs `AGENCY_CONFIG_OVERRIDES` from `--log`/
   `--trace` when present (`lib/cli/runBundledAgent.ts:138-141`),
   *replacing* the inherited value instead of layering onto it. Fix, part
   of this feature and worth doing on its own merits (it repairs nested
   `agency run --log` outside eval too): parse the inherited env var and
   merge the flag-derived overrides on top — the same "env first, explicit
   on top" ordering `context.ts:263-267` documents for the runtime side.
   That fully cures `--trace` (it only adds trace keys; the inherited
   statelog path survives). It deliberately does **not** cure an explicit
   `--log`, because flags-win means `--log` still replaces `log.logFile` —
   an explicit statelog destination is user intent. So the second layer
   stays: when a command target produces no statelog at the expected path
   (already a hard error), the message appends "if your command passes
   --log, remove it — the harness sets the statelog path itself." A test
   pins that hint.

2. **Descendant processes share the statelog — verified by experiment,
   then closed structurally.** The experiment (a program calling
   `std::agency.runCode`, `AGENCY_CONFIG_OVERRIDES` pointed at one file):
   the child subprocess wrote its full event tree into the shared file
   with the **parent's trace id inherited** — one `trace_id` across all 17
   events, zero unparseable lines. So the IPC-forked descendant path
   (`runCode`, `std::agency.run`, hoisted calls) is coherent as-is:
   subprocess identity carries the trace id, and
   `assertSingleTrace` (`lib/eval/statelogParser.ts:96-107`) is satisfied.

   The hole the experiment exposes by contrast: a descendant started
   *without* IPC — an agent shelling out to `agency run something.agency`
   via bash — mints a fresh trace id (`context.ts:271`,
   `traceId || nanoid()`) into the same inherited file, and extraction
   then hard-fails on multiple trace ids. Fix, small and structural: the
   harness also sets an `AGENCY_TRACE_ID` env var, and the trace-id mint
   site consults it before `nanoid()` — every descendant, IPC or bash,
   then shares one trace by construction, the same way the config
   overrides already travel. (This also improves the non-eval dashboard
   story the comment at `context.ts:143` describes.)

   **Torn lines**, the second failure mode named in review: `O_APPEND`
   writes are atomic only below `PIPE_BUF` (~4 KB), statelog events carry
   prompts and program source well past that, and one malformed line
   fails extraction (`parseJsonl` throws). Assessment after the
   experiment: writes in this tree are *sequential* in the dominant case —
   a parent blocks on its subprocess, bash blocks its calling tool — so
   tearing requires parallel branches (`fork`) emitting large events
   concurrently. Accepted for v1, stated here, with the designed fallback
   if it bites in practice: per-descendant statelog files merged by the
   harness at extraction time.

**Extraction and grading.** Unchanged. The statelog lands where the
extractor looks; `eval-record.json`, grading, `judgeSuite`, and
`recordGrading` neither know nor care that a command produced it.

## Flags that do not carry over

`--max-tool-call-rounds`, `--max-tool-result-chars`, and `--strict` are
compile-time flags: they work for file targets because eval compiles the
agent. A command target compiles nothing — those knobs belong **inside the
command** (`agency agent --max-tool-call-rounds 100 ...`), as do budget
flags (`agency agent --max-cost ...`). Using them together with
`--agent-cmd` is an error naming this rule, not a silent no-op.

Interrupts likewise: there is no IPC channel, so the eval parent's
auto-approval never sees a command agent's interrupts. The command must be
headless-capable on its own — for `agency agent`, that is `--policy
approve-all` (or another policy) plus `-p` one-shot mode. Worth one line
in the CLI docs; an interactive command under eval will simply hang until
the wall clock kills it, and the timeout error should mention this as a
likely cause.

## Error cases, collected

| mistake | when caught | error names |
|---|---|---|
| `--agent` and `--agent-cmd` together, or neither | flag parsing | mutual exclusion |
| no `{task}` in the command | target resolution, before any run | the placeholder requirement |
| compile-time or budget flags with `--agent-cmd` | flag parsing | "put it in the command" |
| `--agent-cmd` with `eval optimize` | flag parsing | optimizer mutates files |
| first token is not an executable | at spawn (`ENOENT`) | the token, verbatim |
| substituted command over the argv size cap | before spawn | the task id and its size |
| command exits non-zero | per run | exit code + stderr tail |
| wall clock exceeded | per run | the limit, plus the interactive-command hint |
| no statelog at the expected path | per run | existing error + the `--log` clobber hint |

## What deliberately does not change

- The `Input` format (this whole feature is runner-side — the property the
  input cleanup existed to create).
- File targets: seeding, compilation, the fork runner, the IPC `task`
  field.
- Grading, judging, run-directory layout, salvage-on-SIGINT semantics.

## Testing

- Tokenizer: quoting, `{task}` inside a token, multiple occurrences,
  missing placeholder error. Pure unit tests.
- Target resolution: union shapes, mutual-exclusion and flag-compat
  errors.
- The `--log` clobber hint: a command passing `--log` produces the
  improved no-statelog error naming the cause — that hint is the whole
  mitigation for the flags-win case, so it is pinned by a test.
- The overrides merge in `runBundledAgent`: inherited env var + `--trace`
  flag → both survive; inherited + `--log` → the flag's logFile wins
  (documented intent).
- `AGENCY_TRACE_ID`: a process tree with an env-set trace id writes one
  trace id even for a non-IPC descendant (re-run of the experiment above,
  as a test).
- Command runner, no LLM: a command like `node -e '<script that writes a
  statelog line and a file>'` run through `runSuite` end-to-end — asserts
  cwd is the workdir, the env var carries the statelog path, exit codes
  and the wall-clock kill map to error results.
- Integration, no LLM: a command target running the real CLI against a
  seeded deterministic agent (`node <agency.js> run <fixture>.agency`
  style, fixture seeded via the input's `files` — legal for command
  targets since there is no agent ingredient to collide with), asserting
  the eval record contains the agent's own events and grading scores it.
- The real thing, manually: `--agent-cmd 'agency agent ... -p -- {task}'`
  against terminal-bench-mini's regex-log (LLM cost, not CI).

## Future work this sets up (not in this PR)

- Non-Agency command agents: a third evidence mode (no statelog — output
  captured from stdout, record synthesized or absent), living behind the
  same `kind` discriminant. Opens cross-agent comparisons (Claude Code,
  opencode) on the same suites, at the cost of a weaker record.
- An `install`/setup step per target (Harbor has one), which would also
  serve the fix-git environment-setup gap — likely one design covering
  both.
