# Decision models: the options considered

This is the record of the design discussion on 2026-09-25 and 2026-09-26
that led to `decision-models.md`. It exists so that if the shipped design
is ever reopened, for the `decision` block, for batching, or for how
`llm()` exposes probabilities and logprobs, the alternatives and their
costs are on file rather than re-derived.

The discussion had one problem underneath it: **a model call returns a
value plus metadata, and Agency has no way to say so.** Jev returns an
answer plus probabilities and a confidence. A text model with logprobs
enabled returns tokens plus a probability per token. A local reasoning
model returns text plus its thinking. Today `llm()` returns the value and
the rest is dropped. Nothing outside tests reads `thinkingBlocks` from a
completion, and smoltalk has no logprobs field at all.

## Part 1: How other systems return a value plus metadata

Three patterns turned up, and every option below is one of them.

**A wrapper type.** The return value is a record that holds the value and
the metadata. The OpenAI SDK's `.parse()` returns the whole completion with
the parsed value nested inside it. DSPy returns a `Prediction` holding the
named outputs plus `completions` and `metadata`. Agency's own `Result<T>`
is this pattern, and a `Failure` carries `skippedFunctions` inline.
Cost: every caller unwraps, including the majority that never read the
metadata.

**A second return value.** Instructor's `create_with_completion` returns a
tuple `(model, raw_completion)`, while plain `create` returns the model
alone. Go's `value, err` is the same idea. Instructor had to bolt a
`_raw_response` attribute onto list results because a list cannot be a
tuple, which shows the pattern's edge. Cost: two functions, or a flag, per
call.

**A side channel.** BAML puts nothing extra in the return value. A
`Collector` attached to the call records the raw request, response,
usage, and timing, read after the fact. Agency already has two side
channels of this kind: statelog, and the message thread. smoltalk's
`AssistantMessage` carries `thinkingBlocks`, `usage`, `cost`, and
`rawData` on every reply. Cost: the metadata is a step away from the
value, and the language needs an accessor.

## Part 2: The three things Jev's API bundles

Jev's request bundles three ideas that Agency had to take apart, because
trying to design one API for all three at once kept stalling.

1. **State separate from questions.** Jev sends a document and a map of
   questions. Agency already separates these: the thread is the state, and
   the prompt is the question. The mapping is "the thread's messages become
   the state." No new concept.
2. **Many questions at once.** Jev answers up to 64 questions in one
   request, and its docs quote 12x cheaper and 10x faster for 13 questions
   batched versus 13 requests. Agency already has two forms of this:
   structured output, where an object type with three fields is three
   questions in one call, and `parallel` blocks, which run through
   `runBatch`. No new concept, but a runtime mechanism to batch (Part 5).
3. **Probabilities.** New. Agency had never returned a number
   that means "how sure the model is." This is the same thing as logprobs.

The design effort went to the third. The first two lean on what exists.

## Part 3: Options for how a decision call is written

### Option A: a `decision(state, questions)` function taking data

```ts
const t = decision(ticket, {
  department: choice("Which team should handle this?", { billing: "payments, refunds", support: "help, bugs" }),
  urgency: score("How urgent?", ["not urgent", "somewhat urgent", "urgent", "critical"]),
  churn: noul("Likely to cancel?"),
})
```

Matches Jev's wire shape one to one. Zero new type machinery. Ships in a
week. The return type can be inferred for a literal questions object, with
`choice`, `score`, and `noul` as generic helpers and `decision` generic over
the object. It cannot be inferred for a questions object built up at
runtime with `if`; that case gets `ChoiceAnswer | ScoreAnswer | NoulAnswer`
per key, narrowed with `match` on the answer's `type` tag. Keeping Jev's
`type` tag on every answer was decided here and survived into the shipped
smoltalk types.

Set aside because it is a second way to ask for structured output. It
competes with the type annotation instead of reusing it, and a user who
prototyped against a text model would rewrite the call to move to Jev.

### Option B: the type annotation is the question set

```ts
type Triage = {
  @jsonSchema({ description: "Which team should handle this?" })
  department: Choice<{ billing: "payments, refunds", support: "help, bugs" }>,
  urgency: Score<["not urgent", "somewhat urgent", "urgent", "critical"]>,
  churn: Noul
}
const t: Triage = decision(ticket)
```

Reads like Agency, and the compiler already turns a type into a schema. The
cost is three built-in generic types, one of which, `Choice`, carries a
description per option, which is a value inside a type. Agency has
value-parameterized types, so it is not new ground, but heavier than
anything `llm()` asks of a type today.

