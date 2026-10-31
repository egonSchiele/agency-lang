# Review: safeBash plan reason and debug event (ADI-238)

Plan reviewed: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/plans/2026-10-30-safebash-plan-reason-and-debug-event.md`

Every claim below was checked against the code in this worktree (commit
0c18d3afd). Where I say a function or line exists, I read it.

## Verdict

The plan is buildable as written and matches the spec. Nothing in it is
unsafe: the log call sits after `planFor` and before `raiseAll`, nothing new
runs, and no handler is skipped. I would make three changes before building,
all to Tasks 1 and 2. None of them changes what the slice delivers.

1. Put the outcome derivation in Agency, next to the `Execution` union, and
   make the TypeScript helper a generic "post a debug event" function.
2. Make the reason a small record instead of a string with a colon in it.
   The string encoding produces a message to the model that reads
   `because: unrecognized: no rule for xargs`.
3. Do not parse the command a second time to get the verb list. `planFor`
   already has the flattened commands in hand.

Smaller corrections follow those three.

## Claims I verified

- `currentRunOrNone()` exists at `lib/runtime/asyncContext.ts:380` and
  `_turnStart` in `lib/stdlib/statelog.ts` uses exactly the no-op pattern
  the plan describes.
- `run.log.debug(message, data)` exists at `lib/statelogClient.ts:418` and
  posts `{ type: "debug", message, data }`. No new method is needed.
- `planFor` in `stdlib/safeBash.agency` has the four broad branches the
  plan names (unparseable, `!allRecognized`, `narrow.length == 0`,
  `rebuilt is failure`) and discards the `why` from `effectsFor` today.
- `refusePlan`, `bashPlan`, `echoPlan`, `writePlan`, and
  `agencyCommandPlan` are the five builders that construct a `Plan`, so
  Task 1 Step 4 names every site.
- `withFrame` and `spyClient` in `lib/stdlib/statelog.test.ts` are the
  helpers the plan says to copy. `spyClient` replaces named methods on
  `ctx.statelogClient`, so adding a `debug` spy is one line.
- The existing test file already has `planSummary` and `effectNamesFor`,
  and the reject handler shape `{ "action": "reject", "expectedMessage" }`
  is used in `tests/agency/destructive-block.test.json`.
- `isRefused("xargs rm x")` is false (the wall matches only the command
  word), so `xargs rm x` reaches `effectsFor` and gets ``no rule for `xargs` ``.
  The Task 1 expected output is right for that row.

## Change 1: derive the outcome in Agency, not in TypeScript

Task 2 defines a TypeScript type `SafeBashPlanView` that mirrors part of
the Agency `Plan`, and a lookup from execution kind to outcome written in
TypeScript. That puts knowledge of the `Execution` union in a second
language. The whole point of that union, as its own comment says, is that
an exhaustive `match` in Agency fails to build when a variant is added.
The TypeScript lookup will not fail. It will silently log `undefined` as
the outcome for a sixth execution kind.

This is the catalog entry "Duplicating existing code", and it is also the
altitude question: the thing that knows what a plan is lives in
`stdlib/safeBash.agency`, so the thing that names a plan's outcome should
live there too.

The simpler shape:

- In `stdlib/safeBash.agency`, a `def outcomeOf(plan: Plan): string` that
  is an exhaustive `match` over `plan.execution.kind`, with the `bash` arm
  reading the reason. Five lines, and a new `Execution` variant breaks the
  build here the way it already does in `safeBash`.
- In `lib/stdlib/statelog.ts`, beside `_turnStart`, a generic
  `export async function _debug(message: string, data: unknown)` that does
  the `currentRunOrNone()` check and calls `frame.log.debug`. Nothing in it
  knows about safeBash. It is the fourth function in that file with the
  same three-line body, so it belongs there, and the next stdlib module
  that wants a debug event reuses it.
- `safeBash` calls `_debug("safeBash plan", { command, cwd, outcome:
  outcomeOf(plan), reason: ..., verbs: ..., effects: [e.name for e in
  plan.effects] })`.

The unit test in Task 2 then tests `_debug` posts one event with the
message and data it was given (three lines), and the outcome mapping is
tested where it lives, as a `planFor` row in `tests/agency/safeBash.agency`
through a `def planOutcome(source)` helper. That is also where the plan's
own Review Focus wants it: "a refused command: logged with outcome
`refuse`" is a plan-level fact, not a statelog fact.

`std::statelog` already exports `emit(data)`, but it goes to the
host's `onEmit` callback, not to the statelog, so it is not a substitute.
I checked.

## Change 2: the reason is a record, not an encoded string

Task 1 encodes four cases into one string: `unparseable: <msg>`,
`unrecognized: <msg>`, `noEffects`, `unrenderable: <why>`. Three readers
then take that string apart or paste it whole:

- The event wants the kind and the detail as separate fields. The spec's
  table has both `reason` and `detail` columns.
- The rejection message in Task 3 pastes the whole thing, so the model
  reads: `safeBash could not ask a narrower question because:
  unrecognized: no rule for `xargs`.` Two colons, and the word
  `unrecognized` is our enum value, not English. For the audit-rule case
  the model reads `because: noEffects.`, which says nothing to it, and is
  also not true: every command was recognized. The spec's example message
  reads `because: no rule for `xargs``, which is what we want.

Store what the three readers need:

```
export type BroadReason = {
  kind: "unparseable" | "unrecognized" | "noEffects" | "unrenderable";
  detail: string
}

