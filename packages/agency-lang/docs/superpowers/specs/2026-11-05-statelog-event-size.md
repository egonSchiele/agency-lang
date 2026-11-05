# Statelog: smaller events

## The problem

A statelog file grows far faster than the run it records. A few days of
an always-on agent can write hundreds of megabytes, and past about 500 MB
a log is too large for the viewer to open.

Three things in an event can be far larger than anything a reader uses:

**Checkpoints.** When a run pauses, the node returns its interrupts, and
each interrupt carries the checkpoint: every stack frame's arguments and
locals. `exitNode` logs that value whole. A failure result can carry a
checkpoint in the same way. If a large value, such as a list of tools with
their schemas, is passed down through three frames, the checkpoint holds
three copies of it.

**The doubled return value.** The node that ends a run logs its return
value in `exitNode.data.data`. `agentEnd.result` then logs the same value.

**Large values.** A node that returns a big structure logs all of it. A
failure result also carries the failed function's `args`, which can be
several times larger than the value the function would have returned.

## What the readers use

- The logs viewer and `agency logs traces | outline | search` read
  `exitNode` and `agentEnd` for timing and for how the run ended. They do
  not read the payload.
- Eval (`evalRecord`, `agency eval extract`) reads `agentEnd.result` as the
  run's output when the agent made no `evalOutput` call, and the `value` of
  `evalOutputRecorded` and `evalValueRecorded` events. It caps each value
  at 100,000 bytes and marks it `truncated`.
- Nothing reads a checkpoint from the log. `checkpointCreated` already
  records the checkpoint's id, reason, and source location.

## The changes

### 1. Leave checkpoints out of the log

A checkpoint is logged as the text `[checkpoint <id>]`, or `[checkpoint]`
when it has no id, in two places:

- the `checkpoint` field of an interrupt;
- the `checkpoint` field of a failure result.

Everything else on the interrupt or the failure is logged as before.

This is a scrub rule beside the redact rule and the binary-data rule in
`lib/runtime/redactForStatelog.ts`, so it applies to every event and both
sinks. The value handed back to the caller is unchanged.

### 2. Log the final return value once

When a run finishes, the `exitNode` event of its last node leaves out
`data.data`, and `agentEnd.result` holds the value.

Two cases keep the value in `exitNode`:

- A node that hands off to another node logs the data it passes on, as it
  does today.
- A run that pauses logs its interrupts. A paused run writes no `agentEnd`,
  so no other event has them.

A node with conditional edges that returns normally also ends the run, and
its value is left out in the same way.

### 3. Cap what an event can hold

One cap, `log.maxValueChars`, default 100,000. It bounds two things:

- **Every string** in an event.
- **Every top-level field** of an event's `data` (`result`, `args`,
  `output`, and so on), measured as serialized JSON.

Setting it to `0` turns both off. Like the other `log` keys, it is read
when the program is compiled.

**Strings.** A longer string is cut so that, with its marker, it fits the
cap. It ends with `…[truncated 115,748 chars]`, giving the number removed.
The marker fits inside the cap so that a cut string is never over a field
budget of the same size and cut a second time. The cap is
applied to what the scrub rules produce, so a string that was redacted or
came from a `toJSON` method is cut too.

**Fields.** Each top-level field has its own budget. The field is walked in
order, counting the characters it will serialize to. Once the budget is
spent:

- the rest of an array becomes one item, `[truncated: 131 more items]`;
- the rest of an object becomes one key, `"__truncated": "12 more keys"`;
- a string is cut to what is left of the budget.

What came before the cut is kept whole. An object that really has a key
named `__truncated` cannot be told from the marker.

The budget is per field, not per event, so one large field cannot push the
small ones out of the event.

**`promptCompletion.messages` has no field budget.** The string cap still
bounds each message. The budget keeps a prefix, and for a conversation the
part worth keeping is the end: the tool result the model just received and
the message it is answering. Cutting the list would also make the viewer
show a rewritten history where none was rewritten. See "Not in this
change".

**The marker.** An event that lost anything gets `truncated: true` on
`data`, so a reader can tell a partial value from a complete one. Eval
copies the flag onto its `StatelogEvalValue` for a value it read from a
truncated event.

**Where it runs.** In `stringifyStatelogEvent`, after the scrub rules.
The event is serialized as today, with the string cap applied to each
value the rules return. If no top-level field is over the budget, that
text is the result. Otherwise the scrubbed text is parsed, the oversized
fields are trimmed, and the event is serialized again. Trimming the
scrubbed text, and not the live value, keeps redaction working: redact
tags live on the original objects, and a trimmed copy would not carry
them.

An event that loses nothing is byte-for-byte what it is today.

## Why 100,000

- It is the cap eval already applies to an output, so the log keeps
  everything eval can use.
- It is the default of `client.maxToolResultChars`, the most of one tool
  result a model sees. A tool result is logged as the model saw it.
- A system prompt of tens of thousands of characters is common in a
  coding agent. A lower string cap would cut it in every LLM call.

A string cap alone is not enough. The largest events are often made of
tens of thousands of small values, not a few long strings, and a string
cap removes nothing from them. A depth cap is also the wrong tool: it cuts
a legitimately deep return value and leaves a wide one alone.

## What is lost

- Reading a paused run's locals from the raw log. The debugger and the
  checkpoint the caller holds still have them.
- The tail of a value over 100,000 characters. Eval already cut it at that
  size.

## Format version

The envelope's `format_version` stays 1. Every field a reader uses is
still present, and the new `truncated` flag is optional.

## Decisions

- The hosted statelog server does not read checkpoints from events, so
  change 1 is safe for it.
- There is no flag for a full log. `log.maxValueChars: 0` turns the cap
  off; checkpoints are never logged.
- A failure result keeps its `args` field. The field budget bounds it.

## Not in this change

Every LLM call logs the whole conversation so far, so a long session logs
its history once per round. For an agent with long sessions this is the
largest part of the log, and nothing here reduces it beyond the string
cap. Logging only the messages a round added would fix it, but it changes
every reader of `promptCompletion`, and needs its own spec.

## Tests

- A paused run's `exitNode` holds no checkpoint, and the interrupt returned
  to the caller still does.
- A failure result's checkpoint is logged as `[checkpoint …]`.
- A `checkpoint` key on any other object is logged whole.
- A finished run's return value appears once in the log, in `agentEnd`.
- A final node with conditional edges that returns normally logs its value
  once.
- A node that hands off still logs the data it passes on.
- A string over the cap is cut and reports the count removed.
- A long string that contains a redacted secret is both redacted and cut.
- A field over its budget keeps a valid prefix, ends with the marker, and
  the event carries `truncated: true`.
- A trimmed field's serialized length is at most the budget plus one item,
  for an array of small numbers.
- An oversized `messages` list on a `promptCompletion` is logged whole,
  with each long string cut.
- An event with one oversized field keeps its other fields.
- An event larger than the cap with no field over it is byte-for-byte what
  it is today.
- A string result of 40,000 characters is logged whole in `agentEnd`, and
  so is an `evalOutputRecorded` value of that size.
- `evalRecord` reports `truncated` for a cut `agentEnd.result` and a cut
  `evalOutputRecorded` value.
- A cap set in `agency.json` reaches the client.
