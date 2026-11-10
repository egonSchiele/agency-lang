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

The `type` option is the switch. `type: "decision"` sends a typed call
to the model's decision API, and `type: "text"` sends it to the chat API.
These are the words smoltalk's registry uses for a model's kind. Without
the option, the registry decides: a model whose entry has
`type: "decision"` is a decision call, and an unknown model is one when
its provider is `typesafe`.

## The lifecycle of one call

Follow `const dept: Dept = llm("Which department?", { model: "jev-1.13" })`.

1. **The compiler** (`lib/backends/typescriptBuilder.ts`, the `llm` case)
   emits one `runPrompt({...})` call. The type annotation becomes
   `responseFormat`, always wrapped as `z.object({ response: <schema> })`.
   The options object becomes `clientConfig`, passed through as written.
2. **`runPrompt`** (`lib/runtime/prompt.ts`) appends the prompt to the
   active thread as a user message, then builds a `PromptConfig` from the
   thread's messages, the schema, and the options. Runtime defaults merge
   below branch defaults, which merge below per-call options.
3. **`dispatchWithRetry`** (`lib/runtime/llmDispatch.ts`) asks
   `isDecisionCall` once, before metering. If yes, `prepareDecision`
   refuses a call with tools, with no schema, with a shape it cannot map,
   with more questions than the model accepts, or with a client that has no
   `decide`, and otherwise builds the plan. The plan goes down to
   `dispatchLLMRequest`, which calls `dispatchDecision` when it has one and
   `text()` or `textStream()` when it does not. The usage kind, `decision`
   or `completion`, comes back up with the result, so nothing after this
   point asks the question again.
4. **`dispatchDecision`** (`lib/runtime/decision/dispatch.ts`) sends the
   plan's questions and the thread as state.
5. **`planDecision`** (`lib/runtime/decision/questions.ts`) strips the
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
   `promptStart` and `promptCompletion` events, both with
   `usageKind: "decision"`, and the completion carries a `decision` field
   with the state, the questions, and the answers as sent and received
   (see "Event catalog" in `../hosting/statelog.md`), since `messages`
   shows a chat the model never saw.

## Which calls are decision calls

`isDecisionCall` (`lib/runtime/decision/dispatch.ts`) applies three rules
in order:

1. `type: "decision"` on the call: a decision call.
2. `type: "text"` on the call: a text call.
3. No option: the registry. The model is looked up under the selected
   provider, then by its name alone. A known entry is a decision call when
   its type is `decision`. An unknown name is a decision call when its
   provider is `typesafe`.

Rule 3 reads the first entry the lookup finds. A name can have a text
entry and a decision entry under one provider, and then the call is a text
call. `gpt-6-luna` under `openai` is listed that way, so an untyped call
to it stays a chat call.

Three cases need the option:

```ts
// gpt-6-luna under openai has both entries. With no option it is a chat call.
const a: Dept = llm(q, { model: "gpt-6-luna", provider: "openai", type: "decision" })

// A local chat model, answering decisions in process through smoltalk-llama-cpp.
const b: Dept = llm(q, { model: "/models/qwen3-4b.gguf", provider: "llama-cpp", type: "decision" })

// A decision model the registry does not list yet, on any provider.
const c: Dept = llm(q, { model: "new-decider", provider: "openrouter", type: "decision" })
```

The option is per call. `setLlmOptions` does not take it: a branch default
of `type: "decision"` would turn every later call into a decision call, and
a call with tools or with no type annotation would fail. The type checker
refuses the key there, and `_setLlmOptions` throws when a value typed
`any` carries it. To send every call to a decision model the registry
lists, set the model; rule 3 covers it.

`toSmolConfig` drops the key, since smoltalk's chat config has no such
field. `questionCapFor` looks for the decision entry under the selected
provider first and falls back to the plain lookup, so `gpt-6-luna` gets
its decision entry's cap of 400 and not the default of 64.

