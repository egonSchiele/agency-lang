# Message lifespans, and a warning before the tool-round limit

This spec covers two things that turned out to be one design:

1. A warning to the model when it is about to run out of tool-call
   rounds, settable on `llm()`.
2. One mechanism, called a message lifespan, for every message the
   runtime adds to a conversation and later removes. The warning is the
   newest such message. Two existing ones (the handoff persona and the
   recalled memory facts) move onto the same mechanism.

The owner's decisions so far: there should be a warning; the user sets
when it starts and what it says through `llm()` options, with defaults;
the option is called `warnAtRoundsLeft` and has the shape in the
"Option" section; the warning is not a preset field; and every message
the runtime removes later should use one mechanism, documented once, so
the next person copies the right pattern.

## Part 1: Background

### Threads outlive `llm()` calls

A thread is the message history one or more `llm()` calls share. The
`main` thread of an `agency agent` session holds every turn of the
conversation. A thread is a `MessageThread`
(`lib/runtime/state/messageThread.ts`): an array of smoltalk messages
plus two side arrays aligned with it by index, `messageLabels` (debug
labels, never sent to the provider) and `messageScopes` (described
below).

An `llm()` call is one run of the tool loop in `runPrompt`
(`lib/runtime/prompt.ts`). It pushes the prompt as a user message, sends
a request, runs the tool calls the model asked for, sends another
request, and so on until the model answers without tools. All of that
lands on the thread. When the call returns, the thread keeps everything.

So a thread sees many `llm()` calls over its life, and three things in
the agent make that routine:

- **Turns.** Every coordinator turn is one `llm()` call on the session
  thread `main` (`lib/agents/agency-agent/brains/coordinator/coordinator.agency:175-190`).
  Turn two sees turn one's messages.
- **Handoffs.** The oracle and explorer are `handoff def` functions.
  When the model calls one as a tool, its body's `llm()` calls run on
  the coordinator's thread, not a fresh one
  (`docs/dev/language/handoff-functions.md`).
- **Saved sessions.** The session is checkpointed after every turn and
  restored by `--continue`, so the thread outlives the process too
  (`docs/dev/agents/agent-sessions.md`).

### The round cap belongs to one `llm()` call

A round is one model response that asks for tools. The tool loop counts
rounds in `self.toolCallRound`, which is a field of the `runPrompt` frame,
so each `llm()` call has its own counter starting at zero. The cap comes
from `maxToolCallRounds`: the call's own option, or the branch default
set by `setLlmOptions`, or the baked default of 10. When both the option
and the branch default are set, the smaller wins (`roundCap` in
`lib/runtime/toolLoopGuards.ts`). The agent sets the branch default to
50 for an interactive session and 100 for a one-shot run
(`lib/agents/agency-agent/lib/toolLimits.agency`), and that default
reaches every `llm()` call in the run, including the handoffs' calls.

At the cap, the gate refuses every tool call in the round with this
message as the tool result (`refusalMessage` in `toolLoopGuards.ts`):

> Error: Maximum number of tool call rounds (50) exceeded. This tool
> call will not be executed, and no more tools will be offered. Write
> your answer now from what you have.

and the next request offers only the intrinsic `saveDraft` tool, so the
model can only answer. Nothing warns the model before this happens.

### The refusal text already goes stale

Put the two facts together. The counter belongs to the call, but the
message belongs to the thread, so the message outlives the thing it
describes. Trace `dMgeO_0uUsXVrEqAFq-uF` in `log.jsonl` (2026-10-28)
shows this with the researcher as it was before PR #1304. The
researcher's first `llm()` call hit its cap of 30 rounds. The refusal
landed at message 75 of the thread. The researcher then reviewed its own
answer and made a second `llm()` call on the same thread to patch the
gaps. That call had a fresh counter and offered 19 tools, and its request
carried message 75 unchanged: "no more tools will be offered", followed
by 19 tool definitions.

Any warning we add has the same problem unless the design handles it.
Haystack and AMD's GAIA both hit it (see below).

### Six places the runtime rewrites history

The handoff work introduced a way to remove messages from a thread. It is
not the only rewrite. The runtime edits conversation history in six
places today, each with its own way of finding what to touch:

