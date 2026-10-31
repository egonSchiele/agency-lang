# Tool-loop guards: the round cap, repeated calls, markup arguments, rejected calls, and handoffs beside other calls

Five refusals in `runPrompt`'s tool loop that stop a model from wasting
rounds: a call past the round cap, a repeated call, a markup argument, a
RETRY of an already-rejected call (the first rejected call runs normally
up to its interrupt; only the identical retry is refused), and a handoff
call that shares a round with another call. The cap, repeat, and markup
helpers live in `lib/runtime/toolLoopGuards.ts`; the rejection
bookkeeping lives in `prompt.ts` itself; the handoff text lives in
`lib/runtime/handoff.ts`. All five refusals happen before the tool's
`onToolCallStart` hook, so a refused call never runs, never fires hooks,
and never counts toward `MAX_TOOL_FAILURES`. The model sees the refusal
as an ordinary tool message, which is where it reads results.

## The round cap

A round is one model reply that asked for at least one tool call this
loop dispatches. `self.toolCallRound` on the runPrompt frame counts the
rounds that have run; it goes up inside the `nextLlmCall` step, after the
request that follows a round, so a resume after an interrupt in a round
re-enters the same round. The count is per `llm()` call: a block that
calls `llm()` twice gives each call its own count, so `revise` with two
attempts of thirty rounds each is sixty rounds, not thirty.

What the count leaves out: a provider-hosted tool round (a search the
provider ran inside one request) never comes through this loop, so it is
not a round; a validation retry re-sends the same turn and is counted by
`validationRetries` instead; and an intrinsic call (`saveDraft`) is
handled inline and ignores the cap.

