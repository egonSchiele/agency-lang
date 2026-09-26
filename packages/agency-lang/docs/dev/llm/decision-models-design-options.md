# Decision models: the options considered

The alternatives to the shipped design in `decision-models.md`, each with
what it costs, so that reopening any of them, for a `decision` block, for
batching, or for how `llm()` exposes probabilities and logprobs, starts
from this page rather than from scratch.

One problem sits under all of them: **a model call returns a value plus
metadata, and Agency has no way to say so.** Jev returns an answer plus
probabilities and a confidence. A text model with logprobs enabled returns
tokens plus a probability per token. A reasoning model returns text plus
its thinking. `llm()` returns the value and drops the rest.

## Three ways to return a value plus metadata

**A wrapper type.** The return value is a record holding the value and the
metadata. The OpenAI SDK's `.parse()` returns the whole completion with the
parsed value nested inside; DSPy returns a `Prediction` with the outputs
plus `completions` and `metadata`; Agency's `Result<T>` is this pattern.
Cost: every caller unwraps, including the majority that never read the
metadata.

**A second return value.** Instructor's `create_with_completion` returns
`(model, raw_completion)` while plain `create` returns the model alone.
Instructor had to bolt a `_raw_response` attribute onto list results
because a list cannot be a tuple, which shows the pattern's edge. Cost: two
functions, or a flag, per call.

**A side channel.** Nothing extra in the return value; a collector or log
holds the metadata, read after the fact. Agency has two already: statelog,
and the message thread, where smoltalk's `AssistantMessage` carries
`thinkingBlocks`, `usage`, `cost`, and `rawData`. Cost: the metadata is a
step away from the value, and the language needs an accessor.

## What Jev's API bundles

Jev's request bundles three ideas, taken apart because one API for all
three kept stalling.

1. **State separate from questions.** Agency already separates these: the
   thread is the state, the prompt is the question.
2. **Many questions at once.** Jev answers up to 64 questions per request
   and quotes 12x cheaper and 10x faster for 13 questions batched versus 13
   requests. Agency has two forms of this: structured output, where an
   object type with three fields is three questions, and `parallel` blocks.
   What is missing is a runtime mechanism to batch (below).
3. **Probabilities.** New. Agency had never returned a number meaning "how
   sure the model is." This is the same thing as logprobs.

## How a decision call is written

### A `decision(state, questions)` function taking data

```ts
const t = decision(ticket, {
  department: choice("Which team should handle this?", { billing: "payments, refunds", support: "help, bugs" }),
  urgency: score("How urgent?", ["not urgent", "somewhat urgent", "urgent", "critical"]),
  churn: noul("Likely to cancel?"),
})
```

Matches Jev's wire shape one to one, with no new type machinery. The return
type is inferable for a literal questions object; a questions object built
up at runtime gets `ChoiceAnswer | ScoreAnswer | NoulAnswer` per key,
narrowed with `match` on the answer's `type` tag.

Set aside because it is a second way to ask for structured output. It
competes with the type annotation instead of reusing it, and a program
prototyped against a text model would have to be rewritten to move to Jev.

### The type annotation as the question set, with wrapper types

```ts
type Triage = {
  @jsonSchema({ description: "Which team should handle this?" })
  department: Choice<{ billing: "payments, refunds", support: "help, bugs" }>,
  urgency: Score<["not urgent", "somewhat urgent", "urgent", "critical"]>,
  churn: Noul
}
const t: Triage = decision(ticket)
```

Reads like Agency, and the compiler already turns a type into a schema.
Cost: three built-in generic types, one of which carries a description per
option, a value inside a type. Agency has value-parameterized types, so it
is not new ground, but heavier than anything `llm()` asks of a type today.

Partly shipped: the plain-type reading, where a union of literals is a
choice and a boolean is a noul, is the design that won. `Choice<T>` and
`Score<...>` are deferred.

### The user writes the answer type, the runtime checks the questions

```ts
type Triage = { department: Choice<"billing" | "support">, urgency: Score | null, churn: Noul }
const t: Triage! = decision(ticket, questions)
```

The `!` pattern applied to decisions: the type is the contract, the
questions are data validated against it before the call. Cost: the shape is
written twice, and the type can check option keys but not descriptions.

### Fill in the blanks

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
and input and output have the same shape. It rhymes with templates, where
`fill` replaces holes, and might generalize to text models as a "complete
this record" call.

Set aside because it is a second way to ask for structured output, with a
new concept to learn.

### Shipped: a decision model is a `model` you point a typed `llm()` call at

```ts
type Dept = "billing" | "support"
const department: Dept = llm("Which department should handle this?")
const churn: boolean = llm("Likely to cancel?")
```

Both lines are valid Agency today, and a text model answers them through
structured output. "A union of literals is a choice, a boolean is a noul"
is a general reading of types Agency already has; Jev is a model that
answers those shapes cheaply and with probabilities. The model is the
swappable part, as it already is.

