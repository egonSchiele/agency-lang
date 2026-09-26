# Decision models (Jev, Laya)

A decision model does not write text. You send it a state and typed
questions, and it answers every question in one pass with probabilities.
TypeSafe's Jev is one. Laya is an open-weights model that speaks the same
protocol. In Agency, a decision model is a `model` you point an existing
typed `llm()` call at:

```ts
type Dept = "billing" | "support" | "sales"
const dept: Dept = llm("Which department should handle this ticket?")
```

Run that against the default text model and it goes through structured
output. Run it with `--model typesafe/jev-1.13` and it goes to Jev. The file
does not change. `packages/examples/decision-triage.agency` runs unchanged
against Jev, a local Laya server, and the default model.

The rule: **the provider is the switch.** A call is a decision call when
its provider is `typesafe`, either written on the call, or looked up from
the registry for a model name it knows.

The options that were considered and set aside are in
`decision-models-design-options.md` next to this file.

## The lifecycle of one call

Follow `const dept: Dept = llm("Which department?", { model: "jev-1.13" })`.

1. **The compiler** (`lib/backends/typescriptBuilder.ts`, the `llm` case)
   emits one `runPrompt({...})` call. The type annotation becomes
   `responseFormat`, always wrapped as `z.object({ response: <schema> })`.
   The options object becomes `clientConfig`, passed through as written,
   except that the compiler bakes the config's default provider into every
   call that named only a model. (When only `defaultModel` is configured
   and no `defaultProvider`, nothing is baked, and smoltalk's registry
   picks the provider.)
2. **`runPrompt`** (`lib/runtime/prompt.ts`) appends the prompt to the
   active thread as a user message, then builds a `PromptConfig` from the
   thread's messages, the schema, and the options.
3. **`dispatchWithRetry`** (`lib/runtime/llmDispatch.ts`) asks
   `isDecisionCall` once, before metering. If yes, `prepareDecision`
   refuses a call with tools, with no schema, with a shape it cannot map,
   with more questions than the model accepts, or with a client that has no
   `decide`, and otherwise builds the plan. The plan goes down to
   `dispatchLLMRequest`, which calls `dispatchDecision` when it has one and
   `text()` or `textStream()` when it does not. The usage kind, `decision`
   or `completion`, comes back up with the result, so nothing after this
   point asks the question again.
4. **`dispatchDecision`** (`lib/runtime/decisionDispatch.ts`) sends the
   plan's questions and the thread as state.
5. **`planDecision`** (`lib/runtime/decisionQuestions.ts`) strips the
   envelope and turns the schema into a map of questions. The table below
   says how. `messagesToState` turns the thread into the state.
6. **The client's `decide()`** (`lib/runtime/llmClient.ts`) sends the state
   and questions through smoltalk's `decide()`. The deterministic client in
   `lib/runtime/deterministicClient.ts` answers from a `{ decide }` mock
   instead.
7. **`answersToValue`** turns the answers back into the value the schema
   describes. `dispatchDecision` returns a completion whose `output` is the
   JSON text of `{ response: <value> }`, with the usage, the cost, the
   model, a `stop` reason, and the full `DecideResult` as `rawData`.
8. **Everything after dispatch is unchanged.** `extractStructuredResponse`
   parses the JSON against the schema as it parses any model's JSON. The
   assistant message is appended to the thread with the value as its
   content and the full answers as its `rawData`. Cost and tokens reach the
   branch totals under the `decision` kind. Statelog gets its usual
   `promptCompletion` event.

The decision branch is the only new code on the path. Nothing in the parse,
the thread, the guards, or statelog knows it exists.

## Which calls are decision calls

`isDecisionCall` has two rules, and the registry decides which applies:

- The registry knows the model name. Then only the registry's provider
  counts: `jev-1.13` is a decision call whatever provider is on the call,
  and `gpt-5-mini` never is.
- The registry does not know the name (a local Laya server, say). Then the
  call is a decision call when its provider is `typesafe`.

The call's provider is not trusted for a known name because the user may
not have written it. The compiler bakes the config's default provider,
`openai-responses` unless set, into every generated call that named only a
model, so at dispatch `config.provider` cannot tell "written" from
"defaulted". Letting the call's provider win would send `jev-1.13` with no
provider written to `text()`, and letting either rule win would make
`defaultProvider: "typesafe"`, which `--model typesafe/jev-1.13` sets,
capture every call in the run, including stdlib calls that name a text
model.