Where the cap comes from. The call's own `llm(..., { maxToolCallRounds })`
and a branch default from `setLlmOptions` (a fork or tool branch inherits
its parent's) are both ceilings: when both are set, the smaller wins. With
neither, `maxToolCallRounds` in `agency.json` applies, which the codegen
bakes into every call (default 10). Two cases decide the rule. The
researcher asks for 30 and the agent sets a branch-wide 50
(`applyToolLimits`): the researcher gets 30. A user runs
`agency agent --max-tool-call-rounds 5` to keep a run cheap, and the
researcher asks for 30: it gets 5, because the branch default is how the
flag and a preset reach every call in the run, and "an explicit flag
always wins" (`resolveMaxToolCallRounds` in the agent) holds only if a
call cannot raise its cap above it. The cost is that a call cannot ask
for more than the branch allows. The per-call value used to ride into the
provider config unread, so the branch default was the only cap. That is
how trace wX5GvrUq ran 43 rounds under a researcher that asked for 30:
43 is under 50 (ADI-46).

The cap allows rounds 0 to cap - 1. The request after the last allowed
round, and every request after it in the call, offers only the intrinsic
tools (`toolsOffered` in `toolLoopGuards.ts`) and no provider-hosted
tools (`configOffered` drops `hostedTools`, which travel in the config).
With nothing to call or search, the model can only answer. Anthropic
accepts a request whose history has `tool_use` and `tool_result` blocks
but no `tools` field, so the empty list is safe there. The decision reads
the frame's round counter, so a resumed pass offers what the first pass
offered.

A model that calls a tool it was not offered gets the `tooManyRounds`
verdict for every call in that round, with this message:

> Error: This request's budget of 30 tool rounds is used up, so this
> call was not run. Write your answer now from what you have.

The message is a tool result, so it stays in the thread after the call
returns. It names "this request" because a later `llm()` call on the
same thread starts its own count and offers tools again.

## The round warning

```
llm(question, {
  tools: [search, fetch],
  maxToolCallRounds: 20,
  warnAtRoundsLeft: { remaining: 5, text: "{remaining} of {limit} searches left." }
})
```

`warnAtRoundsLeft` sends the model a user message when few tool rounds
are left. In the example, the model reads "4 of 20 searches left." after
its fifteenth round.

The loop checks for a warning at the round boundary after every round,
in `roundWarningProducer` (`lib/runtime/turnBoundary.ts`). At the
boundary after round r, counted from 0, the model can still get
`limit - (r + 1)` rounds of tool calls run. There are two warnings:

1. The first warning goes out at the first boundary where that number is
   at most `remaining` and more than 1. `remaining` defaults to 3, and 0
   turns this warning off.
2. The final warning goes out at the boundary where 1 round is left,
   when `finalWarning` is true, which is the default.

With a cap of 10 and the defaults, the first warning goes out after
round 6 and the final warning after round 8. A cap of 2 gets only the
final warning, after round 0. The two texts take the placeholders
`{remaining}` and `{limit}`, and any other text in braces is left as
written. The defaults are in `DEFAULT_ROUND_WARNING` in
`lib/runtime/roundWarning.ts`.

Each warning goes out once per `llm()` call. `runnerState.roundWarnings`
records which have gone out, and the producer writes it inside its step,
so a pass resumed after a pause sends neither a second time
(`tests/agency-js/round-warning`).

The warning is a user message labeled `roundWarning` that expires with
the `llm()` call (`docs/dev/runtime/expiring-messages.md`), so a later
call on the same thread never reads a stale count. It is a user message
and not a tool result because a tool result belongs to the tool: a model
that quotes tool output would quote the runtime's words as the tool's.

The option is set on the call or with `setLlmOptions`. The two combine
field by field (`mergeFields` in `lib/runtime/localDefaults.ts`), so a
call that sets only `text` keeps the branch's threshold. It is not a
preset field.

## Repeated calls

Seen in an eval: the Agency writer made 45 identical `typecheck` calls,
each returning "no errors", over four minutes. Nothing changed between
calls, and nothing was going to.

`repeatKey` identifies a call by tool name plus a SHA-256 of the arguments
as canonical JSON. Canonical JSON sorts object keys at every level, so
argument order does not make a new key. Results are compared by digest too,
so the streak record never holds a large argument or result. That matters
because a tool can take a whole source file or return megabytes, and the
record lives on the serialized frame. Hashing is linear in the size, which
the loop already pays to stringify the result for the model.

The loop keeps ONE streak record (`RepeatStreak`: key, result, count),
because only calls in a row count. After every run, `noteRepeat` extends
the streak when the key and the stringified result both match the previous
call, and otherwise starts a new streak of one. So
`readStatus → advanceJob → readStatus` never accumulates, however many
cycles. When the streak reaches `maxRepeatedToolCalls` (default
`DEFAULT_MAX_REPEATED_TOOL_CALLS`, 3), `repeatsBefore` sees the count and
the loop refuses the next identical call:

> Error: this is call 4 to typecheck with exactly these arguments, and
> the previous 3 all returned the same result. It was not run. Say what
> you expected to change, then either call it with different arguments
> or continue without it.

The refusal calls `resetRepeat`, so the call is interrupted every N
identical runs rather than banned: a poll that really is waiting on the
world gets to run again once the model has said so, and a changed result
then starts a fresh streak. The guard applies to every tool regardless of
its `idempotent` or `destructive` markers: the signal is "same input, same
output, asked again, with nothing in between", not the tool's nature.

Setting: `llm(..., { maxRepeatedToolCalls: n })` per call,
`setLlmOptions({ maxRepeatedToolCalls: n })` per branch; `0` disables.
The streak lives on the runPrompt frame as `self.repeatStreak`. `noteRepeat`
runs inside the idempotent `invoke` step, so an interrupt and resume does
not count one run twice.

## Markup arguments

Claude sometimes emits the closing tag of its own tool-call syntax where an
optional string it meant to leave empty belongs, and the next parameter's
text leaks in:

```
stdin: '</antml name="stdin">\n<parameter name="allowedExecutables">[]'
flags: '</antml name="flags">\n<parameter name="maxResults">50'
```

In two eval runs all twelve occurrences had this shape, always on an
optional string parameter (`stdin`, `flags`), never on the main one.
Running such a call costs a round at best (`grep` rejects the "flags" as
regex flags) and at worst executes with garbage input. `markupArgument`
is deliberately narrow so that data is never mistaken for markup: it
looks only at parameters with a default (`FuncParam.hasDefault`), and only
at a value that IS a closing `</antml…>` tag, either named for that
argument or followed by leaked `<parameter` markup. A required parameter
given a captured transcript, or an XML tool given `<parameter name=` in
the middle of a document, is left alone. (One of the twelve,
`</antml name flallags">50`, a garbled tag with nothing leaked after it,
is not matched and fails the old way.) The refused call gets a message
naming the argument and asking for the call again without it.

## Rejected calls

A rejected interrupt means a handler, policy, or user said no to a tool
call. The tool loop tells rejections apart from failures by the
`rejected` flag the interrupt codegen stamps on the halt failure — both
the handler-reject and the resume-reject template branches set it, so an
interactive `reject("reason")` carries its reason too. A TS tool that
returns the raw `InterruptResponse` from `agency.interrupt` takes the
same path.

A rejection is not a tool error (`recordRejection` in `prompt.ts`):

- The model sees `Tool call rejected: <reason>`, then a do-not-retry
  instruction on the next line. The reason is the rejecter's text,
  printed as written with no period added, because it may be a question
  or run several lines. No `toolErrorCounts` increment, no `toolError`
  statelog event.
- The reason says who rejected the call. The tool loop cannot know
  this, so whoever writes the reason does. `cliPolicyHandler` writes
  `The user rejected this call and wrote you this message:` above the
  user's text, `The user rejected this call.` when they gave no reason,
  and `A rule in the approval policy rejected this call.` for a rule with
  no `rejectMessage`. Without the first one, a user asking "why are you
  running these commands?" reads to the model like a note from the
  environment. That handler is the only writer that has been given this
  wording. `agency run --interactive` and the `--approve`/`--reject`
  flags go through it, so they are covered. A custom handler's bare
  `reject()` or `with reject` reaches the model as `interrupt rejected`,
  and a TypeScript host that answers an interrupt itself, with
  `reject(reason)` from `interruptResponse.ts` or over the hosted
  `/resume` route, passes the client's text through as written. A host
  that collects a reason from a person must add the prefix itself.
- Code between the interrupt and the tool loop must pass the rejection
  failure on as it came. Rebuilding it with `failure(why)` drops the
  `rejected` flag, and the reason then arrives as a tool error that says
  "You may call this tool again". `safeBash` adds its explanation with
  `_addLine` for this reason (see `docs/dev/stdlib/safe-bash.md`). The
  lint rule AL0004 (`lib/linter/rules/rebuiltFailure.ts`) finds the
  rebuild shape, `return failure(why)` inside `if (x is failure(why))`,
  and its fix returns `x` instead. A lint hint never fails a run, so
  `lib/linter/agencySourcesClean.test.ts` lints the stdlib and the agents
  and fails on any AL0004 finding. The rule cannot tell a rejection from
  any other failure, so it reports every rebuild; returning the failure
  itself is the right move in every case, because it also keeps the
  failure's data and checkpoint.
- An identical retry (same `repeatKey`) is refused before the start
  hook: no invoke, no re-raised interrupt. Checked before the repeat
  guard so the model hears "rejected", not "repeated".
- CONSECUTIVE rejections are counted per tool; at `MAX_TOOL_REJECTIONS`
  (5) the tool joins `removedTools`. A successful call resets the count:
  a narrow policy reject rule brushed against during otherwise-approved
  work never removes the tool, while a model rephrasing a refused call
  with nothing approved in between loses it quickly.

Both records live on the runPrompt frame, so they survive checkpoint and
resume within one `llm()` call and reset when the next one starts.

The refusal gates decide from state that mutates as parallel siblings
complete, so each call's verdict is computed exactly once, inside its
own step, and persisted in `runnerState`. See "Resume re-runs the code
between steps" in [`promptRunner.md`](promptRunner.md) for the rule and
the incident behind it.

## A handoff beside another call

A `handoff def` continues the caller's conversation
(docs/dev/language/handoff-functions.md), so its body's messages must
come after every tool result in its round. The tool loop runs the other
calls first and the handoff last, in a second batch. Two handoffs in
one round both get the `tooManyHandoffs` verdict, as tool messages, and
the other calls run. Only handoffs that pass every other check count
(`runnableHandoffs`), so this check runs last. The model has no way to
tell which tools are handoffs, so the text names the handoff tools the
round called and tells the model to call one of them again in a new
response.

## A result over the cap

A tool result longer than `maxToolResultChars` is cut at the cap with the
`[tool result truncated]` marker, which counts toward the cap. When the
call sets `spillToolResultsOver`, a result longer than that or than the cap
is not cut: the loop saves the whole text in the run's output store and
sends the model the same preview `safeBash` gives for long command output,
a few lines from each end and a name to read the rest with `readSpill`. A
result from `readSpill` or `grepSpill` itself is already saved, so it is
cut with a marker saying to read a smaller slice. Which tools the call
offers never changes any of this. The rules, the store, and the readers
are in `docs/dev/stdlib/spill.md`.

## Tests

- Pure helpers: `lib/runtime/toolLoopGuards.test.ts` (`markupArgument`,
  `repeatKey`, `noteRepeat`).
- The round cap: `lib/runtime/prompt.toolRounds.test.ts` runs the loop
  against a scripted client with a cap of 3 and checks the fourth round
  is refused with the message above, the request after it offers no
  tools and no hosted tools, a second `llm()` call in the same frame
  counts from zero, and the sources of the cap combine as stated. `tests/agency-js/
  max-tool-call-rounds` and `subagent-inherits-tool-rounds` cover the
  branch default through compiled code.
- Handoffs: `tests/agency-js/handoff` scripts a handoff beside other
  calls (`notAlone`, `siblingPause`, `handoffWithDraft`), two handoffs
  in one round (`twoHandoffs`), a guard between the batches
  (`feedbackBeforeHandoff`, `guardStopsHandoff`), and a rejected handoff
  call (`rejectHandoff`).
- Rejections: `tests/agency-js/tool-rejection` scripts a handler reject
  (reason + identical-retry gate), an interactive reject with a reason,
  five consecutive rejections removing the tool, an approval resetting
  the count, and the parallel replay scenarios: a rejection beside a
  pausing sibling, empty-id providers across rounds, and a fifth
  rejection landing beside a paused call whose approval must still be
  honored (`removalRace`).
- Real wiring: `tests/agency-js/repeated-tool-calls` scripts five
  identical calls and one garbled one through a fake client and checks
  the tool ran four times (the fourth call was refused and the count
  restarted), the refusal names the call, the garbled call never ran, and
  `maxRepeatedToolCalls: 0` runs all five.
