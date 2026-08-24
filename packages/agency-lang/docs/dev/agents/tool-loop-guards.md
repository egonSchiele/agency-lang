# Tool-loop guards: repeated calls and markup arguments

Two refusals in `runPrompt`'s tool loop that stop a model from wasting
rounds. The helpers live in `lib/runtime/toolLoopGuards.ts`; `prompt.ts`
only calls them. Both happen before the tool's
`onToolCallStart` hook, so a refused call never runs, never fires hooks,
and never counts toward `MAX_TOOL_FAILURES`. The model sees the refusal as
an ordinary tool message, which is where it reads results.

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

## Tests

- Pure helpers: `lib/runtime/toolLoopGuards.test.ts` (`markupArgument`,
  `repeatKey`, `noteRepeat`).
- Real wiring: `tests/agency-js/repeated-tool-calls` scripts five
  identical calls and one garbled one through a fake client and checks
  the tool ran four times (the fourth call was refused and the count
  restarted), the refusal names the call, the garbled call never ran, and
  `maxRepeatedToolCalls: 0` runs all five.