`dispatchDecision` always passes `provider: "typesafe"` to the client,
never the value on the call.

## Validation

`answersToValue` builds the value from the answers, so through
`SmoltalkClient` the structured parse always accepts it. A custom client
can still return a choice outside the union. A text model would then get
the feedback message and another attempt; a decision model cannot act on
feedback, and re-asking would send the feedback text as the question. So
`runPrompt` gives a decision call no validation retries: the first miss is
the failure.

## From a type to questions

| Annotation | Question | Instructions |
| --- | --- | --- |
| a union of string literals, or an enum | one `choice`, named `answer`, one option per literal, each option described by its own name | the prompt |
| `boolean` | one `noul`, named `answer` | the prompt |
| an object type | one question per top-level field, named after the field, each field mapped by the two rows above | the prompt, then the field's `@jsonSchema` description or its name, on a second line |

The prompt is never part of the state. It is the question, so it goes into
the instructions of every question the call asks. The thread still records
it as a user message, so a later call reads it as conversation.

Refused, each with a failure naming the field: a number, a string that is
not a literal union, an array, a nested object, an optional or nullable
field, a union with a member that is not a string literal, and an object
with no fields. A call with no annotation at all fails with "add a type
annotation". A call with tools fails with "cannot call tools". All of these
fail before any request is sent.

## The state

The state is the thread's messages before the prompt, as a JSON array of
`{ role, content }`. A thread that holds only the prompt sends it as the
state, so the model never sees an empty state. Only text goes in. Tool
result messages are left out, and so is an assistant message that carried
only tool calls. A user message with several text parts arrives joined with
newlines, which is smoltalk's content getter. Attachments are not sent.

Because the reply is appended to the thread, a later `llm()` call sees it.
In the example, the follow-up question "should a manager call the customer
today?" reads the triage from the thread and answers `true`. That
composition, a cheap decision feeding the next call, is the reason the
thread is the state.

## The lossy step

A bare `boolean` is `noul >= 0.5`. The probability is thrown away at the
value level. It is kept on the assistant message's `rawData`, which nothing
in Agency reads yet, and which survives a checkpoint only with a smoltalk
that writes `rawData` in `toJSON` (0.15.1 or later). A `Choice<T>` wrapper
type that returns the whole answer record, with confidence and
probabilities, is the planned fix, and a `Score<...>` type for the third
question kind comes with it. Until then a score answer is never produced,
since no annotation maps to one.

## Cost

A decision call is metered under the `decision` usage kind
(`lib/runtime/invocationUsage.ts`, `lib/cli/statelog/spendTypes.ts`).
smoltalk prices it from the registry entry of the requested model, so
`jev-1.13` costs input tokens times $0.042 per million, and a model the
registry does not know, which is every Laya checkpoint, costs zero. Output
is free. A cost guard trips on a decision call the way it trips on a text
call; the execution test checks that.

## Running against each backend

TypeSafe has paused signups, so these are the routes that work.

**Jev through OpenRouter.** The registry knows `jev-1.13`, so no provider
is needed on the call. The `--model` flag checks Agency's own catalog,
which does not list decision models, so on the command line write the
provider/model form:

```bash
TYPESAFE_API_KEY="$OPENROUTER_API_KEY" TYPESAFE_BASE_URL="https://openrouter.ai/api" \
  agency run --model typesafe/jev-1.13 decision-triage.agency
```

Or in `agency.json`:

```json
{ "client": { "defaultModel": "jev-1.13",
              "apiKey": { "typesafe": "<OpenRouter key>" },
              "baseUrl": { "typesafe": "https://openrouter.ai/api" } } }
```

Vercel AI Gateway also serves it, at base URL
`https://ai-gateway.vercel.sh/typesafe` with model `typesafe-ai/jev`. That
name is not in the registry, so the call needs `provider: "typesafe"`.

**Laya locally.** Install and serve, then point the base URL at it. Laya
needs no key, but the provider requires one, so any value works:

```bash
uv venv laya && source laya/bin/activate
uv pip install "laya[serve]"
LAYA_PRELOAD=1 laya-serve          # port 8000, Metal on Apple silicon
TYPESAFE_API_KEY=unused TYPESAFE_BASE_URL="http://localhost:8000" \
  agency run --model typesafe/laya decision-triage.agency
```

**The default model.** Run the same file with no flag. It goes through
structured output.