Three things it does not solve, each deferred:

- **Score.** `number` says nothing about ordered levels with descriptions.
  Needs a `Score<...>` wrapper.
- **Per-option descriptions.** A union type has no place to describe each
  member, and Jev's accuracy leans on descriptions. JSON Schema has no
  description on `enum` values; the standard form is a `oneOf` of `const`
  values each with a `description`. A per-member `@jsonSchema` form would
  serve text models too, since they classify better with described
  options.
- **Probabilities are dropped at the value.** A bare `boolean` is
  `noul >= 0.5`. `Choice<T>` fixes it, see below.

## Where the probability lives

This also decides logprobs, and it is still open.

The cases split by whether the metadata is *part of the answer* or *about
the call*. Jev's confidence is part of the answer: TypeSafe's docs tell you
to branch on it. Logprobs and thinking are about the call: most code never
reads them. So the working rule: a function whose point is probabilities
returns them inline, and a function whose point is text offers them on the
side.

### Inline, by wrapper type, opt-in

```ts
const d: Dept = llm("Which department?")            // "billing"
const d: Choice<Dept> = llm("Which department?")    // { choice: "billing", confidence: 0.86, probabilities: {...} }
```

The annotation asks for the whole record; nothing changes for callers who
want the bare value. This is the planned next step for decisions. It could
extend to text with a wrapper for token probabilities. Cost: a new generic
type per kind of metadata, and the mapping must recognize each.

### A second return value

```ts
const [d, meta] = decide("Which department?")
```

Agency has array destructuring, so the syntax is free. Cost: a second
function per call kind, or a flag that changes the return arity, and a
list-typed value has nowhere to attach the second value when not
destructured. Not chosen for decisions; not ruled out for logprobs.

### The side channel: the message thread

The decision branch puts the full `DecideResult` in the assistant
message's `rawData`. What is missing is a way for Agency code to read the
last assistant message's extras, something like a `lastReply()` in
`std::thread`. One accessor would expose thinking, usage, and decision
probabilities at once, and logprobs the day smoltalk carries them. This is
the cheapest path to "expose all the metadata" and it serves every model
kind.

### What logprobs need first

smoltalk has no logprobs field on `PromptResult` or `AssistantMessage`, and
none of its provider clients request them. Any Agency-level design for
logprobs starts with that field and the provider flags to request it. Then
either the side-channel accessor or a wrapper type exposes it. The
decision-model work added `PromptResult.rawData` and the pass-through to
the assistant message, so the plumbing from a completion to the thread
exists.

## Batching questions into one request

### A `decision { }` block

```ts
decision {
  setState(ticket)
  const department: Dept = llm("Which department should handle this?")
  const churn: boolean = llm("Likely to cancel?")
}
```

Everything inside runs as one request, and a reader sees the batch. Cost: a
new block keyword whose only job is grouping decision calls, and a
`setState` that duplicates what the thread already is. A language feature
good for one thing rarely pays for itself.

Kept as the fallback. If runtime batching inside `parallel` proves too
invisible in practice, `decision { }` returns as a *narrowing* of
`parallel`: the same batching, but the runtime refuses any call in the
block that is not to a decision model, so the reader knows the whole block
is one request. Easy to add after the runtime mechanism exists, hard to
remove, so it waits.

### Reuse `parallel`, batch in the runtime (planned, not built)

`parallel` is compile-time sugar for `fork`, and both run through
`runBatch`. Each arm gets a fresh subthread of the parent's active thread,
so decision calls in different arms see the same state. The mechanism:

1. When `runBatch` starts a block, it puts a collector on the async-context
   frame the arms inherit.
2. A decision call that finds a collector registers its questions and
   state and waits on a promise, instead of sending.
3. The collector groups pending calls by state, hashed once per call.
4. A group is sent when the block is idle: every arm has either
   settled or is waiting on the collector. Pending calls plus settled arms
   equals arms started.
5. A `seq` arm with two decision calls registers the first, gets its
   answer with the first round, then registers the second for a later
   round. Two requests, no deadlock.
6. An arm that interrupts settles with its interrupt list and counts as
   done. On resume, a completed decision call is cached by the hoisted-call
   rule and not re-sent.

The user-facing rule: inside a parallel block, calls to a decision model
that share the same conversation go out together, once every arm is either
finished or waiting on that request.

Since the batching is invisible in source, it needs a statelog event
`decisionBatch` naming the calls it carried and their arm ids, and a logs
viewer bar spanning them.

Two constraints for its plan: `parallel` and `fork` are separate
`runBatch` callers and `parallel` passes `recordBranchOutcomes: false`, so
the collector must work under both; and grouping must hash messages rather
than deep-compare every pair.

### Hand-written `fork`

Since `parallel` desugars to `fork`, a user could write the batch as a
`fork` themselves. Same collector, no new syntax.
