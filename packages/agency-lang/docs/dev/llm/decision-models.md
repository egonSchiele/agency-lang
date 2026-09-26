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
does not change. That was the claim the design was built to test, and the
example in `packages/examples/decision-triage.agency` is the proof: it ran
unchanged against Jev, a local Laya server, and the default model.

The rule: **the provider is the switch.** A call is a decision
call when its provider is `typesafe`, either written on the call, or looked
up from the registry for a model name it knows.

Spec: `2026-09-25-decision-models-spec.md`. Plan:
`2026-09-26-decision-models-slice-2-plan.md`. Both at the root of this
package. The options that were considered and set aside are in
`decision-models-design-options.md` next to this file.

## The lifecycle of one call

Follow `const dept: Dept = llm("Which department?", { model: "jev-1.13" })`.

1. **The compiler** (`lib/backends/typescriptBuilder.ts`, the `llm` case)
   emits one `runPrompt({...})` call. The type annotation becomes
   `responseFormat`, always wrapped as `z.object({ response: <schema> })`.
   The options object becomes `clientConfig`, passed through as written.
2. **`runPrompt`** (`lib/runtime/prompt.ts`) appends the prompt to the
   active thread as a user message, then builds a `PromptConfig` from the
   thread's messages, the schema, and the options. It fills in the config
   default provider on a call that named only a model.
3. **`dispatchLLMRequest`** (`lib/runtime/llmDispatch.ts`) asks
   `isDecisionCall`. If yes, it calls `dispatchDecision` and returns. If no,
   the call goes to `text()` or `textStream()` as before. The metering
   wrapper in `dispatchWithRetry` asks the same question to pick the usage
   kind, `decision` or `completion`.
4. **`dispatchDecision`** (`lib/runtime/decisionDispatch.ts`) refuses a call
   with tools, refuses a call with no schema, and then hands the schema and
   the prompt to `planDecision`.
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

## Why the registry is checked before the provider

`runPrompt` puts the configured default provider, `openai-responses`
unless set, onto every call that named only a model. So by the time a call
reaches dispatch, `config.provider` cannot tell "the user wrote `typesafe`"
from "the default was filled in". An explicit-provider-wins rule sent
`jev-1.13` with no provider written to `text()`. The execution test caught
it; the unit tests had not, because they built the config by hand.

So `isDecisionCall` first asks the registry what provider the model name
belongs to, and only then looks at `config.provider`. And
`dispatchDecision` always passes `provider: "typesafe"` to the client, never
the filled-in value.

## From a type to questions

| Annotation | Question | Instructions |
| --- | --- | --- |
| a union of string literals, or an enum | one `choice`, named `answer`, one option per literal, each option described by its own name | the prompt |
| `boolean` | one `noul`, named `answer` | the prompt |
| an object type | one question per top-level field, named after the field, each field mapped by the two rows above | the field's `@jsonSchema` description, else the field name |

For an object type the prompt is not the instructions of any question. It
is a user message in the thread, so it is part of the state, the same as
for every `llm()` call.

Refused, each with a failure naming the field: a number, a string that is
not a literal union, an array, a nested object, an optional or nullable
field, a union with a member that is not a string literal, and an object
with no fields. A call with no annotation at all fails with "add a type
annotation". A call with tools fails with "cannot call tools". All of these
fail before any request is sent.

## The state

The state is the thread's messages as a JSON array of `{ role, content }`.
Only text goes in. Tool result messages are left out, and so is an
assistant message that carried only tool calls. A user message with several
text parts arrives joined with newlines, which is smoltalk's content
getter. Attachments are not sent.

Because the reply is appended to the thread, a later `llm()` call sees it.
In the example, the follow-up question "should a manager call the customer
today?" reads the triage from the thread and answers `true`. That
composition, a cheap decision feeding the next call, is the reason the
thread is the state.

## The lossy step

A bare `boolean` is `noul >= 0.5`. The probability is thrown away at the
value level. It survives on the assistant message's `rawData`, but nothing
in Agency reads that yet. A `Choice<T>` wrapper type that returns the whole
answer record, with confidence and probabilities, is the planned fix, and
a `Score<...>` type for the third question kind comes with it. Until then a
score answer is never produced, since no annotation maps to one.

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

Results of the three runs on 2026-09-26, same file:

| Backend | triage | follow-up |
| --- | --- | --- |
| Jev through OpenRouter | `{ department: 'billing', churn: true }` | `true` |
| Laya, local | `{ department: 'support', churn: true }` | `true` |
| Default model (gpt-5-mini) | `{ department: 'billing', churn: true }` | `true` |

Laya's `support` is the wrong answer. Its published numbers put it well
behind Jev on choice questions, and this is what that looks like.

## Testing

- `lib/runtime/decisionQuestions.test.ts`: every accepted shape and every
  refused shape, the answer mapping, and the state.
- `lib/runtime/decisionDispatch.test.ts`: the routing rule, the completion
  shape, the key-merge rule, and the four refusals.
- `lib/runtime/llmClient.decide.test.ts` and the `DeterministicClient.decide`
  cases in `deterministicClient.test.ts`: the client contract.
- `tests/agency-js/decision-model/`: the compiled path end to end. The test's client
  records what the runtime sent, so the fixture pins the state, the
  questions, and the config for a bare call, an object call, and a call
  under a cost guard.

Not covered by a test: that the usage breakdown has a `decision` row after
a run. The guard trip shows the cost reached the branch, but no test reads
the breakdown.

## What is deferred

The spec's Part 6 lists it: `Choice<T>` and `Score<...>` wrapper
types, per-member `@jsonSchema` descriptions so an option can be described
rather than only named, a way for Agency code to read an assistant
message's `rawData`, batching several decision calls in a `parallel` block
into one request, and an in-process Laya backend.
