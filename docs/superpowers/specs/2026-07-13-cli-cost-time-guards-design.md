# Design: `--max-cost` / `--max-time` CLI flags + working-time semantics for guards

Date: 2026-07-13
Status: Design (pending review)

## Goal

Two things, one coherent theme — *bound how much an agent run can spend and how
long it can work, and make "how long" mean the agent's actual working time.*

1. Add `--max-cost` and `--max-time` flags to `agency run` and `agency agent`.
   They install a top-level cost/time [guard](../../site/guide/guards.md) around
   the whole program.
2. Make time budgets stop counting while the agent waits for a human, so a
   `--max-time` (or an in-program `guard(time:)`) measures compute time, not
   wall-clock that includes a person's think/type time.
3. Give each `fork` branch its own time budget, so the change in (2) is correct
   even when the agent asks for input from inside parallel work.
4. Let a negative value disable a guard dimension, in both the language and the
   CLI, without affecting outer guards.

The guard runtime primitives (`CostGuard`, `TimeGuard`, `pushGuard`) already
exist. This work reuses them; it does not build a new limiting mechanism.

## Background: how the pieces already work

- **Guards** cap the cost and/or time of a block and return a `Result`. See
  `lib/runtime/guard.ts` and the [guards guide](../../site/guide/guards.md).
- **`CostGuard`** holds a cumulative `spent` counter. `check()` trips only when
  `spent > costLimit` (strict; `guard.ts:177`). Shared across `fork` branches
  (`cloneForBranch` returns `this`), so parallel spend accumulates against one
  counter — correct, because money adds up under parallelism.
- **`TimeGuard`** measures *compute time*: the sum of `(pause, resume)` windows
  (`guard.ts:257`). `pause()` banks the current window and cancels the timer;
  `resume()` re-arms it for the remaining budget. The runner calls `pause()` on
  `halt()` (`runner.ts:253`) and `resume()` at every step entry
  (`runner.ts:266`). This is why interrupts don't count: an interrupt halts the
  runner, which pauses the timer. Today `TimeGuard.cloneForBranch` returns
  `undefined`, so a `fork` branch has no timer of its own; the parent's single
  timer trips all branches via a composed abort signal.
- **The `--policy` flag** (commit `9fec82ef1`) is the template for CLI→runtime
  plumbing: the CLI resolves the flag, clears any inherited `AGENCY_RUN_POLICY*`
  from the child env, sets the env var, and the runtime installs the handler at
  the root in `node.ts` (`installRunPolicyHandler`, `node.ts:355`) — outermost,
  after the exec context exists, before the node body runs.
- **Both `agency run` and `agency agent` spawn a Node subprocess** (`commands.ts`
  `run`, `runBundledAgent.ts`) and pass env to it. Both flow through the same
  runtime entry in `node.ts`. So one env-var-driven install covers both.
- **`input`** is implemented by `inputImpl` (`builtins.ts:59`), which awaits
  `rl.question` inline inside a running step. No halt happens, so nothing pauses
  the time guard — which is exactly why input-wait counts today.

## Approaches considered (mechanism)

- **A. Env var → root guard install in the runtime (chosen).** The CLI parses
  the flags, sets `AGENCY_MAX_COST` / `AGENCY_MAX_TIME` on the child, and the
  runtime installs a root `CostGuard` / `TimeGuard` at the same spot that
  installs the root policy handler. A near-exact clone of the `--policy`
  plumbing; reuses the guard primitives unchanged; one implementation covers
  both commands.
- **B. Codegen wrapping.** Emit a `guard(...) { <node body> }` at compile time.
  Rejected: invasive, touches generated TS, forces the compiler to know about
  runtime flags.
- **C. Reuse `std::agency.run`'s subprocess `maxCost`.** Rejected: that path
  wraps a *child* subprocess from inside Agency code and does not fit a
  top-level CLI flag.

## Design

### 1. CLI flags

`agency run` and `agency agent` each gain:

- `--max-cost <dollars>` — a bare number of dollars, e.g. `--max-cost 0.50`.
  No `$` prefix (the shell would expand `$0`). Kebab-case, matching every
  existing flag.
- `--max-time <duration>` — duration strings only: `30s`, `5m`, `1h`, `500ms`,
  reusing the language's unit-literal grammar. A bare unitless number is a usage
  error (exit 2).

Both flags are optional and independent. Supplying both installs both guards.
Parsed values become env vars on the spawned child: `AGENCY_MAX_COST` (dollars,
as a string) and `AGENCY_MAX_TIME` (milliseconds, as a string). The CLI deletes
any inherited `AGENCY_MAX_*` from the child env before setting them, so this
invocation's flags fully determine behavior — same hygiene as `--policy`.