Partly shipped: the plain-type reading of this, where a union of literals is
a choice and a boolean is a noul, is the design that won (Option E). The
wrapper types `Choice<T>` and `Score<...>` are deferred.

### Option C: the user writes the answer type, the runtime checks the questions

```ts
type Triage = { department: Choice<"billing" | "support">, urgency: Score | null, churn: Noul }
const t: Triage! = decision(ticket, questions)
```

The `!` pattern applied to decisions. The type is the contract; the
questions are data validated against it before the call. Precise types in
the dynamic case because the user asserted them. Cost: the shape is written
twice, and the type cannot check option descriptions, only keys. Set aside
with Option A.

### Option D: fill in the blanks

```ts
const filled = decision({
  subject: "Refund not received",
  body: "I cancelled two weeks ago...",
  department: choice("Which team should handle this?", { billing: "...", support: "..." }),
  churn: noul("Likely to cancel?"),
})
filled.department.choice   // "billing"
```

The object before the call has blanks; the object after has them filled.
The known fields are the state, so the separate state argument disappears,
which is Jev's own model expressed as one record. Input and output have the
same shape, so a field added under an `if` is optional in the output for a
reason the user can see. It rhymes with templates, where `fill` replaces
holes. It might generalize to `llm()` as a second way to ask for structured
output.

Set aside because it is that second way, with a new concept, blanks, to
learn. Worth keeping in mind if a "complete this record" call is ever
wanted for text models too.

### Option E, shipped: a decision model is a `model` you point a typed `llm()` call at

```ts
type Dept = "billing" | "support"
const department: Dept = llm("Which department should handle this?")
const churn: boolean = llm("Likely to cancel?")
```

Both lines are valid Agency today, and an ordinary model answers them
through structured output. So "a union of literals is a choice, a boolean
is a noul" is not a Jev feature. It is a general reading of types Agency
already has, and Jev is a model that answers those shapes cheaply and with
probabilities. The model is the swappable part, through the `model`
option, as it already is. A user prototypes against Claude, switches to
Jev, and changes nothing.

This is what shipped, with the thread as the state, the answer appended to
the thread so a later call can read it, and the full answer riding on the
assistant message's `rawData`. See `decision-models.md`.

Three things it did not solve cleanly, each deferred:

- **Score.** `number` says nothing about ordered levels with descriptions.
  Needs a `Score<...>` wrapper.
- **Per-option descriptions.** A union type has no place to describe each
  member, and Jev's accuracy leans on descriptions. JSON Schema has no
  description on `enum` values; the standard form is a `oneOf` of `const`
  values each with a `description`, and providers accept it. A per-member
  `@jsonSchema` form would serve text models too, since they classify
  better with described options. One annotation for both.
- **Probabilities are dropped at the value.** A bare `boolean` is
  `noul >= 0.5`. `Choice<T>` fixes it, see Part 4.

## Part 4: Options for where the probability lives

This is the part that also decides logprobs, and it is still open.

The cases split by whether the metadata is *part of the answer* or *about
the call*. Jev's confidence is part of the answer: TypeSafe's own docs tell
you to branch on it, below 0.5 to a human, above 0.9 act. Logprobs and
thinking are about the call: most code never reads them. So the working
rule was: a function whose point is probabilities returns them inline, and
a function whose point is text offers them on the side.

### Inline, by wrapper type, opt-in

```ts
const d: Dept = llm("Which department?")            // "billing"
const d: Choice<Dept> = llm("Which department?")    // { choice: "billing", confidence: 0.86, probabilities: {...} }
```

The annotation asks for the whole record. Nothing changes for callers who
want the bare value. This is the planned next step for decisions. It could
extend to text: a `WithLogprobs<T>` or similar wrapper on any `llm()` call
would make the return value carry the token probabilities. Cost: a new
generic type per kind of metadata, and the mapping must recognize each.

### A second return value

```ts
const [d, meta] = decide("Which department?")
```

Agency has array destructuring, so the syntax is free. Cost: either a
second function per call kind, or a flag that changes the return arity,
and a list-typed value has nowhere to attach the second value in a
non-destructured position. Instructor's `_raw_response` hack is the
warning. Not chosen for decisions; not ruled out for logprobs.

### The side channel: the message thread

smoltalk's `AssistantMessage` already has `thinkingBlocks`, `usage`,
`cost`, and `rawData`. The decision branch now puts the full `DecideResult`
in `rawData`. What is missing is a way for Agency code to read the last
assistant message's extras, something like a `lastReply()` in `std::thread`
returning the message with those fields. That one accessor would expose
thinking, usage, and decision probabilities at once, and logprobs the day
smoltalk carries them. This is the cheapest path to "expose all the
metadata" and it serves every model kind. Not built yet.