| # | What | Where | How it finds the message |
|---|---|---|---|
| 1 | Drop the handoff tool call from the assistant message that carried it | `dropHandoffToolCall`, `lib/runtime/handoff.ts` | the last assistant message, and the call's index |
| 2 | Remove the system messages a handoff body pushed (its persona) when the body returns | `closeHandoff` → `removeHandoffScoped`, `handoff.ts` and `messageThread.ts` | a scope key stamped on system messages while the body ran |
| 3 | Replace the trailing assistant message with the tool's answer on `endTurn` | `endThreadWithAnswer`, `handoff.ts` | the last message, if it is an assistant message without tool calls |
| 4 | Remove the "Relevant context from memory" system message after the request it was recalled for | `runPrompt`, `prompt.ts` around line 913 | `findLastIndex` on role and exact content |
| 5 | Replace the older half of the thread with a summary | memory compaction, `prompt.ts` around line 288 | a split index |
| 6 | Append synthetic tool results for calls an abandoned turn left dangling | `repairReopenedThread`, `lib/runtime/threadRepair.ts` | the dangling tool-call ids |

Cases 2 and 4 are the same shape: a message the runtime added for a
while, removed when the while is over. The round warning is a third of
that shape. Cases 1, 3, 5, and 6 are edits to assistant and tool
messages and stay as they are (see "What stays separate").

### How the handoff strip works today

The scope mechanism is what the lifespan design generalizes, so here it
is in full. `messageScopes[i]` is `null` or a string key. The key names
one handoff dispatch: the tool name, the tool-call id, and the nesting
depth, for example `explorer:call_123:1` (`handoffScopeKey`). The depth is
in the key because Gemini sends no call ids.

When a handoff body starts, `invokeOnThread` (`lib/runtime/toolInvocation.ts`)
calls `thread.enterHandoffScope(key)`. From then until the matching
`exitHandoffScope()`, `push` stamps every *system* message with the key.
User, assistant, and tool messages get `null`. When the body returns,
`closeHandoff` calls `removeHandoffScoped(key)`, which walks the thread
backwards and removes every message with that key, then pushes the
hand-back user message.

Three properties matter and carry over:

- The tags are serialized with the thread (`toJSON` writes
  `messageScopes` when any entry is non-null), so a checkpoint taken
  inside the body still knows what to strip after a resume.
- Compaction keeps the tags of the messages it keeps (`setMessages`
  takes the scopes array), and a tagged message compaction summarized
  away is simply not there to remove.
- The scope *stack* (`handoffScopes`) is not serialized. The `.invoke`
  step re-enters the scope when a resume re-runs the dispatch.

### What other harnesses do about the round limit

Read for this spec, with the finding each contributes:

- **Haystack** (PR deepset-ai/haystack#13359, merged 2026-10-28) reminds
  the model before each of its last 3 LLM calls, as a user message in
  `<system-reminder>` tags: "You have 2 of 10 steps remaining before this
  run is stopped. Start working toward your final answer." and on the
  last step "This is your last step of 10. Give your final answer now:
  you will not see the results of any further tool calls." Their manual
  test with gpt-5-mini: the model ignored the "2 of 5" reminders and only
  stopped on the last-step one. The reminders are tagged so compaction
  skips them.
- **AMD GAIA** (PR amd/gaia#4865) notifies at 20, 10, and 5 steps left,
  once each. They started with fractions of the budget and switched to
  absolute counts after testing caps from 60 to 1000. A review caught
  that notices saved into history carried stale counts into later turns;
  the fix sends them to the model for that turn only.
- **Anthropic's context awareness** injects `<system_warning>Token usage:
  35000/200000; 165000 remaining</system_warning>` after every tool
  call on Sonnet 4.5 and 4.6. Cognition's Devin team reported that this
  made the model wrap up early, take shortcuts, and spend tokens on
  summaries; they needed reminders at both ends of the prompt and
  capped the window at 200k while enabling 1M so the model believed it
  had room. Anthropic's task-budgets doc warns that a budget that looks
  too small makes the model decline or scope down the task.
- **OpenAI Agents SDK, OpenHands SDK, smolagents, LangGraph** warn
  nothing. The OpenAI SDK throws and loses the partial work.

What this says: a few notices, each sent once, with the most care on the
last one; count in rounds left, not a fraction; put it in the user turn,
not inside a tool's output; and make sure the text cannot be read as
current once its call is over.

## Part 2: Message lifespans

### The idea

Every message on a thread has a lifespan: how long it belongs in the
conversation. Almost every message lives as long as the thread. A few
live only as long as the `llm()` call, the request, or the handoff that
added them. When that thing ends, the runtime removes them, in one place,
by one rule.

### The record

`messageScopes` becomes `messageLifeSpans`, a side array aligned with
`messages` like the labels. Each entry is `null` (lives with the thread)
or a record:

```ts
type LifeSpan = "llmCall" | "request" | "handoff";

type MessageLifeSpan = {
  lifeSpan: LifeSpan;
  /** Which llm() call, request, or handoff dispatch the message belongs
   *  to. Null for an llmCall message pushed from Agency code before the
   *  call started; the next llm() call on the thread claims it. */
  key: string | null;
};
```

The key is what keeps concurrent and nested owners apart. Two `async
llm()` calls running at once each expire only their own messages. A
handoff nested in a handoff expires only its own persona.

| Lifespan | Ends when | Key |
|---|---|---|
| `llmCall` | the `llm()` call that owns it returns | the call's `llmCall` span id, which `reopenSpan` keeps stable across a resume |
| `request` | the request it was added for has returned | the request step key (`first`, or `afterToolRound:<round>`) |
| `handoff` | the handoff dispatch's body returns | the handoff scope key, unchanged from today |

`thread` is not a value in the record. A message that lives with the
thread has a `null` entry, as every message does today.

### Which messages may carry one

System and user messages only. A tool message must stay paired with the
assistant message that called it, and an assistant message with tool
calls must keep its results, or the provider rejects the next request.
`push` throws when asked to give a lifespan to any other role. This is a
runtime check, not just a type, because `push` is reachable from plain
TypeScript.

### The thread API

On `MessageThread`:

- `push(message, label = null, lifeSpan: MessageLifeSpan | null = null)`.
  The one append, as today. A system message pushed while a handoff
  scope is open and with no explicit lifespan gets
  `{ lifeSpan: "handoff", key: <current scope> }`, which is today's
  stamping rule with a new shape.
- `expire(lifeSpan, key)`. Removes every message whose record matches
  both fields. Walks backwards, like `removeHandoffScoped` does. This is
  the only removal path for lifespan messages.
- `claimUnkeyed(lifeSpan, key)`. Gives `key` to every message with that
  lifespan and a `null` key. Used once, by `runPrompt` at the start of a
  call (below).
- `lifeSpanAt(index)`. Replaces `scopeAt`.
- `enterHandoffScope`, `exitHandoffScope`, `handoffDepth` stay. They
  describe which handoff is running, which the push rule needs.
- `removeHandoffScoped` and `scopeAt` are removed. `closeHandoff` calls
  `expire("handoff", key)`.

The alignment rules in the class comment stay as they are: `push`,
`removeAt`, `replaceAt`, `adoptFrom`, the constructor, and `setMessages`
are the only writers, and every one carries the lifespans along.

### Serialization

`toJSON` writes `messageLifeSpans` when any entry is non-null, under the
same emit-only-when-meaningful rule as the labels. `fromJSON` reads it.
It also still reads the old `messageScopes` field: a string entry revives
as `{ lifeSpan: "handoff", key: <the string> }`, so a session checkpoint
saved before this change restores with its tags intact. `adoptFrom`
copies the array, as it copies scopes today.

### Subthreads and clones

`newSubthreadChild` clones messages only, so a subthread starts with
every message of its parent and no lifespans, as it does today for
scopes. The one visible effect: a subthread forked while a round warning
is on the parent keeps that warning for good. That is a known limit, not
handled in this PR, because a `subthread {}` inside a handoff body must
keep the persona (the `subthreadInside` case in the handoff tests), and
"drop the parent's lifespan messages on clone" would drop it.

### Where each lifespan is expired, and why there

**`request`.** `runPrompt` pushes the memory facts inside the request
step and removes them in a `finally` right after `_runPrompt` returns
(around line 913). The `finally` is there so a `GuardTripRetry` unwind
cannot leave the facts behind and push them again on re-issue. That stays.
The push becomes `push(systemMessage(facts), null, { lifeSpan: "request",
key })` and the `finally` becomes `expire("request", key)`. The
content-matching `findLastIndex` goes away.

**`handoff`.** Unchanged in placement: `closeHandoff` strips, then pushes
the hand-back. The call changes from `removeHandoffScoped(key)` to
`expire("handoff", key)`.

**`llmCall`.** Two points.

At the start of the call, inside the existing `pushPrompt` step,
`claimUnkeyed("llmCall", key)` gives this call's key to any `llmCall`
message Agency code pushed before the call began. This is how
`userMessage("...", lifeSpan: "llmCall")` from Agency code finds its
owner: the next `llm()` call to start on the thread. It is inside a step
so a resume does not claim twice. A handoff body's `llm()` runs on the
same thread, but only an unkeyed message is claimed, and an unkeyed one
can only come from Agency code that ran since the last call started, so
the body's call claims only what the body pushed.

At the end of the call, a new step `expireLlmCall` runs
`expire("llmCall", key)` and refreshes `self.messagesJSON`. It runs at
the point where the tool loop has finished and the answer is about to be
returned, on both the no-schema path and the structured path. It is a
step, not a `finally`, on purpose: the `finally` at the bottom of
`runPrompt` also runs on an interrupt bailout, and a paused call is not
over. Its warning must still be on the thread when the call resumes.

### What stays separate, and the rule

Lifespans cover one thing: a system or user message the runtime adds and
later removes whole. The dev doc states the rule as: *to add a message
that should not outlive its call, request, or handoff, push it with a
lifespan. Do not find it again by content or by index.*

The other four rewrites are not that shape, and the doc lists them as the
only sanctioned edits of assistant and tool messages:

- `dropHandoffToolCall` edits an assistant message's tool-call list.
- `endThreadWithAnswer` replaces a trailing assistant message.
- Memory compaction replaces a prefix of the thread with a summary.
- `repairReopenedThread` appends tool results for dangling calls.

### The `std::thread` surface

`systemMessage` and `userMessage` gain a named argument:

```
export def systemMessage(msg: string, label: string = "", lifeSpan: "thread" | "llmCall" = "thread")
export def userMessage(msg: string | (string | MessageAttachment)[], label: string = "", lifeSpan: "thread" | "llmCall" = "thread")
```

`"thread"` is the default and means what every push means today.
`"llmCall"` pushes with `{ lifeSpan: "llmCall", key: null }`, claimed by
the next `llm()` call on the thread and removed when that call returns.
Example:

```
userMessage("Reply in French for this question only.", lifeSpan: "llmCall")
const answer = llm("What is the capital of Peru?")
// The French instruction is gone from the thread here.
```

`request` and `handoff` are not offered. A request is not something
Agency code can stand inside, and a system message pushed inside a
handoff body already gets the handoff lifespan without being asked.
`assistantMessage` and `toolMessage` do not take the argument, for the
pairing reason above.

## Part 3: The round warning

### The option

On `llm()` and in `LlmDefaults` (`stdlib/llm.agency`, `lib/stdlib/llm.ts`,
and the option table in `lib/typeChecker/builtins.ts`):

```
warnAtRoundsLeft?: {
  remaining?: number;
  text?: string;
  // warn the model when it only has one tool round left
  finalWarning?: boolean;
  finalWarningText?: string;
}
```

Defaults: `remaining: 3`, `finalWarning: true`, and the two texts below.
The per-call value and the branch default merge field by field, like
`replyLimits` does, since a user who sets only `text` should keep the
default threshold. Setting `remaining: 0` turns the first warning off.

The two texts are templates with two placeholders, `{remaining}` and
`{limit}`. A plain string with no placeholders is fine.

Default `text`:

> Of the {limit} tool rounds for this request, {remaining} remain. Finish
> what you can with them and then write your answer.

Default `finalWarningText`:

> This is the last tool round for this request. The results of the tool
> calls you make now are the last you will see. After them, write your
> answer from what you have.

"For this request" is in both on purpose. Even though the message is
removed when the call ends, the model reads it while it is there, and a
scope word costs nothing.

### When each fires

The loop reaches the round boundary after every round's tool results are
in and before the next request. At that point `round` is the index of
the round just run and `limit` is the cap, so

```
remaining = limit - (round + 1)
```

is how many more rounds of tool calls the model can still get run. The
warnings fire at the boundary:

- The first warning fires once, at the first boundary where
  `remaining <= warnAtRoundsLeft.remaining` and `remaining > 1`.
- The final warning fires once, at the boundary where `remaining == 1`,
  when `finalWarning` is true.
- When `remaining` (the threshold) is 1, only the final text is sent.
- Nothing fires at `remaining == 0`. The next request offers no tools, so
  the model can only answer.

With the agent's cap of 50 and the defaults: the first warning after
round 47 (3 left), the final after round 49 (1 left). With plain
`llm()`'s cap of 10: after round 7 and round 9. With a cap of 2: only the
final warning, after round 1.

Which warnings have fired is recorded in `runnerState.roundWarnings`,
inside the step that pushes them, so a resumed pass sends each one once.

### Where it goes

A new producer in `lib/runtime/turnBoundary.ts`, `roundWarningProducer`,
run inside `runRoundBoundary` after the attachments and queued messages
and before the guard gate, so the approver's feedback keeps the last
word. It pushes one user message with label `roundWarning` and lifespan
`{ lifeSpan: "llmCall", key: <this call's key> }`. The step discipline is
the producer's for free: `drainProducer` pushes inside a step and
refreshes `messagesJSON`.

A user message, not text inside a tool result, for two reasons. The tool
result belongs to the tool, and a model that quotes tool output would
quote the runtime's words as the tool's. And every harness read for this
spec that warns at all puts it in the user turn. On the Anthropic API a
user message after tool results is merged into the same user turn by
smoltalk's `mergeConsecutiveMessages`, so no extra turn is created.

The producer needs the cap, the round, the option, and the call's key.
`BoundaryContext` gains those four fields.

### The refusal text

`refusalMessage` for `tooManyRounds` changes to:

> Error: This request's budget of {limit} tool rounds is used up, so this
> call was not run. Write your answer now from what you have.

It no longer says "no more tools will be offered", which is only true
for the rest of this call. This message is a tool result paired with a
tool call, so it is not a lifespan message and stays in the thread; the
wording is what keeps it from misleading a later call.

### What this PR does not do

- No preset field. The agent's `LlmOptions` mirror stays as it is, and
  `warnAtRoundsLeft` is not in `LLM_OPTION_KEYS`. A preset cannot set it.
  A branch-wide value can still come from `setLlmOptions` in Agency code.
- The warning changes no tool list. The last round offers the same tools
  as the one before it.

## Part 4: Interrupts, checkpoints, and isolation

**Interrupts and resume.** Every push and every expire is inside a step:
the `pushPrompt` step (claim), the request step's body and `finally`
(memory facts), the round boundary's producer step (the warning), the
`.invoke`/hand-back path (handoff), and the new `expireLlmCall` step. A
checkpoint taken inside a call carries the thread with its lifespans
(serialized) and `runnerState.roundWarnings`, so the resumed pass neither
re-sends a warning nor forgets to expire one. A paused call's warning is
still on the thread when the model continues, which is what we want.

**Checkpoint compatibility.** Old checkpoints carry `messageScopes` with
string entries; `fromJSON` reads them as handoff lifespans. New
checkpoints carry `messageLifeSpans`. An old runtime reading a new
checkpoint drops the field, which means a handoff persona would not be
stripped on that runtime; this is the usual forward-compatibility stance
for a field added to the thread JSON.

**Isolation.** An ordinary tool runs on a fresh `ThreadStore`, so a
warning inside a tool's own `llm()` call lands on the tool's thread and
never reaches the caller. A handoff body's call runs on the caller's
thread; its warning carries the body's call key and is expired when the
body's call returns, before the hand-back. A `fork` or `race` branch
shares the thread registry but has its own active stack; two `async`
calls on subthreads each own their messages by key. `parallel` tool
dispatch shares threads (`shareThreads: true`) and the keys keep the
owners apart.

**Provider independence.** Nothing here is provider-specific. The
warning is a user message; the Anthropic client merges it with the
preceding tool results and the OpenAI-shaped clients send it as its own
message.

## Part 5: Tests

Unit, in `lib/runtime/state/messageThread.test.ts` (replacing the
`messageScopes` cases): a lifespan rides through `push`, `removeAt`,
`replaceAt`, `setMessages`, `adoptFrom`, `toJSON`/`fromJSON`; an old
`messageScopes` string revives as a handoff lifespan; `expire` removes
only the matching lifespan and key and keeps the arrays aligned;
`claimUnkeyed` keys only the unkeyed; `push` throws for a lifespan on a
tool or assistant message; a system message pushed inside a handoff
scope gets the handoff lifespan by default.

Unit, in `lib/runtime/prompt.toolRounds.test.ts` with the recording
client: with cap 5 and defaults, the request after round 1 carries the
first warning with `{limit}` and `{remaining}` filled, the request after
round 3 carries the final text, no other request carries either, and
the thread after the call holds neither; `remaining: 0` sends only the
final; `finalWarning: false` sends only the first; a cap of 2 sends only
the final; a custom `text` with no placeholders is sent as given; the
branch default and the per-call value merge field by field; the refusal
text is the new one.

Unit, `lib/runtime/turnBoundary.test.ts`: the producer fires once per
threshold and records it in `runnerState`, so a second `take` at the same
round returns nothing.

Agency-js, `tests/agency-js/handoff`: the existing `persona`,
`pauseWithPersona`, `nested`, and `cancelledHandoff` cases must pass
unchanged. One new case, `warningInsideHandoff`: a handoff body whose
`llm()` has cap 2 pushes a final warning on the caller's thread, and the
caller's next request does not carry it.

Agency-js, a new `tests/agency-js/round-warning`: a call with cap 3 and a
pause inside round 2, resumed; the model saw the warning once and the
thread is clean after the call. This is the resume case the round-cap
doc notes nobody tests yet.

Agency, `tests/agency/memory/llm-injection.agency`: unchanged assertion
that the facts reach the model; add that the thread does not hold them
after the call.

Agency, `tests/agency/threads/lifespan-llm-call.agency`: a
`userMessage(..., lifeSpan: "llmCall")` is in the first `llm()` call's
request and absent from the second's.

## Part 6: Documentation

- New `docs/dev/runtime/message-lifespans.md`: the record, the three
  lifespans and where each is expired, the push rule for roles, the
  claim rule for unkeyed messages, the serialization and the
  `messageScopes` migration, the subthread limit, and the rule above
  with the list of the four sanctioned edits. Added to the `CLAUDE.md`
  index and the `agency-runtime-docs` skill.
- `docs/dev/runtime/threads.md`: the `messageScopes` paragraph points at
  the new doc.
- `docs/dev/language/handoff-functions.md`: the strip is described as
  `expire("handoff", key)`.
- `docs/dev/agents/tool-loop-guards.md`, "The round cap": the warning,
  the new refusal text, and the per-`llm()`-call scope of both.
- `docs/dev/contributing/message-thread-tests.md`: the new cases.
- `docs/site/guide/message-threads.md` and the stdlib docs regenerate
  from the `std::thread` docstrings; the `lifeSpan` argument is
  documented in the docstring, not by hand.

## Part 7: Files

- `lib/runtime/state/messageThread.ts`: the record type, the renamed
  array, `push`, `expire`, `claimUnkeyed`, `lifeSpanAt`, `toJSON`,
  `fromJSON`, `setMessages`, `adoptFrom`.
- `lib/runtime/handoff.ts`: `stripHandoffSystemMessages` calls `expire`.
- `lib/runtime/prompt.ts`: the memory facts push and `finally`; the
  claim in `pushPrompt`; the `expireLlmCall` step; the compaction
  `setMessages` call passes lifespans; the option is read off
  `clientConfig` and the branch defaults and merged; `BoundaryContext`
  is filled.
- `lib/runtime/turnBoundary.ts`: `roundWarningProducer`, the new
  `BoundaryContext` fields, the template fill.
- `lib/runtime/toolLoopGuards.ts`: the refusal text; the option's
  defaults and merge, beside `roundCap`.
- `lib/stdlib/thread.ts`, `stdlib/thread.agency`: the `lifeSpan`
  argument.
- `lib/stdlib/llm.ts`, `stdlib/llm.agency`, `lib/typeChecker/builtins.ts`:
  the option type.
- Tests and docs as listed.