Expect Laya to answer less accurately than Jev. On the example ticket it
picks `support` where Jev and the default model pick `billing`.

## Testing

- `lib/runtime/decisionQuestions.test.ts`: every accepted shape and every
  refused shape, the answer mapping, and the state.
- `lib/runtime/decisionDispatch.test.ts`: the routing rule, the completion
  shape, the key-merge rule, the four refusals, and the HTTP status carried
  on a failed request so a 429 or 5xx retries.
- `lib/runtime/llmDispatch.decision.test.ts`: a refusal happens before any
  metered attempt, and a sent call is metered under the `decision` kind.
- `lib/runtime/llmClient.decide.test.ts` and the `DeterministicClient.decide`
  cases in `deterministicClient.test.ts`: the client contract.
- `tests/agency-js/decision-model/`: the compiled path end to end. The test
  uses a client of its own that records what the runtime sent, so the
  fixture pins the state, the questions, and the config for a bare call, an
  object call, and a call under a cost guard.

## Batching inside `parallel`

Inside a `parallel` or `fork` block, decision calls that share a
conversation go out together. The rule from the user's side: once every arm
is either finished or waiting on the decision model, the waiting calls
that share the same conversation and model are one request.

The pieces:

- `Runner.runForkAll` builds one `DecisionCollector`
  (`lib/runtime/decisionCollector.ts`) per block and passes it to
  `runBatch`, which puts `{ collector, armKey }` on each arm's async-context
  frame as `decisions`. The three frame builders that copy fields by name
  (`Runner.runInScope`, `withResumableScope`, `runInBranchAlsFrame`)
  forward it; the builders that spread the outer frame carry it for free.
  A `race` block installs none.
- `dispatchDecision` reads the frame. With a scope it submits
  `{ state, questions, config, questionCap, signal }` to the collector and
  awaits a `Result<DecideResult>`; without one it sends as before. Nothing
  else in the call path knows about batching.
- The collector keeps each arm's status: running (body executing between
  decision calls), waiting (holds an unsent call), inflight (its call was
  sent), or settled. Only a running arm blocks a quiescent round, so a call
  that is on the wire, and an arm whose waiting call was cancelled, both step
  out of the way instead of deadlocking the block. `runBatch` reports settles
  through the `onBranchSettled` hook, which fires as each branch settles, and
  at once for a cached branch on resume. The collector meters nothing itself;
  each arm meters its split share, so the shares sum to the one request's
  real usage and cost.
- A group is the calls whose `sha256` of `{ model, baseUrl, state }`
  match. A round sends every group at once when no arm is running, or one
  group alone when it reaches the model's question cap (the registry's
  `maxQuestions`, 64 for Jev, or 64 for an unknown model). A cap round
  logs a `warn` with `warnType: "decisionBatchCap"`.
- A merged request names each question `c<callId>_<name>`. Answers come
  back under their original names. Input and output tokens are split
  across the group's calls in proportion to their question counts, the
  remainder to the first call; cost is split by the same proportions.
- A failed request resolves every call in the group with the failure and
  its status, so each arm's retry loop runs as it would for its own
  request, and the retries form a new round. A call whose arm is cancelled
  while waiting leaves the group; a request is cancelled only when every
  call in it is.
- Each round is a `decisionBatch` span holding one `decisionBatch` event
  with the groups, the reason, and the time. The logs viewer summarizes it
  as `decisionBatch 2 requests · 4 questions · 3 calls (quiescent, 120ms)`.

What does not batch: a call outside any block; the arms of a `race`; a
call in a nested `parallel` with the outer block's calls (the inner block
has its own collector); and two arms that touched their thread differently
before asking, since their states differ.

One arm normally makes its decision calls one at a time, because its body
awaits each `llm()` before the next. The exception is a single text-model
call in an arm that dispatches several tools at once (`runPrompt`'s parallel
tool loop is a nested `runBatch` that installs no collector), where each tool
may make its own decision call, all under the one arm key. Those concurrent
calls still each settle correctly — a decision call is never lost — but they
usually do not batch with each other, and the arm's status tracks them only
approximately. Batching that case is not a goal.

## What is deferred

`Choice<T>` and `Score<...>` wrapper types, per-member `@jsonSchema`
descriptions so an option can be described rather than only named, a way
for Agency code to read an assistant message's `rawData`, and an in-process
Laya backend.