Value validation, per dimension (see §5 for the "disable" rule):

| Dimension | Usage error | Disabled | Real limit |
|-----------|-------------|----------|------------|
| cost | non-numeric | value `< 0` | value `>= 0` (`0` = local-only) |
| time | bare unitless number | value `<= 0` | value `> 0` |

The `--max-time` duration parser accepts a leading `-` so a disable value
(`-1s`) can be expressed.

### 2. Runtime install

In `node.ts`, right where `installRunPolicyHandler(execCtx)` runs (root process
only — not IPC subprocesses; outermost position), the runtime reads
`AGENCY_MAX_COST` / `AGENCY_MAX_TIME` and pushes a `CostGuard` / `TimeGuard`
onto the root state stack, wrapping the node body. A value in the "disabled"
range installs nothing for that dimension.

### 3. Trip behavior + exit code

The root guard has no Agency-level `try`/`match` around it, so a trip surfaces as
an uncaught `GuardExceededError` out of the node run. The runtime catches it at
the entry layer and:

- Prints a clear message to stderr from the guard's failure data:
  - cost: `Exceeded cost limit of $0.50 (used $0.63)`
  - time: `Exceeded time limit of 5m (ran 5m2s)`
- Exits with **code 3 = budget exceeded**, a named constant in `constants.ts`
  (where the `AGENCY_RUN_POLICY*` names already live), referenced from both the
  runtime and any CLI-side handling. Distinct from `1` (generic failure) and `2`
  (usage error).

If both guards are configured, the one that fires first wins (cost checks at
LLM-call boundaries, time at step boundaries).

Inherited asymmetry, stated for the reader: a **time** trip fires the abort
signal, tearing down in-flight HTTP and signalling other code; a **cost** trip
does not — it enforces at the next LLM-call boundary. This comes from the guard
primitives, not from this feature. Child subprocesses started via
`std::agency.run` are already covered by an enclosing guard, so a top-level
budget bounds a whole agent tree.

### 4. Input-wait is free, everywhere

Any time budget stops counting while the agent waits for a human. This is a
language-wide change to `TimeGuard` behavior: it applies to both the CLI
`--max-time` root guard and a developer's in-program `guard(time:)`. The
consistent rule is "waiting on a person never costs time."

Mechanism: wrap the input wait in `inputImpl` so the active branch stack's
guards are paused before blocking on stdin and resumed afterward:

```
pause active time guards on the branch stack
await the human's answer          // rl.question, or the test input override
finally: resume those guards
```

These are the same `pause()` / `resume()` calls the runner already makes on
`halt()` / step entry, and they are idempotent. `CostGuard.pause()` is a
documented no-op, so this only affects time budgets; cost still accrues. `sleep`
is left counting, because it is the program deliberately spending time, not
waiting on a person.

Details to get right:

- Use the ALS-resolved active branch stack (`getRuntimeContext().stack`), the
  same stack `withTimeGuard` uses — not the top-level stack. No-op safely when
  `input` runs with no stack (bootstrap).
- The pause/resume must wrap the **test input override path** too (the
  `__agencyInputOverride` branch at `builtins.ts:64`), not only the real
  readline path, so the behavior is observable in tests and identical in both
  paths.
- `pause()` cancels only the timer; it leaves `stack.abortSignal` composed, so
  Esc / `cancel()` / a losing `race` still aborts an in-progress input wait.
  This needs a confirming test.

### 5. Negative disables a dimension; per-branch time, cumulative cost

**Disable rule.** When a dimension's value is in its "disabled" range (cost
`< 0`, time `<= 0`), no guard is installed for that dimension. The `guard(...)`
block still runs its body and still returns a `Result`; it simply installs no
limit of its own.

This makes nesting safe with no special case. A skipped guard is not on the
stack, so any outer guard keeps enforcing, and the inner block's usage still
counts against the outer guard:

```
guard(cost: $5.0) {          // outer $5 limit installed
  guard(cost: -1) {          // negative: no inner cost guard installed
    return doExpensiveWork()  // spend still counts against the outer $5
  }
}
```

A disabled inner guard means "no *extra* inner limit here," not "unlimited."
Per-dimension disable works too: `guard(cost: -1, time: 5m)` installs only the
time guard.

