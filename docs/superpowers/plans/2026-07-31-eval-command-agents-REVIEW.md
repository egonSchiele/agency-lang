# Review: Command Agents Implementation Plan

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-31-eval-command-agents.md`
against `main` plus the `adit/eval-input-task` branch.

## Verdict

The plan is well shaped and the task ordering is right: the tokenizer and the
target union land first as pure units, the two runtime fixes (Task 3's merge,
Task 4's trace id) are separate reviewable commits rather than being smuggled
into the feature, and Task 6 keeps one `runAgent` pipeline with branch points
instead of forking a parallel `CommandRunner` class. That last choice is the
important one and the self-review is right to call it out.

The spec's sharp edges came back as tasks with fixes rather than as
documentation, which is the outcome I hoped for on the spec review. Task 3 in
particular — merging inherited overrides instead of clobbering — is the right
resolution and it helps nested `agency run --log` outside eval too.

I verified the code the plan leans on. `readConfigOverrides(env)` really does
take an env parameter with a `process.env` default (`lib/config.ts:727-729`),
`CONFIG_OVERRIDES_ENV` and `serializeConfigOverrides` are both in
`lib/config.ts`, and `lib/cli/runBundledAgent.test.ts`,
`lib/runtime/state/context.test.ts` and `tsconfig.evals.json` all exist. Task 11's
smoke command points at `solution.agency:main`, which is `node main(task: string)`
— one parameter, so it satisfies #739's rule.

Two things need deciding before execution, and one claim in Task 5 is the
opposite of what the code it cites does.

---

## Task 9's deferred question has an answer, and it breaks the fallback

Task 9 hands the implementer a live unknown — "spend 15 minutes checking how
`agency run` passes node arguments" — with a fallback if there is no clean
path. I looked it up; the answer invalidates the fallback.

`agency run` has **no** surface for node arguments. `scripts/agency.ts:220`
calls `run(config, input, undefined, options.resume, runPolicy, budget)`, and
`run()` itself (`lib/cli/commands.ts:264-289`) compiles the file and spawns the
output without passing any argv through. `promptForArgs` in `lib/cli/util.ts`
belongs to the `agency test` / node-picker flows, not this one.

So the proposed fallback command — `node <AGENCY_CLI> run runner-entry.agency`
— has nowhere to put `{task}`. And Task 2 makes `{task}` **mandatory** in every
command, validated before any run. The fallback would fail at target
resolution, in the same PR that introduced the check.

Two ways out, both better decided here than mid-task:

1. **Give `agency run` an argument passthrough** (`agency run file.agency -- <arg>`
   or `--arg <value>`). It is a small change, it makes the integration test
   straightforward, and command targets will want it regardless — otherwise the
   only Agency CLI that can receive a task is the LLM-bound `agency agent`,
   which is precisely what makes a no-LLM integration test hard. This also
   removes an oddity: today a node with a required parameter run via `agency
   run` simply receives `undefined`.
2. **Make the command a `node -e` shim that takes `{task}` as `process.argv[2]`,
   writes it where a seeded agent reads it, then invokes `agency run`.** The
   `{task}` requirement is honoured and a real Agency CLI process is still in
   the tree, so the single-trace-id assertion — which the plan correctly
   identifies as the load-bearing check — stays meaningful. Uglier, but zero
   new CLI surface.

I would take (1). Either way, the plan should state the answer and pick,
because the current text asks the implementer to discover a blocker and invent
a workaround inside a task that is otherwise fully specified.

On the self-review note defending this: flagging a genuine unknown does beat
faking certainty, and I would rather have this than a confident wrong sentence.
But the unknown was fifteen minutes away from the plan author too, and its
answer changes the task's shape rather than one of its details — that is the
line for "resolve in the plan" versus "leave to the implementer".

## Task 5 behavior 2 contradicts the code it cites

> When the drained total exceeds `limits.stdout`, keep draining but stop
> forwarding (do not kill — matching the spirit of the fork limits, output cap
> ≠ failure; simply truncate what is shown).

The fork path does the opposite. `lib/runtime/ipc.ts:788-799`: once
`s.stdoutBytes` passes `s.limits.stdout` it writes
`... [output truncated: stdout limit of N bytes exceeded]` and then calls
`settleWithLimitFailure(s, "stdout", s.limits.stdout, s.stdoutBytes)` — the run
**fails** with a stdout limit failure. Truncating is the first half of what it
does, not the whole of it.

Truncate-without-failing may genuinely be the better rule for a benchmark: a
chatty agent that succeeded should not be scored zero for verbosity, and
`agency agent` is chatty by design. But then it is a deliberate divergence
between two runners over the same named limit, and it should be written down as
one — "the fork runner fails the run here (ipc.ts:799); the command runner
truncates instead, because X" — rather than presented as parity. Otherwise the
next person to touch either runner will "fix" the inconsistency in whichever
direction they happen to read first.

## Two tasks disagree about `runSuite`'s agent parameter

Task 6 widens `RunSuiteOptions.agent: string | { command: string }` and has
`runSuite` map it back through `resolveEvalTarget`. Task 8 then says: "pass
`agent: opts.agentCmd ? { command: opts.agentCmd } : opts.agent` to `runSuite`
(or pass the resolved target directly if Task 6 chose that shape — keep them
consistent)."

So the plan carries two candidate shapes and defers the choice to whoever gets
there first. That is the one place the plan is not decided, and it is a
type-level decision that both tasks depend on.

It also produces three representations of one idea: CLI flags →
`EvalTarget` (Task 2) → `string | { command }` (Task 6) → `EvalTarget` again,
re-resolved inside `runSuite`. The re-resolution runs the `{task}`-presence
check a second time, on a value that already passed it.

Passing the resolved `EvalTarget` into `runSuite` is the obvious call:
`resolveEvalTarget` is where validation lives, the CLI already calls it, and
`EvalTarget` is the type the rest of Task 6 branches on anyway. The cost is
updating `runSuite`'s existing callers to wrap a string — and Task 6 is editing
those call sites regardless. Pick it in the plan and delete the alternative.

---

## Smaller things

**`AGENCY_TRACE_ID` is global, and Task 4 does not say what that costs.** The
mint order goes into `RuntimeContext` construction, so *every* compiled Agency
process reads it, not only eval command targets. Two consequences worth a
sentence each: a developer who happens to have the variable exported merges
every subsequent run into one trace; and an eval parent that inherited it will
pass it to **file**-target children too, since `fork` inherits `process.env` —
those children currently get their trace id from the IPC `runId`, so the
precedence between the two needs to be stated rather than discovered. The
cheapest fix is for the fork runner to delete the variable from the child env
the way `run()` already deletes `AGENCY_RUN_POLICY` (`commands.ts:288`), which
is an established precedent in this codebase for exactly this hazard.

**Task 3's merge is shape-specific in a way worth noting.** `{...inherited,
...overrides, log: {...inherited.log, ...overrides.log}}` is correct today
because `agentConfigOverride` parses only `--trace` and `--log`
(`runBundledAgent.ts:62-85`), and among the fields those produce only `log` is
nested — `trace`, `traceFile`, `traceDir` and `observability` are all
top-level. That is a real invariant, not an accident, and it will break
silently if that parser ever learns a flag that writes a nested key (`client`,
for instance, is nested in `applyCliFlags`). One line in the comment saying
"only `log` is nested among the flags this parses" makes the fragility visible
to whoever adds the next flag.

**Task 5's memory limit is weaker than the fork runner's, and Task 5 does not
say so.** `--max-old-space-size` bounds the V8 heap of Node processes only —
not native allocations, not non-Node commands. Task 10's docs bullet is honest
about this ("memory via NODE_OPTIONS, Node processes only"); Task 5's behavior
list reads as though the limit simply carries over. Put the caveat where the
implementer will read it.

**Task 6's seeding rule has a consequence worth naming.** Seeding
`PROJECT_CONFIG_FILES` from `process.cwd()` answers the question the spec left
open — good. The consequence is that the workdir receives the *invoking
project's* `agency.json`, so any `eval.*` settings in it (including
`eval.limits` and `eval.runsDir`) are visible to the agent under test. Harmless
in practice, surprising if it ever matters; one sentence in the task.

**Task 2's `{task}` check is duplicated.** `substituteTask` throws when no
token carries the placeholder (Task 1), and `resolveEvalTarget` checks the same
thing (Task 2) with the same message text written out twice. Keeping both is
right — one is the early check, one is the invariant guard — but the message
should come from one place (export it beside `TASK_PLACEHOLDER`), or the two
will drift.

## Testing

The per-task test lists are good and specific. Three gaps:

- **Nothing tests the `--log` clobber path end to end.** Task 3 tests the merge
  at the `runBundledAgent` level and Task 6 tests the hint text, but the
  scenario the spec was worried about — a command that passes `--log`, and the
  harness detecting the missing statelog and naming the cause — is never
  exercised as a whole. Task 9 is the natural home, and it is cheap: one extra
  run with `--log` in the command, asserting the error names it.
- **Task 4 tests the env var in isolation** but nothing tests the property it
  exists for: that a spawned Agency process and its own descendants land in one
  trace. Task 9's single-trace-id assertion is the closest thing, and the plan
  already identifies it as load-bearing — worth saying explicitly in Task 4
  that its real proof lives in Task 9, so nobody trims that assertion later as
  redundant.
- **No test for the argv size cap actually firing through `runAgent`.** Task 5
  unit-tests it; Task 6's error path (input id appended) is asserted nowhere.