`dispatchDecision` preserves the resolved provider. If none is set, it uses
the registry entry's provider, then `typesafe` for an unknown model. Thus
`openrouter/jev-1.13` reaches smoltalk with `provider: "openrouter"` and
uses OpenRouter's credentials and endpoint.

`mergeLlmConfig` in `lib/runtime/llmConfig.ts` applies model and provider
selection at each config layer. A model-only switch to a decision model
selects its registry provider. Switching from a decision model to a known
text model also selects the new model's registry provider. For example,
`setModel("jev-1.13")` followed by `setModel("gpt-5-mini")` selects TypeSafe,
then OpenAI.

An explicit provider wins. Repeating the current model keeps its provider,
so `model: "jev-1.13"` in a run using OpenRouter stays on OpenRouter.
Model-only changes between text models keep the existing provider.
`setModel`, `setLlmOptions`, and per-call options follow these rules.

A call with `type: "decision"`, a model, and no provider switches to the
provider of the model's first decision entry in registry order. For
`gpt-6-luna`, whose first entry is a text entry, that is `openai`. For
`jev-1.14`, listed under both `typesafe` and `openrouter`, it is `typesafe`,
the same provider the rule above picks. A model with no decision entry
keeps the provider it would have had. In a program whose default provider
is `anthropic`, that sends the request to `anthropic`, and smoltalk's
`decide()` refuses it before sending: `Provider "anthropic" does not answer
decisions. Use one of: ...`. smoltalk does not export its list of decision
providers, so Agency cannot refuse earlier. The failure has no HTTP status
and matches no transport message, so the retry classifier treats it as
terminal and the call fails once.

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

The state is the thread's messages before the prompt, as a JSON array. A
thread that holds only the prompt sends it as the state, so the model never
sees an empty state. `messagesToState` (`lib/runtime/decision/questions.ts`)
writes two kinds of entry:

- A message's text is `{ role, content }`. A user message with several text
  parts arrives joined with newlines, which is smoltalk's content getter.
- A tool result is `{ role: "tool", name, arguments, content }`. `arguments`
  are those of the call the result answers, found by the call's id.

```json
[
  { "role": "user", "content": "Where is order 123?" },
  { "role": "tool", "name": "lookup", "arguments": { "order": 123 }, "content": "shipped on Tuesday" }
]
```

The arguments ride on the result, and the call has no entry of its own. A
result then reads on its own: "lookup of order 123 returned this". Two
results from the same tool stay apart even when they arrive in another
order than their calls, and the call ids, which are long random strings,
stay out of the request. A result whose call is no longer in the thread
has no `arguments`. An assistant message that carried only tool calls has
no entry, and attachments are not sent.

A tool result is sent whole. A decision model's window is small (Jev takes
64K tokens a request), so a thread that holds a long result can be refused
by the provider. The `maxToolResultChars` option on the `llm()` call that
ran the tool is what bounds a result, since it cuts the result before it
enters the thread.

Because the reply is appended to the thread, a later `llm()` call sees it.
In the example, the follow-up question "should a manager call the customer
today?" reads the triage from the thread and answers `true`. That
composition, a cheap decision feeding the next call, is the reason the
thread is the state.

## The lossy step

A bare `boolean` is `noul >= 0.5`, and a choice returns only the chosen
option. The full answer set is kept on the reply message as `rawData`, and
`lastReply()` from `std::thread` returns it as `answers`, a
`Record<string, DecisionAnswer>` typed the same way smoltalk types it. A
bare annotation's answer is `answers.answer`; an object annotation's are
`answers.<field>`. Check `type` before reading a field, and the checker
refuses a typo.

Some models leave out part of an answer. A choice answer's `confidence`
and `probabilities`, and a score answer's `confidence`, `legend`, and
`probabilities`, can be missing, and Agency reads a missing field as
`null`, so the types say `number | null` and a program checks before
reading. The statelog reader accepts an answer without them, and the logs
viewer prints a missing confidence as nothing.

`rawData` stays on the record as the untyped original.
`lib/stdlib/thread.test.ts` builds its fixture as smoltalk's `DecideResult`,
so a shape change there fails here. Agency annotations do not produce
score questions. `DecisionAnswer` includes `ScoreAnswer` to match the
smoltalk response type.