### What logprobs need first

smoltalk has no logprobs field on `PromptResult` or `AssistantMessage`, and
none of its provider clients request them. Any Agency-level design for
logprobs starts with that field and the provider flags to request it. Then
either the side-channel accessor or a wrapper type exposes it. The
decision-model work already added `PromptResult.rawData` and the
pass-through to the assistant message, so the plumbing from a completion
to the thread exists.

## Part 5: Options for batching questions into one request

Jev's pitch is many questions per request. Three shapes were considered.

### A `decision { }` block

```ts
decision {
  setState(ticket)
  const department: Dept = llm("Which department should handle this?")
  const churn: boolean = llm("Likely to cancel?")
}
```

Everything inside runs as one request. Explicit: a reader sees the batch.
Cost: a new block keyword whose only job is grouping decision calls, and a
`setState` that duplicates what the thread already is. The owner's test for
a language feature is the kitchen appliance: a tool good for one thing
rarely pays for itself, while a tool with many uses gets combined in ways
nobody planned. This block is the single-purpose appliance.

Kept as the fallback. If runtime batching inside `parallel` proves too
invisible in practice, `decision { }` returns as a *narrowing* of
`parallel`: the same batching, the same threads, but the runtime refuses
any call in the block that is not to a decision model, so the reader knows
the whole block is one request. Easy to add after the runtime mechanism
exists, hard to remove, so it waits.

### Reuse `parallel`, batch in the runtime (planned, not built)

`parallel` is compile-time sugar for `fork`, and both run through
`runBatch`. Each arm gets a fresh subthread of the parent's active thread,
so decision calls in different arms see the same state. The mechanism:

1. When `runBatch` starts a block, it puts a collector on the async-context
   frame the arms inherit.
2. A decision call that finds a collector registers its questions and
   state and waits on a promise, instead of sending.
3. The collector groups pending calls by state, hashed once per call.
4. A group is sent when the block is quiescent: every arm has either
   settled or is waiting on the collector. Pending calls plus settled arms
   equals arms started.
5. A `seq` arm with two decision calls registers the first, gets its
   answer with the first round, then registers the second for a later
   round. Two requests, no deadlock.
6. An arm that interrupts settles with its interrupt list and counts as
   done. On resume, a completed decision call is cached by the hoisted-call
   rule and not re-sent.

The user-facing rule is one sentence: inside a parallel block, calls to a
decision model that share the same conversation go out together, once
every arm is either finished or waiting on that request.

Visibility, since the batching is invisible in source: a statelog event
`decisionBatch` naming the calls it carried and their arm ids, and a logs
viewer bar spanning them. The owner's verdict: "enough to start with... I
think I'll need to try it and see."

Two things for its plan: `parallel` and `fork` are separate `runBatch`
callers and `parallel` passes `recordBranchOutcomes: false`, so the
collector must work under both; and grouping must hash messages rather
than deep-compare every pair.

### Hand-written `fork`

Since `parallel` desugars to `fork`, a user could write the batch as a
`fork` themselves. Same collector, no new syntax. Falls out of the option
above for free.

## Part 6: Decisions made, in order

1. The type annotation is the question. Owner: "That is a machine."
2. The thread is the state.
3. The answer is written back to the thread; the full answer rides on the
   message as `rawData`.
4. Probabilities inline are opt-in and deferred; `noul >= 0.5` for now.
5. Score needs its own type; deferred.
6. No `decision { }` block yet; batching is a runtime collector; statelog
   and the viewer make it visible.
7. smoltalk gets `decide()` alongside `embed()`, not a `text()` variant.
8. The provider is the switch. `provider: "typesafe"` marks any unknown
   model or endpoint as one that speaks the decision protocol.
9. The registry name is checked before the call's provider, because the
   runtime fills in the default provider on every call (found during
   implementation, see `decision-models.md`).
10. The experiment runs Jev first, Laya second, and the default model last
    as the "file unchanged" check. Owner's correction of the original
    order.

## Part 7: Where to pick up the logprobs discussion

Start from Part 4. The open question is whether text-model metadata gets
the side-channel accessor, the wrapper type, or both. The decision-model
work settled that answer-level metadata goes inline by wrapper; it did not
settle call-level metadata. The first concrete step on either path is a
logprobs field in smoltalk.
