# Cost is part of a run's state

This document records how Agency counts what a run has spent, and why. Read it
before changing `getCost()`, `getTokens()`, `getModelCosts()`, the usage meter,
or the `usage` field on a run result.

## The rule

Every checkpoint saves what the run has spent so far. Every restore sets the
run's spend back to what the restored checkpoint saved.

That is the whole rule. It has three consequences.

- A run that pauses and resumes keeps counting from where it paused.
- A program that calls `restore()` gets its cost back from the checkpoint too.
- A session loaded from disk by `agency agent --resume` continues its total.

All four figures follow the rule, so they always agree:

| Figure | Where it is read |
|---|---|
| `getCost()` | inside an Agency program |
| `getTokens()` | inside an Agency program |
| `getModelCosts()` | inside an Agency program |
| `result.usage` | by the host, on the value `runNode`, `respondToInterrupts` and `resumeFromCheckpoint` return |

A cost guard's `spent` counter follows the same rule, because the guard is
serialized with the stack.

Two differences in scope are unrelated to resuming or rewinding. Inside a fork,
`getCost()` and `getTokens()` report the current branch, while
`getModelCosts()` and `result.usage` cover the whole run. A manual
`addTokens()` charge reaches `getTokens()` only.

## What the figure means

The figure is the cost of the path that led to the run's current state.

```
start ──$0.50── checkpoint ─┬─ $0.25   try one, rewound away
                            ├─ $0.60   try two, rewound away
                            └─ $0.70   try three, where the program is now
```

At the end of try three, every figure reads $1.20. That is $0.50 plus $0.70.
The $0.25 and the $0.60 are not in it, because the program rewound past them.

The account was charged $2.05. No figure in Agency reports that number, and
that is deliberate. The next two sections explain why, and how a program gets
it.

## Why cost rewinds

Nothing in Agency behaves differently after a resume. A program has no way to
ask whether it is running before or after one. The same holds for a rewind.
This is what makes checkpoints safe to reason about: a program's state fully
describes it.

A cost counter that survived a rewind would break that. A program could
compare the counter with its own state and learn that it had been rewound.

It would also make the common case harder. A program that tries five
strategies from one checkpoint wants the price of each strategy. With cost as
state, that is one subtraction:

```
const start = checkpoint()
const before = getCost()
const answer = tryStrategy()
const price = getCost() - before
```

`before` and `getCost()` rewind together, so `price` is right on every try.
With a counter that never rewinds, `before` goes back to its old value and the
counter does not. Try two would read $0.85 when it cost $0.60.

## How a program totals every try

The program reads `getCost()` at the checkpoint, and again just before each
`restore()`. For the tree above the readings are 0.50, 0.75, 1.10 and 1.20.

```
total = 0.50 + (0.75 - 0.50) + (1.10 - 0.50) + (1.20 - 0.50) = 2.05
```

The readings must live somewhere a rewind does not reach. Agency variables
rewind, so they cannot hold them. A small TypeScript module can:

```ts
let abandoned = 0;
export function addAbandoned(amount: number): void { abandoned += amount; }
export function abandonedSoFar(): number { return abandoned; }
```

```
const start = checkpoint()
const before = getCost()
const answer = tryStrategy()
if (isBad(answer)) {
  addAbandoned(getCost() - before)
  restore(start, {})
}
const total = getCost() + abandonedSoFar()
```

This work belongs to the program. Only the program knows which tries it
abandoned and whether it cares what they cost.

## What a host must do

`result.usage` is the run's spend since it began. A resumed run's result
includes what the run spent before it paused.

A host that stores spend must therefore replace, never add. Every result
carries `traceId`, which is the same on every result of one run. The host keys
its record by `traceId` and overwrites it each time the run reports.

```
first call pauses      usage.cost.totalCost = 0.10   store 0.10 under the trace id
second call finishes   usage.cost.totalCost = 0.25   replace it with 0.25
```

A host that adds the two results records $0.35 for a run that cost $0.25.

A host that wants to know about runs that never finish marks the record from a
paused result as unfinished. A run nobody answers keeps that record.

If a host resumes one checkpoint more than once, each resume reports the cost
of its own path. The host decides what that means for its records.

## How it is built

- `Checkpoint.fromStateStack` saves `ctx.invocationUsage.snapshot()` as
  `Checkpoint.usage`.
- `RuntimeContext.restoreState` calls `InvocationUsageMeter.resumeFrom` with
  the restored checkpoint's `usage`. Every restore path goes through
  `restoreState`.
- `getCost()` and `getTokens()` read `localCost` and `localTokens` on the
  state stack, which the checkpoint already carries.
- `getModelCosts()` reads the meter's entries.
- One sink, `recordUsageDelta` in `lib/runtime/recordPaidUsage.ts`, writes the
  stack counters and the meter together. That is why they agree.

A checkpoint comes back from the host, so `resumeFrom` treats the saved usage
as untrusted input. It keeps every valid figure. Anything it cannot use makes
the total a lower bound, which `usage.complete` reports as `false`. A
checkpoint written before checkpoints saved usage is a lower bound too.

## Alternatives we rejected

**Two fields on the result.** An earlier version kept the old `tokens` field
and added a second field from the meter. The two reported different numbers
for one run. One source of truth is better than two that disagree.

**Usage per call.** The meter once started at zero on every resume, so a
resumed result reported only the spend since the resume. Hosts could add
results together. We rejected it because the figures inside the program then
disagreed with each other after a resume: `getCost()` continued from the
checkpoint and `getModelCosts()` started again.

**Money never un-spends.** Cost would continue across a resume but ignore a
rewind, so the figure would always be the amount charged. We rejected it for
the reasons in "Why cost rewinds".

**Both figures.** Cost as state inside the program, plus a second figure on
the result for what each call really spent, abandoned tries included. It gives
a host the charged amount with no work. We rejected it because it is a second
rule to learn and a second number to explain. One simple rule, with the
totalling left to the program that rewinds, is easier to understand and to
keep correct.

## Known consequence: a cost guard rewinds too

A loop that rewinds to a checkpoint taken inside a `guard(cost: ...)` also
rewinds that guard's `spent` counter. `maxRestores` bounds such a loop. The
dollar limit does not.

That makes the restore cap the only thing standing between such a loop and an
unbounded bill, so it has to hold everywhere a program can restore: a fresh
run, a run resumed after an interrupt, and a rewind. All three loops count
restores through `applyRestoreSignal` in `lib/runtime/resumeSetup.ts`. The
test is `tests/agency-js/restore-loop-after-resume`.