**`cost: 0` is a real, useful limit.** Because `check()` trips on
`spent > costLimit` (strict), a limit of `0` never trips while spend stays at
`$0` and trips on the first paid call. That is exactly "no paid spend allowed,"
i.e. a local-models-only guarantee. The pre-call cost gate blocks a paid call
*before* it runs, so the user is not charged even once. This is documented as a
feature. `time: 0` has no sensible meaning (it would trip instantly), so it
falls in time's disabled range.

**Per-branch time budgets.** `TimeGuard.cloneForBranch` changes from returning
`undefined` to returning a fresh per-branch timer. Each branch gets its own
countdown, its own pause state, and its own abort controller. Consequences:

- A branch's human-wait pauses only that branch's timer; working siblings keep
  counting on theirs.
- Each branch inherits the parent's **remaining** budget at fork moment
  (`timeLimit - parent.elapsedMs`), not a fresh full budget. This keeps the
  invariant "no single causal path exceeds the budget": if the parent spends
  3 minutes then forks a 10-minute budget, each branch gets 7, so the path
  through a branch is 3 + 7 = 10, not 3 + 10 = 13.
- After the branches rejoin, the parent's clock advances by the longest branch's
  working time — the real wall time the parallel region took. **To verify
  against the actual `fork`/`runBatch` join before committing to code** (see
  Open questions).

Cost stays shared and cumulative (`cloneForBranch` returns `this`, unchanged),
because money adds up under parallelism and wall-clock time does not. The two
dimensions differ on purpose.

## Testing

All time-guard and disable tests are agency execution tests (`tests/agency/`)
and need no LLM. Cost tests reuse the existing cost-injection pattern under
`tests/agency/guards/`.

- **Flag parsing (unit).** `--max-cost` accepts `0` and positive numbers, treats
  negative as disable, rejects non-numeric. `--max-time` accepts
  `30s`/`5m`/`1h`/`500ms`, treats `<= 0` as disable, rejects a bare unitless
  number. Both map to the right env values.
- **Flag → run (spawn),** in the style of `runPolicy.spawn.test.ts`: a program
  under a tiny budget aborts with exit code 3 and prints the overrun message. An
  inherited `AGENCY_MAX_*` from the parent shell is cleared and does not leak.
- **Input-wait exclusion (exec).** A simulated slow human answer: a time budget
  that would trip during the wait does not. Uses the test input override, which
  the pause/resume wrapping must cover.
- **`sleep` still counts (exec).** A companion test proving `sleep` inside the
  same budget does trip.
- **Esc during input (exec).** Aborting mid-input-wait still cancels the input.
- **Per-branch timers (exec).** A `fork` where one branch waits on input while
  siblings work: the waiter is spared, the workers are charged, and a branch
  born after the parent spent time gets only the remaining budget.
- **Disable rule (exec).** `guard(cost: -1)` inside `guard(cost: $X)` does not
  disable the outer guard; the inner block's spend still trips the outer.
- **`cost: 0` local-only (exec).** Zero spend does not trip; a positive charge
  does.
- **Cost unchanged.** Existing cost-guard and cost-fork tests still pass,
  confirming only time semantics changed.

## Sequencing (three PRs)

Semantics first, flags last — the guard behavior is built and tested before it
is exposed on the CLI.

1. **PR 1 — Negative disables + input-wait free** (§5 disable rule, §4).
   Teach the guards to accept negative values (disable a dimension) and to stop
   counting time while waiting on a human. Input-wait exclusion is correct at the
   top level after this PR; the fork case is completed by PR 2.
2. **PR 2 — Per-branch time budgets** (§5 per-branch). Give each `fork` branch
   its own timer. The largest and riskiest change; also what makes PR 1's
   input-wait exclusion correct inside a `fork`.
3. **PR 3 — CLI flags** (§1–3). Add `--max-cost` / `--max-time` to `agency run`
   and `agency agent`, the root install, and exit code 3. Built on the now-final
   guard semantics.

## Open questions / to verify during planning

- **Fork join accounting.** Confirm how `fork`/`runBatch` joins branch stacks
  and where to fold "parent clock advances by the longest branch's working time"
  into the join path. Verify against `docs/dev/runBatch.md` and the runner.
- **Per-branch timer + interrupt/resume.** `TimeGuard` serializes `elapsedMs`
  and re-arms on resume. Confirm per-branch clones serialize and rehydrate
  correctly across an interrupt taken inside a `fork` branch
  (`rehydrateInheritedGuardsFrom`).
- **`--max-time` on the interactive agent.** With input-wait excluded, a
  session cap now measures the agent's working time across the whole session,
  which is the intuitive meaning. Document that `sleep` still counts.
```
