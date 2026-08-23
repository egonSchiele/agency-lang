# Tool-loop guards: repeated calls and markup arguments

Two refusals in `runPrompt`'s tool loop (`lib/runtime/prompt.ts`) that
stop a model from wasting rounds. Both happen before the tool's
`onToolCallStart` hook, so a refused call never runs, never fires hooks,
and never counts toward `MAX_TOOL_FAILURES`. The model sees the refusal as
an ordinary tool message, which is where it reads results.

## Repeated calls

Seen in an eval: the Agency writer made 45 identical `typecheck` calls,
each returning "no errors", over four minutes. Nothing changed between
calls, and nothing was going to.

`repeatKey` identifies a call by tool name plus the arguments as
canonical JSON (keys sorted at every level, so argument order does not
make a new key). After every run, `noteRepeat` records the stringified
result and counts how many times in a row this key produced this exact
result. When that count reaches `maxRepeatedToolCalls` (default 3), the
next identical call is refused:

> Error: this is call 4 to typecheck with exactly these arguments, and
> the previous 3 all returned the same result. It was not run. Say what
> you expected to change, then either call it with different arguments
> or continue without it.

A different result starts the count over, so a tool that legitimately
returns something new each time (a clock, a queue) never trips it, and the
guard applies to every tool regardless of its `idempotent` or
`destructive` markers: the signal is "same input, same output, asked
again", not the tool's nature.

Setting: `llm(..., { maxRepeatedToolCalls: n })` per call,
`setLlmOptions({ maxRepeatedToolCalls: n })` per branch; `0` disables.
The records live on the runPrompt frame (`self.repeatedCalls`) and are
written inside the idempotent `invoke` step, so an interrupt/resume does
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
flags a string argument that starts with `</antml` or contains
`<parameter name=`; the call is refused with a message naming the
argument and asking for the call again without it. The model recovers in
one round instead of two or three blind retries.

## Tests

- Pure helpers: `lib/runtime/prompt.test.ts` (`markupArgument`,
  `repeatKey`, `noteRepeat`).
- Real wiring: `tests/agency-js/repeated-tool-calls` scripts five
  identical calls and one garbled one through a fake client and checks
  the tool ran three times, two refusals name the call, the garbled call
  never ran, and `maxRepeatedToolCalls: 0` runs all five.