export type Plan = {
  effects: Effect[];
  execution: Execution;
  /** Why the plan asks the broad std::bash question, or null when it does
   *  not. */
  broadReason: BroadReason | null
}
```

Then the event carries `reason: plan.broadReason?.kind` and `detail:
plan.broadReason?.detail`, matching the spec's two columns, and the
rejection message comes from one small table keyed by kind:

```
static const BROAD_SENTENCES = {
  unparseable: "the command could not be parsed",
  unrecognized: "it has no rule for one of the commands",
  noEffects: "every command was recognized but none needs an approval of its own, so the shell itself had to be approved",
  unrenderable: "the parsed command could not be rendered back to text"
}
```

The message becomes `${why} safeBash could not ask a narrower question
because ${sentence}${detail}.`, with the detail appended only for
`unrecognized` and `unparseable`. One table, one place to edit when a
fifth kind arrives. This is the "says what, not how" shape from the
catalog, and it keeps enum values out of text a model reads.

The name matters too. `RefuseExec` already has a field called `reason`
(why the command was refused). A `Plan` with `plan.reason` next to
`plan.execution.reason` has two fields of that name meaning different
things. `broadReason` says which one it is.

The Task 1 test changes shape with this: return
`[plan.broadReason?.kind, plan.broadReason?.detail]` per row, or a
`planReason` helper that formats them. Either is fine. The six rows and
their expected kinds stay as the plan has them.

## Change 3: do not parse twice for the verb list

Task 2 Step 5 adds `verbsOf(source)`, which parses the string again,
flattens again, and collects command words. `planFor` did both of those
three lines earlier and threw the list away. Parsing twice costs little
here, but it is a second copy of "what commands does this string hold",
and the two copies can disagree: `verbsOf` returns `[]` for an
unparseable string, which is the right answer, but if someone later makes
`planFor` tolerate something `verbsOf` does not, the event lies.

Two ways to fix it, either fine:

- `Plan` gains `verbs: string[]`, filled in `planFor` from `simple` (the
  flattened list) and `[]` on the unparseable branch. The five builders
  that construct a `Plan` each take it or default it. This is the smaller
  change.
- `planFor` is split so a `describe(source)` step returns the parsed and
  flattened commands once, and both the plan and the event read from it.
  Bigger than this slice needs.

I would take the first. The verb list is a fact about the decision
(`planFor` decided over exactly these commands), so it belongs on the
record that holds the decision.

## Smaller corrections

- **Task 4 Step 2 and Step 4, `git add -f`.** The plan says
  `.claude/skills/agency-stdlib-docs/SKILL.md` is in a gitignored directory
  and needs `git add -f`. It is not. `git check-ignore -v` on that path
  returns nothing (exit 1) and `git ls-files` lists it. Plain `git add`
  works. Drop the note so a builder does not go looking for the ignore
  rule.
- **Review Focus, "Observability off."** The plan says this is pinned in
  Task 2, but Task 2's tests cover only "outside a run". When observability
  is off the statelog client is a no-op already (see `_isLogging` in
  `lib/stdlib/statelog.ts`), so there is nothing new to pin. Either drop
  the bullet or state that the existing client behavior covers it.
- **Task 1 Step 1, the `echo $(date)` row.** The plan tells the builder to
  run the parser and paste the exact message. Good. For what it is worth,
  I traced it: `echo` parses as a command with no arguments, the `$(`
  stops the argument parser, and `bashParser` returns
  `Unexpected input after commands: "$(date)"`. The plan's guess is
  right.
- **Task 3 Step 1.** "Run once with a placeholder to capture today's
  exact rejection text" is the right instruction. I could not find a
  fixed default rejection string in the runtime; the rejection value comes
  from the handler (`renderVerdict` in `lib/runtime/interrupts.ts`
  returns `{ type: "reject", value: merged.value }`), so what the test
  handler supplies is what the failure carries. The builder should expect
  the captured text to depend on the test runner's reject handler, not on
  safeBash.
- **Task 2 Step 5, placement.** The call goes before the refusal check so
  refusals are logged. Agreed. Say in the code comment that this is why
  it sits above the `exec is { kind: "refuse" }` line, or the next person
  to tidy the function will move it below.
- **Task 4 Step 1, "under 150 lines".** The dev doc also has to be the
  one that ADI-241 and the later slices extend, so leave the section list
  as the plan has it but do not fight the length. The rule in the memory
  notes is mechanism and rule only, not short.

## Anti-pattern pass

Checked against `~/.claude/skills/anti-pattern-check/anti-patterns.md`
and `docs/dev/contributing/anti-patterns.md`.

- **Duplicating existing code.** Task 2's outcome lookup in TypeScript
  duplicates the `Execution` union's knowledge. Change 1 above.
- **Imperative code everywhere.** Task 3 builds the model's message by
  string surgery on an encoded reason. Change 2 replaces it with a
  sentence table.
- **Duplicating existing code.** `verbsOf` re-does `planFor`'s parse and
  flatten. Change 3.
- **Inconsistent patterns.** With
  Change 1 the new helper follows `_turnStart` exactly, and without it
  `lib/stdlib/safeBash.ts` grows from a one-line re-export into a file
  with runtime logic, which no other `lib/stdlib/*.ts` bridge for a
  parser does.

Nothing else from either catalog applies. The snippets use braces, no
ternaries, no magic numbers.

## What I did not check

I did not run `make` or the Agency tests. The exact rejection text in
Task 3 and the parser message in Task 1 are to be captured by the builder,
as the plan says.
