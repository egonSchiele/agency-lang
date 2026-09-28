# Review: Command agents — benchmarking a CLI under `agency eval run`

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-31-eval-command-agents-design.md`
against `main` plus the `adit/eval-input-task` branch (PR #739).

## Verdict

The core idea is good and the framing is honest. Writing down the rejected
wrapper design and *why* it failed — the eval record captured one `exec` call,
so the agent's real behavior was invisible to graders — is the most useful
paragraph in the document, and the fix it motivates is elegant: hand the child
the statelog path and the eval record simply *is* the agent's record, with
grading, judging and extraction unchanged. That is disk-first grading paying a
dividend, exactly as claimed.

The scoping is disciplined too: Agency-CLI agents only, with the `kind`
discriminant placed so a weaker-evidence variant can be added later; and
declining `--agent-cmd` for `eval optimize` with a reason (the optimizer
mutates agent *files*) rather than half-supporting it.

I checked the code references. `context.ts:263` does apply
`readConfigOverrides()` at RuntimeContext construction;
`runBundledAgent.ts:138-141` is the clobber the spec describes;
`statelogClient.ts:1435` is the per-event `appendFileSync`; and
`assertEvalEntryNodeTakesOneParameter` exists at `agentTarget.ts:54` on the
#739 branch. One thing I specifically went looking for and did **not** find a
problem with: `agentConfigOverride` parses only `--trace` and `--log`
(`runBundledAgent.ts:62-85`), so the spec's own example command — which passes
`--max-tool-call-rounds 100` — does not trip sharp edge 1. Good.

But the design rests on one assumption that the spec asserts rather than
verifies, and I think it is the wrong way round. Details first, then the
smaller things.

---

## The load-bearing assumption needs an experiment, not a paragraph

Sharp edge 2 — "descendant processes share the statelog" — is presented as a
cosmetic concern ("revisit only if interleaving proves noisy in practice") with
an upside ("the record covers the whole process tree, which for benchmarking is
arguably the more honest accounting"). Two mechanisms in the extractor say it
may instead be fatal.

**First: more than one trace id in a file is a hard error.**
`StatelogParser.evalRecord()` calls `assertSingleTrace`, which throws
`extract: multiple trace_ids in input (...). Exactly one trace per file is
supported.` (`lib/eval/statelogParser.ts:96-107`).

Trace ids are per-process: `context.ts:271` does
`traceId: args.statelogConfig.traceId || nanoid()`, and the only inheritance
path I can find is the IPC `SubprocessIdentity.runId` carried on a
`RunInstruction` (`lib/runtime/ipc.ts:522-528`) — which a **spawned** command
has no channel for, by the spec's own design ("`spawn`, not `fork` — there is
no IPC channel").

So the question the spec needs to answer with a run, not an argument: when
`agency agent` executes a generated program (the `runCode`/`execute` path the
spec names), does that program inherit the parent's trace id, or mint a fresh
one? If it mints a fresh one, every command-target run whose agent writes and
runs a program fails extraction — and that is the flagship use case, the one
`foo.agency` and terminal-bench-mini exist to exercise.

**Second: a torn line is fatal, not noisy.** `readAllEventsSync` throws on the
first malformed JSON line (`lib/eval/parseJsonl.ts`), so "concurrent
line-appends stay parseable" is doing a lot of work. `appendFileSync` opens
with `O_APPEND`, where atomicity is guaranteed only for writes below `PIPE_BUF`
(4096 bytes on Linux and macOS). Statelog events carrying prompts, tool
results, and generated program source routinely exceed that — they are exactly
the large events a benchmark cares about. Two processes appending a 20 KB event
each can interleave mid-line, and the run then fails with "eval-record
extraction failed" rather than degrading.

Neither of these makes the design wrong. They make sharp edge 2 a *decision*
rather than a footnote, and the decision needs data. The experiment is cheap:
point `AGENCY_CONFIG_OVERRIDES` at one file, run `agency agent -p` on a task
that makes it write and execute a program, then count distinct `trace_id`
values in the file and check whether any line fails `JSON.parse`. If both come
back clean, say so in the spec and the concern evaporates. If they do not, the
options are worth spelling out now: give each descendant its own statelog and
merge, or propagate a trace id through the environment the way `runId` travels
over IPC today, or accept only the top-level process's events.

---

## Sharp edge 1 has a three-line fix in a file you have already read

The spec chooses "documented rather than engineered around" for both edges.
That is defensible for edge 2 (where the fix is genuinely a design). It is
weaker for edge 1, because the cause is a single line:

```ts
const env = { ...process.env };
if (Object.keys(overrides).length > 0) {
  env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides(overrides);
}
```
(`lib/cli/runBundledAgent.ts:138-141`)

The problem is not that `--log`/`--trace` produce overrides; it is that the
assignment **replaces** the inherited value instead of merging onto it. So a
benchmarker who passes `--trace` to get a trace file — a completely reasonable
thing to want while benchmarking — silently destroys the harness's statelog
path and gets the "no statelog" error, hint or no hint.

Merging fixes it for good: parse the inherited `AGENCY_CONFIG_OVERRIDES`, layer
the flag-derived overrides on top, serialize the result. That is the same
"env first, then explicit on top" ordering `context.ts:263-267` already
documents for the runtime side, so the two ends would finally agree. It also
fixes nested `agency run --log` outside eval entirely, which makes it a fix
worth doing on its own merits rather than a favour to this feature.

If it stays documented-only, at least say in the CLI docs that `--trace` is
affected too — the spec currently names `--log` and `--trace` in the code
paragraph but the proposed error hint mentions both, while the "must not pass"
rule reads as though it is mainly about `--log`.

---

## Things the spec does not say and should

**`stdio: "pipe"` with nobody reading will hang the agent.** The sketch has
`stdio: pipeOutput ? "inherit-ish" : "pipe"` — `"inherit-ish"` is a placeholder
rather than a value, and the `"pipe"` branch is a real deadlock. A pipe buffer
is ~64 KB; when it fills and no one drains it, the child blocks on write
forever, the wall clock eventually kills it, and the user sees a timeout with
no explanation. `agency agent` is extremely chatty, so this is the default
path, not an edge case. Either drain both streams (and discard), or use
`"ignore"` when not piping. Worth being explicit because the fork runner gets
this right by accident — `child.stdout?.pipe(process.stdout)` only when piping,
and `fork` defaults otherwise.

**Which limits stop applying.** `DEFAULT_EVAL_RUN_LIMITS` carries `wallClock`,
`memory`, `ipcPayload`, and `stdout`, and the fork machinery enforces all of
them. The spec re-implements only the wall clock for the command runner. That
means a command target loses the memory cap in particular — an agent that
allocates without bound can take the developer's machine down, where the same
agent under a file target would be killed. Say which protections a command
target does and does not get, and whether losing them is accepted.

**What happens to `agency.json` and `.env` in the workdir.** Seeding for a file
target copies `PROJECT_CONFIG_FILES` from the agent's `baseDir`. A command
target has no `baseDir`, and the spec says the workdir is seeded "from the
input's `files` only". So the spawned agent runs in a workdir with no
`agency.json` — and since config resolution walks *up* from cwd, it will find
the enclosing project's `agency.json` whenever the runs directory sits inside a
project, and nothing when it does not. That is a real behavioural difference
between two developers running the same benchmark. API keys are fine (they ride
`process.env`), but the config question needs a stated rule.

**`agentLabel` becomes the command string.** `summary.json` records it, and run
directories get shared. Commands sometimes carry credentials
(`--api-key ...`, a token in a URL). One sentence either committing to storing
it verbatim or to redacting known secret-shaped flags.

**Record the invariant that `--agent-cmd` never comes from a suite.** It is
true in this design and it is load-bearing: suites can be remote git sources
(#733), so a future convenience feature that let a suite specify its own agent
command would be remote-code-execution-by-suite. Writing the invariant into the
spec now is what stops that from looking like a nice idea later.

**Large object tasks and `ARG_MAX`.** A JSON-serialized object task substituted
into argv is subject to the OS argument-size limit, and the failure is an
opaque `E2BIG` from `spawn`. One line, plus a check with a clear message, is
cheaper than the bug report.

---

## Smaller notes

- The `--agent-cmd` tokenizer is the right call (no shell, no expansion), and
  substituting **after** tokenization is exactly the property that makes a
  hostile task safe. Worth stating the consequence positively: a task
  containing `; rm -rf /` is inert, because there is no shell to interpret it.
  That sentence belongs in the spec, since "we take a command string" otherwise
  reads alarming.
- The error-cases table is a good format and I would keep it. Two rows are
  missing: `--agent-cmd` whose first token does not resolve to an executable
  (caught at spawn, `ENOENT` — should name the token), and a command that
  writes a statelog with multiple trace ids (if the experiment above shows that
  can happen).
- "SIGINT forwarding mirrors the fork runner" understates a difference: the
  fork runner does not forward anything — Ctrl-C at a terminal reaches the
  whole process group, and #738's salvage handler exists in the parent. A
  spawned child is in that same group, so forwarding may be double-signalling.
  Worth checking rather than mirroring.
- The testing list is good. Add: an assertion that a command passing `--log`
  produces the improved error (that hint is the whole mitigation for edge 1, so
  it should be pinned), and whatever the trace-id experiment concludes.
- Provenance: `config.json` recording the command string means command-target
  runs lose the property #733 built provenance for — "two runs are comparable
  exactly when their shas match". That is an acceptable trade, but name it, and
  consider recording something that partially restores it (the `agency
  --version` of the CLI being invoked, or the bundled agent's hash), since
  comparing benchmark runs over time is the entire point of the exercise.