## Cost

A decision call is metered under the `decision` usage kind
(`lib/runtime/invocationUsage.ts`, `lib/cli/statelog/spendTypes.ts`).
smoltalk prices it from the registry entry of the requested model, so
`jev-1.13` costs input tokens times $0.042 per million, and a model the
registry does not know, which is every Laya checkpoint, costs zero. Output
is free. A cost guard trips on a decision call the way it trips on a text
call; the execution test checks that.

## Running against each backend

**Jev through OpenRouter.** Use OpenRouter's normal key and provider:

```bash
OPENROUTER_API_KEY="<OpenRouter key>" \
  agency run --model openrouter/jev-1.13 decision-triage.agency
```

Or in `agency.json`:

```json
{ "client": { "defaultModel": "jev-1.13",
              "defaultProvider": "openrouter",
              "apiKey": { "openRouter": "<OpenRouter key>" } } }
```

Vercel AI Gateway also serves it, at base URL
`https://ai-gateway.vercel.sh/typesafe` with model `typesafe-ai/jev`. That
name is not in the registry, so the call needs `provider: "typesafe"`.

**OpenAI.** `gpt-6-luna` answers decisions through OpenAI's own API, with
`OPENAI_API_KEY`. The registry lists it as a text model first, so the call
needs the option:

```ts
const dept: Dept = llm(q, { model: "gpt-6-luna", type: "decision" })
```

**Laya locally.** Install and serve, then use the `laya` provider. It
needs no key. Its address is `baseUrl.laya` (in `agency.json` or on the
call), then `LAYA_BASE_URL`, then `http://127.0.0.1:8000`. A Laya model is
not in the registry, so the call needs the option:

```bash
uv venv laya && source laya/bin/activate
uv pip install "laya[serve]"
LAYA_PRELOAD=1 laya-serve          # port 8000, Metal on Apple silicon
```

```ts
const dept: Dept = llm(q, { model: "english", provider: "laya", type: "decision" })
```

Laya also speaks the TypeSafe protocol, so `provider: "typesafe"` with
`TYPESAFE_BASE_URL` pointing at the server and any value in
`TYPESAFE_API_KEY` reaches it too, with no option.

**A local chat model.** The `llama-cpp` provider answers decisions in
process with a small chat model, through the `smoltalk-llama-cpp` plugin.
The model is a path to a `.gguf` file. This needs `smoltalk-llama-cpp`
0.9.0 or later; an older plugin fails with "has no decision support".

```ts
const dept: Dept = llm(q, { model: "/models/qwen3-4b.gguf", provider: "llama-cpp", type: "decision" })
```

**The default model.** Run the same file with no flag. It goes through
structured output.

## Testing

- `lib/runtime/decision/questions.test.ts`: every accepted shape and every
  refused shape, the answer mapping, and the state.
- `lib/runtime/decision/dispatch.test.ts`: the three rules, the question
  cap, the completion shape, the key-merge rule, the four refusals, and the
  HTTP status carried on a failed request so a 429 or 5xx retries.
- `lib/runtime/llmConfig.test.ts`: the provider a `type: "decision"`
  call switches to.
- `lib/stdlib/llm.test.ts`: `setLlmOptions` refuses `type`.
- `lib/runtime/llmDispatch.decision.test.ts`: a refusal happens before any
  metered attempt, a sent call is metered under the `decision` kind, and a
  provider that cannot answer decisions fails once, unretried.
- `lib/runtime/llmClient.decide.test.ts` and the `DeterministicClient.decide`
  cases in `deterministicClient.test.ts`: the client contract.
- `tests/agency-js/decision-model/`: the compiled path end to end. The test
  uses a client of its own that records what the runtime sent, so the
  fixture pins the state, the questions, and the config for a bare call, an
  object call, a call under a cost guard, a `type: "decision"` call on a
  text model, and a call to the `laya` provider with its base URL.

## Batching inside `parallel`

Inside a `parallel` or `fork` block, decision calls that share a
conversation go out together. The rule from the user's side: once every arm
is either finished or waiting on the decision model, the waiting calls
that share the same conversation and model are one request.

The pieces:

- `Runner.runForkAll` builds one `DecisionCollector`
  (`lib/runtime/decision/collector.ts`) per block and passes it to
  `runBatch`, which puts `{ collector, armKey }` on each arm's async-context
  frame as `decisions`. The three frame builders that copy fields by name
  (`Runner.runInScope`, `withResumableScope`, `runInBranchAlsFrame`)
  forward it; the builders that spread the outer frame carry it for free.
  A `race` block installs none.
- `dispatchDecision` reads the frame. With a scope it submits
  `{ state, questions, config, questionCap, signal }` to the collector and
  awaits a `Result<DecideResult>`; without one it sends as before. Nothing
  else in the call path knows about batching.
- The collector derives each arm's status from its calls: settled when its
  branch is done, waiting when it has a call not yet sent, inflight when its
  calls are all on the wire, else running. Only a running arm holds up a
  round. `runBatch` reports settles through the `onBranchSettled` hook,
  which fires as each branch settles, and at once for a cached branch on
  resume. The collector meters nothing itself; each arm meters its share of
  the answer, so the shares sum to the one request's usage and cost.
- A group contains calls with matching model, provider, API keys, base
  URLs, model data, question cap, and state. The collector hashes those
  values with `sha256`. Credentials do not appear in batch reports. A round
  sends every group at once when the block is idle, meaning
  no arm is running, or one group alone when it reaches the model's
  question cap (the registry's `maxQuestions`, 64 for Jev, or 64 for an
  unknown model). A cap round logs a `warn` with
  `warnType: "decisionBatchCap"`.
- A merged request names each question `c<callId>_<name>`. Answers come
  back under their original names. Input and output tokens are split
  across the group's calls in proportion to their question counts, the
  remainder to the first call; cost is split by the same proportions.
- A failed request resolves every call in the group with the failure and
  its status, so each arm's retry loop runs as it would for its own
  request, and the retries form a new round. A call cancelled while it
  waits leaves the group, and its arm counts as running until it asks again
  or settles. A request is cancelled only when every call in it is.
- Interrupts and resume need nothing extra. An arm that interrupts settles
  with its interrupt list, so it stops holding up the round. The collector
  lives only in memory: it is not part of any checkpoint, and `runForkAll`
  builds a new one each time the block runs. On resume, an arm that had
  finished is cached and reported settled at once, and a decision call that
  had completed inside a re-run arm is a completed step, so it is not sent
  again. State isolation is untouched: the collector reads each arm's own
  thread view to build the state, writes nothing shared, and each arm's
  answer is appended to that arm's thread and metered on that arm's stack.
- Each round is a `decisionBatch` span holding one `decisionBatch` event
  with the groups, the reason, and the time. The logs viewer summarizes it
  as `decisionBatch 2 requests · 4 questions · 3 calls (idle, 120ms)`. The
  span opens in the block's own span context, not the triggering arm's.

What does not batch: a call outside any block; the arms of a `race`; a
call in a nested `parallel` with the outer block's calls (the inner block
has its own collector); and two arms that touched their thread differently
before asking, since their states differ.

Nothing here is specific to Jev. The collector works over smoltalk's
`DecisionState`, `DecisionQuestion`, and `DecideResult` types, which any
decision model shares; a call is a decision call when `isDecisionCall` says
so, whichever provider serves it, and the per-request cap comes from the
model's decision entry. The two Jev-shaped numbers are
the default cap of 64 for a model the registry does not know and the
`typesafe` provider name for such a model.

An arm can hold several calls at once when a text-model call inside it
dispatches several tools that each ask a decision model. They register
under the arm's key, batch together when they are pending in the same
round, and the arm stays waiting until its last one is sent.

Under the deterministic client, a merged request still consumes one
`{ decide }` mock per call, in the order the calls were submitted, and
each mock is checked against its own call's question names.
