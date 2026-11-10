# Plan: `decision: true`, and a decision model that routes the agent's turns

This is one plan and one pull request. It has three parts, done in this
order:

- **Part A** (Tasks 1 to 4): Agency moves to smoltalk 0.21.0 and gains a
  `decision: true` option on `llm()`.
- **Part B** (Task 5): the stdlib agents' personas are removed from the
  thread when the agent finishes.
- **Part C** (Tasks 6 to 10): `agency agent` asks a decision model which
  subagent should take a turn, and calls it.

Part C needs both others: Part B for the persona, and Part A for
`decision: true` and the nullable confidence.

Five review files sit beside this plan. Three review earlier drafts
(`2026-11-10-decision-option-review.md`,
`2026-11-10-first-tool-call-review.md`,
`2026-11-10-agent-router-review.md`) and two review this plan
(`2026-11-10-decision-routing-review.md` and
`2026-11-10-decision-routing-review-2.md`). Their findings that apply are
already in this plan. Do not act on them again.

## Background

### What a decision model is, and what Agency does with one today

A decision model does not write text. It reads some content and answers
typed questions about it, with a probability for each answer. It answers
in about 0.2 seconds, where a chat model takes seconds. In Agency a
decision model is a `model` you point a typed `llm()` call at:

```ts
type Dept = "billing" | "support" | "sales"
const dept: Dept = llm("Which department should handle this ticket?")
```

Read `docs/dev/llm/decision-models.md` in full before starting. It
describes the whole path: `runPrompt` builds a `PromptConfig`,
`dispatchWithRetry` in `lib/runtime/llmDispatch.ts` asks `isDecisionCall`
once, and `dispatchDecision` in `lib/runtime/decision/dispatch.ts` turns
the type into questions and calls smoltalk's `decide()`.

### Part A: what changed in smoltalk, and what is wrong in Agency

smoltalk 0.21.0 is published. Compared with 0.20.2, which Agency uses:

- `openai` is a decision provider. `gpt-6-luna` answers decisions through
  OpenAI's own API, and smoltalk translates both ways.
- `laya` is a provider for Laya's own local server. It needs no key. Its
  address comes from `baseUrl.laya`, then `LAYA_BASE_URL`, then
  `http://127.0.0.1:8000`.
- `llama-cpp` is a provider that answers decisions in process with a
  small chat model, through the `smoltalk-llama-cpp` plugin.
- OpenRouter's other decision models (27 of them) are in the catalog.
- `ChoiceAnswer.confidence` and `.probabilities`, and
  `ScoreAnswer.confidence`, `.legend`, and `.probabilities`, are now
  optional, because some models leave them out.
- The catalog can hold a text model and a decision model under one name
  and provider. `gpt-6-luna` under `openai` is both.
  `getDecisionModelForProvider(provider, model, modelData)` returns only
  the decision entry.

Three things in Agency no longer fit.

**How a call is marked as a decision call.** `isDecisionCall` in
`lib/runtime/decision/dispatch.ts` has two rules. A model the catalog
knows is a decision call when its entry has `type: "decision"`. A model
the catalog does not know is a decision call when its provider is
`typesafe`. The second rule made sense when every decision model spoke
TypeSafe's format. It is wrong now:

- `gpt-6-luna` under `openai`: the lookup finds the text entry first, so
  a typed `llm()` call always goes to the chat API. There is no way to
  ask for the Decisions API.
- A local chat model used through `llama-cpp` is a text model in every
  sense, and the caller wants a decision from it.
- A new decision model the catalog does not list yet, on any provider
  other than `typesafe`, cannot be used.

The owner decided the fix: an explicit option, `decision: true`.

**The answer types.** Agency mirrors smoltalk's answer types in
`stdlib/thread.agency` (`ChoiceAnswer`, `ScoreAnswer`) and
`lib/stdlib/thread.ts`. They say `confidence` is always a number. With
smoltalk 0.21.0 that is false.

**The provider keys.** Agency's config schema and type checker list the
provider names allowed under `baseUrl`. `laya` is not among them, and the
schema strips unknown keys.

### Part B: a subagent's persona stays behind when code calls it

The agent's subagents (`researchAgent`, `codeAgent`, and others) are
thin wrappers over stdlib agents in `stdlib/agents/`. Six of the stdlib
agents start the same way. (Four others, `data`, `review`,
`typescript/review`, and `writing/review`, push their system prompt only
on a new thread and keep it. This plan does not touch them.) Each of the
six pushes its persona, a system message that tells the model how to
behave as that agent, and then makes one `llm()` call that runs the
agent's whole tool loop:

```ts
ensureSystemMessage(systemPrompt)
return llm(...)
```

These are `handoff def` functions
(`docs/dev/language/handoff-functions.md`), which means they work inside
the caller's conversation. When a **model** calls one as a tool, the
tool loop removes the persona after the agent finishes. When **code**
calls one, nothing removes it. The persona stays on the caller's thread,
and the caller's next `llm()` call reads the researcher's instructions
as its own.

Part C calls a subagent from code on the coordinator's main thread, so
this has to be fixed first.

Agency already has what the fix needs.
`docs/dev/runtime/expiring-messages.md` describes it; read it in full.
A message pushed with `expires: "llmCall"` is removed when the next
`llm()` call on that thread returns:

```ts
systemMessage(systemPrompt, expires: "llmCall")
return llm(...)
```

The persona is then on the thread for exactly as long as the agent is
working, whoever called it. The mechanism already handles the hard
cases: a call that pauses on an approval keeps the message until the
resumed call finishes, a failed or cancelled call removes it, and the
expiry is saved in checkpoints. The agent's own global instructions use
it already (`addGlobalInstructions` in
`lib/agents/agency-agent/lib/globalInstructions.agency`).

The owner chose this fix. It changes six stdlib files and nothing in
`lib/runtime/`.

### Part C: how a turn is routed today, and what was measured

`agency agent` has a coordinator and subagents. The coordinator's code
is `lib/agents/agency-agent/brains/coordinator/coordinator.agency`. Every
user message goes to `mainAgent`, which makes one `llm()` call on the
"main" thread with the coordinator's tools. Among those tools are the
subagents. The coordinator model reads the message, picks a subagent,
writes a brief for it, and calls it.

A test replayed 60 real user turns through Jev, a decision model, and
compared its pick with what the coordinator did. The results are in the
`worktree-decision-shadow` worktree, under
`docs/superpowers/specs/2026-11-09-decision-routing-shadow-test-results.md`.
The findings this plan rests on:

- The coordinator took a median of 13.2 seconds to hand a turn to a
  subagent. Jev answered in 0.2 seconds.
- With a confidence floor of 0.7, Jev sent 27 of the 60 turns to a
  subagent. It matched the coordinator on 22. On the other 5 a reviewer
  judged Jev right or both choices reasonable. No turn went to a wrong
  subagent.
- The user's message alone is enough. Sending the whole conversation
  did not help.
- The same request gives the same answer, so asking several times and
  voting gains nothing.
- The logs had turns for `research`, `code`, and the coordinator only.

Follow-up runs on the same 60 turns compared ways of writing the
question, each with three options and a floor of 0.7. Results move by
about one turn between runs of the same question.

| How the question was written | Turns sent to a subagent | Matched the coordinator | Sent to a different subagent |
| --- | --- | --- | --- |
| A description attached to each option | 24 | 20 | 0 |
| The descriptions written in the prompt | 26 | 22 | 0 |
| Option names only, no descriptions | 39 | 30 | 0 |
| In the prompt, and the `coordinator` line also takes questions about the Agency language | 26 | 22 | 0 |
| The same, and the `coordinator` line lists eight of its other tool names | 26 | 23 | 0 |
| The same, with thirty tool names (learned, MCP, then built-in) | 27 | 23 | 0 |

Descriptions in the prompt do as well as descriptions attached to the
options, so Agency needs no way to describe a union member. Names alone
make Jev overconfident. The additions in the last three rows cost
nothing on these turns, including a list of thirty names. The logs hold
no question about the Agency language, so that wording is untested for
the case it is there for. The exact text of the last row's question is
in Task 7.

The owner decided:

- Use Jev for routing.
- A routed turn gives the subagent the user's own message, with no
  brief from the coordinator. Most briefs in the logs added a research
  plan the researcher can write itself. Some narrowed the task or added
  limits, and those are lost. This is accepted, without a test.
- The routing is plain Agency code in the agent: ask the decision model,
  then a `match` that calls the subagent function. Nothing is added to
  `llm()` for it.

## What this plan changes

1. smoltalk is bumped to 0.21.0, and the answer types say which fields
   may be missing.
2. `llm()` takes `decision: true` and `decision: false`.
3. `baseUrl.laya` is accepted in `agency.json` and on a call.
4. The six stdlib agents push a persona that expires with their `llm()`
   call.
5. The agent has a `router` model slot. When it is set, a decision model
   picks `research`, `code`, or `coordinator` for each turn, and the
   agent calls the subagent directly when the model is sure.

## What this plan does not change

- Anything in `lib/runtime/` beyond the decision option in Part A, with
  one exception in test support: the deterministic client's decision
  mocks gain a delay (Task 7). `llm()` gets no option for routing.
- Tool calls and tool results in a decision model's state. It still
  reads only the text messages of the thread.
- Local decision models through `agency local`.
- Per-option descriptions and score questions. Both stay unsupported.
- Any agent turn when the `router` slot is unset.
- Handlers, policies, and approvals. A subagent called from code raises
  the same interrupts under the same handler chain.
- The subagents' tools, budgets, and prompts, and the coordinator's
  prompt and tools.

## Known limits of the router, accepted

Write these into the router's dev doc (Task 10).

- **Deadlines and spend caps the user states are not passed on.** The
  coordinator reads "take no more than five minutes" and passes
  `maxSeconds`. A routed turn uses the subagent's defaults.
- **The subagent gets no brief.**
- **Only `research` and `code` are routed.**
- **A question about the Agency language.** `researchAgent` takes an
  `agencyTopic` argument that sends the question to the researcher with
  the bundled Agency docs. A routed call does not set it. The
  `coordinator` line of the question claims these questions, but no
  logged turn tested that.
- **No coordinator on a routed turn.** The coordinator model is not
  called at all, so its memory recall does not happen and it adds no
  closing remark after the subagent.
- **The saving depends on the coordinator model.** In the logs it was
  large with GLM 5.3 Flash (a median first call of 12.8 seconds) and
  small with Opus 4.8 (2.5 seconds).
- **Long messages are not routed.** See the cap in Task 8.
- **The confidence floor was measured on Jev.** The slot accepts any
  decision model, and another model's 0.7 can mean something else. A
  user who sets another model should expect to check its routing.

## Before you start

- Create a worktree inside `packages/agency-lang` and work there. Never
  work in the main checkout.
- Read: `docs/dev/llm/decision-models.md`, `docs/dev/llm/smoltalk.md`,
  `docs/dev/runtime/expiring-messages.md`,
  `docs/dev/language/handoff-functions.md`,
  `docs/dev/agents/agent-brains.md`,
  `docs/dev/agents/harness-guidelines.md`,
  `docs/dev/agents/agent-presets.md`,
  `docs/dev/agents/research-loop.md`, and the four contributing docs
  named in `CLAUDE.md`.

## Rules

- Run only the tests that cover what you changed, with the output saved
  to a file. Do not run the whole Agency test suite locally; CI does.
- Run `make` after changing an `.agency` file under `stdlib/` or
  `lib/agents/`. `pnpm run build` alone does not rebuild them. Run
  `pnpm run build` before trusting a test of compiled fixtures.
- Run `pnpm run typecheck` after every task, and `pnpm run fmt:ts` on
  the TypeScript files you changed, by name. Do not format the tree.
- Run `agency fmt -i` only on `.agency` files this plan adds, never on
  existing ones.
- Agent tests must run with `HOME` set to a scratch folder, and with
  `--check-capabilities`, as CI does. Delete test folders with
  `safeDeleteDirectoryWithin`. Never pass `--policy approve-all`.
- Do not hand-edit anything under `docs/site/`. Do not edit
  `CHANGELOG.md`.
- Never amend or force push. Write commit messages and the pull request
  description to a file and pass the file to `git` and `gh`.
- One commit per task. Open the pull request and stop; the owner merges.

## Part A: smoltalk 0.21.0 and the `decision` option

### Task 1: bump smoltalk and fix what the new types break

Set `smoltalk` in `package.json` to `0.21.0` and install. Run
`pnpm run typecheck` and fix every error. The expected ones are reads of
`confidence`, `probabilities`, or `legend` on a decision answer.

Update the mirrored types in `stdlib/thread.agency`:

```ts
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number> | null
}

export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number | null;
  legend: Record<string, string> | null;
  probabilities: Record<string, number> | null
}
```

Agency has one nothing-value, `null`
(`docs/dev/language/null-and-undefined.md`), so a field smoltalk leaves
out reads as `null` here. Update the doc comments on both types to say
that some models leave these out and that a program should check for
`null` before reading one. Update the TypeScript twins in
`lib/stdlib/thread.ts` and the fixture in `lib/stdlib/thread.test.ts`,
which is built as smoltalk's `DecideResult`. Add a fixture case for a
choice answer with no confidence and no probabilities.

Search the repository for other readers of these fields
(`rg "\.confidence|\.probabilities|\.legend" lib stdlib tests`) and
update each. The statelog `decision` field and the logs viewer print
answers; check that a missing confidence prints as nothing and does not
print `undefined`.

Run `make`, then the tests for `lib/stdlib/thread.test.ts`,
`lib/runtime/decision/`, and `tests/agency-js/decision-model`.

### Task 2: the `decision` option

**The rule.** Replace the body of `isDecisionCall` with this order:

1. `decision: true` on the call: a decision call.
2. `decision: false` on the call: a text call.
3. Otherwise, today's two rules, unchanged: the catalog entry's type,
   then `provider === "typesafe"` for an unknown model.

Rule 3 stays so that every program that works today keeps working.
Rule 2 exists because `gpt-6-luna` has both kinds of entry and a caller
may want to be explicit.

Write the rule so it reads as that list. Do not nest conditions.

Rule 3 must keep using `modelRecord`, exactly as `isDecisionCall` does
today. Do not make it look for a decision entry first. `gpt-6-luna`
under `openai` has both a text entry and a decision entry, and it is a
chat model that many programs use. If rule 3 preferred the decision
entry, every call to it with no option would go to the Decisions API,
and an untyped `llm("hi", { model: "gpt-6-luna" })` would fail. With no
option, `gpt-6-luna` is a text call.

**Where the option has to be added.** A per-call option reaches
`PromptConfig` with no change to `lib/runtime/prompt.ts`: the keys
`runPrompt` does not pull out land in `restClientConfig`, are merged
into `clientConfig`, and `_runPrompt` spreads `clientConfig` into the
`PromptConfig`. The same path would send the key on to smoltalk, because
`toSmolConfig` spreads `...metadata` and `metadata` is the whole
`clientConfig`. So the places to change are:

- `PromptConfig` in `lib/runtime/llmClient.ts`: `decision?: boolean`.
- `toSmolConfig` in the same file: remove `decision` from what the
  `...metadata` spread forwards. smoltalk's chat config has no such
  field.
- `LlmOpts` in `lib/runtime/agencyLlm.ts`.
- The option list in `lib/typeChecker/builtins.ts`
  (`{ key: "decision", value: optional(boolean) }`).

Do not add it to `setLlmOptions` (`LlmDefaults` in `lib/stdlib/llm.ts`
and its Agency mirror in `stdlib/llm.agency`). A branch default of
`decision: true` would turn every later `llm()` call in the branch into
a decision call, and a call with tools or with no type annotation would
then fail. A branch that runs every call against a decision model is
already served when the model is in the catalog, through rule 3.

**The provider.** In a real program the provider is almost never
missing. It is the merge of the `agency.json` default, the branch
default, and the call, and `modelProviderOverride` in
`lib/runtime/llmConfig.ts` changes it only when the new model's catalog
entry is a decision entry. So in a program whose default provider is
`anthropic`, this call would send a decision request to `anthropic`:

```ts
const x: Dept = llm("Which department?", { model: "new-decider", decision: true })
```

Two changes:

1. In `modelProviderOverride`, treat a call with `decision: true`, no
   explicit provider, and a model that has a decision entry as a switch
   to that entry's provider. Some names have more than one decision
   entry: `jev-1.14` is listed under both `typesafe` and `openrouter`.
   Take the first decision entry in catalog order, which two smoltalk
   exports give in one expression:

   ```ts
   getAllModels(modelData).find((m) => isDecisionModel(m) && m.modelName === name)
   ```

   For a name whose first catalog entry is already a decision entry,
   this is the provider the function picks today (`typesafe` for
   `jev-1.14`). The only names whose behavior changes are those whose
   first entry is a text entry, such as `gpt-6-luna`. Do not change what
   the function does for any call without `decision: true`.

   The function takes `Partial<SmolConfig>`, which has no `decision`
   field. Pass the flag as an extra argument; do not widen smoltalk's
   type.

   The function returns early when the call names the same model as the
   branch default. So `decision: true` on the default model keeps the
   default provider. Leave that as it is: the default provider was
   chosen for that model.
2. A `decision: true` call whose resolved provider cannot answer
   decisions must fail once and say which provider. smoltalk's
   `decide()` already returns this failure before it sends anything
   ("Provider "anthropic" does not answer decisions. Use one of: ...").
   smoltalk 0.21.0 does not export the list of decision provider
   names, so Agency cannot refuse earlier than that. Make sure the retry
   classifier does not retry this failure, and that the message reaches
   the caller unchanged.

Keep `dispatchDecision`'s fallback to `DECISION_PROVIDER` for rule 3's
case, an unknown model with no provider at all.

**The question cap.** `registryRecord` returns whatever entry the
lookup finds first, which for `gpt-6-luna` is the text entry. A decision
call needs the decision entry for its cap (400, where the default is
64). In `questionCapFor`, which runs only once a call is already a
decision call, look the model up with `getDecisionModelForProvider`
first.

**Batching.** Read the "Batching inside `parallel`" section of the dev
doc. The collector groups calls by model, provider, keys, and state.
Nothing there reads `isDecisionCall`, so no change is expected. Add one
case to `tests/agency-js/decision-batch`: a `decision: true` call on a
model the fixture's catalog knows as text, inside `parallel`, is grouped
with its siblings.

Tests:

- `lib/runtime/decision/dispatch.test.ts`: the three rules. `decision:
  true` with a text catalog entry is a decision call. `decision: false`
  with a decision catalog entry is a text call. No option keeps today's
  answer for a decision entry, a text entry, an unknown model under
  `typesafe`, and an unknown model under another provider. `gpt-6-luna`
  under `openai` with no option is a text call. An unknown model under
  another provider with `decision: true` is a decision call.
- The same file: `gpt-6-luna` under `openai` with `decision: true` has a
  question cap of 400.
- With a default provider of `anthropic` in the fixture, because a test
  with no default provider does not match how programs run:
  `decision: true` on an unknown model fails once, is not retried, and
  the message names `anthropic`; `decision: true` on `gpt-6-luna` with
  no provider on the call goes to `openai`.
- `setLlmOptions({ decision: true })` is refused by the type checker.
- `lib/runtime/llmDispatch.decision.test.ts`: a `decision: true` call on
  a text model is metered under the `decision` kind.
- `lib/runtime/llmClient` tests: `toSmolConfig` does not forward
  `decision`.
- `tests/agency-js/decision-model`: add one call with `decision: true`
  on a model the fixture's catalog knows as text, and check the recorded
  request went to `decide`.
- A type checker test: `llm("...", { decision: true })` is accepted, and
  `{ decision: "yes" }` is refused.

### Task 3: `baseUrl.laya`

Add `laya` beside `typesafe` in every list of base URL names. Search for
them with `rg typesafe lib stdlib`:

- the `baseUrl` type and the Zod schema in `lib/config/config.ts`, with
  a comment: "Where a local Laya server listens. Default
  `http://127.0.0.1:8000`.";
- `baseUrlObject` in `lib/typeChecker/builtins.ts`;
- `LlmBaseUrls` in `lib/runtime/llmConfig.ts`, whose
  `Pick<..., "typesafe">` should also pick `laya` now that smoltalk's
  `DecideConfig` has it;
- the `baseUrl` type in `stdlib/llm.agency`, which is the one
  `setLlmOptions` accepts and the type checker checks.

Laya takes no key, so add nothing to the key lists.

The agent has its own rule about base URLs in a preset
(`docs/dev/agents/agent-presets.md`, "Options beside the model"): only
`mlx` is allowed there, because every other provider sends a key to that
address. Do not add `laya` to that list.

Tests: the config schema keeps `baseUrl.laya`, and a call with
`provider: "laya"` and `decision: true` reaches `decide` with that base
URL. Use the test client in `tests/agency-js/decision-model`.

### Task 4: the decision models dev doc

Update `docs/dev/llm/decision-models.md`:

- Rewrite "Which calls are decision calls" around the three rules, with
  `decision: true` first and one example each for `gpt-6-luna`, a local
  chat model through `llama-cpp`, and an unknown model.
- The opening of the doc and the index line in `CLAUDE.md` say "the
  provider is the switch". Change both: the option is the switch, and
  the catalog and the `typesafe` provider are the defaults.
- "Running against each backend": add OpenAI (`decision: true` with
  `gpt-6-luna`), Laya through `provider: "laya"` (replacing the
  `TYPESAFE_BASE_URL` instructions; say the old way still works), and a
  local chat model through `provider: "llama-cpp"` with a `.gguf` path.
  The last needs `smoltalk-llama-cpp` 0.9.0 or later; an older plugin
  fails with "has no decision support". Give that version.
- "The lossy step": say that `confidence`, `probabilities`, and `legend`
  can be `null`.
- Keep the doc to mechanism and rules. Do not add history.

Keep the same index line in step in the `agency-llm-docs` skill, as
`CLAUDE.md` asks.

The user guide page `docs/site/guide/decision-models.md` also describes
the provider as the switch. Do not edit it. List it in the pull request
description as needing the owner's update.

## Part B: personas that leave with the agent

### Task 5: the stdlib agents push an expiring persona

Six stdlib agents push a persona with `ensureSystemMessage`. Find them
with `rg -n ensureSystemMessage stdlib/agents`:

- `stdlib/agents/coding.agency`
- `stdlib/agents/explorer.agency`
- `stdlib/agents/oracle.agency`
- `stdlib/agents/github.agency`
- `stdlib/agents/researcher.agency`
- `stdlib/agents/agency/researcher.agency`

In each, replace the push:

```ts
systemMessage(systemPrompt, expires: "llmCall")
```

`systemMessage` is in `std::thread`. The message is removed when the
agent's next `llm()` call on the thread returns.

**The general researcher makes two calls.** `stdlib/agents/researcher.agency`
makes a second `llm()` call, with `NO_ANSWER_FOLLOWUP`, when the first
returns an empty answer (`docs/dev/agents/research-loop.md`). By then the
persona has expired. Push it again, the same way, right before that
second call. Check each of the other five for a second `llm()` call on
the same thread and do the same if you find one; when this plan was
written they had one call each.

**`ensureSystemMessage`.** Its doc comment in `stdlib/thread.agency` says
it is "for an agent's persona". After this task no agent uses it for
that. Rewrite the comment to say what the function does (push a system
message unless the thread already holds it) without naming personas.
Keep the function; it is public. Remove the comment in
`researcher.agency` above the push, which explains the skipped push.

**The four "Called from code" comments.** `explorer.agency`,
`coding.agency`, `oracle.agency`, and `github.agency` each carry a doc
comment that says the system prompt stays on the caller's thread when
the agent is called from code. Find them with
`rg "Called from code" stdlib`. Rewrite each: the reads and the answer
stay on the caller's thread, the system prompt is removed when the agent
finishes, and `thread { ... }` is still the way to isolate the call.
These comments are published by `agency doc`, so run `make` and let it
regenerate the stdlib pages.

**What changes for each kind of caller.** Check each, and describe what
you found in the pull request.

- *A model calls the agent as a tool.* The persona used to be removed
  when the handoff closed. It is now removed a moment earlier, when the
  agent's `llm()` call returns. The thread afterwards is the same. The
  message's expiry is now `llmCall` where it was `handoff`. Only a
  fixture that runs a real stdlib agent records that and changes. The
  suite in `tests/agency-js/handoff/` uses handoffs of its own that call
  `ensureSystemMessage`, so its fixtures stay as they are; an unchanged
  fixture there is expected. Before regenerating any fixture, read its
  diff and confirm the only change is that expiry.
- *Code calls the agent on a thread it keeps using.* The persona used
  to stay. It is now removed. This is the fix.
- *Code calls the agent twice on one thread.* The persona used to be
  pushed once and kept. It is now pushed and removed each time.
  `coderTurn` in the agent does this across turns on its session thread
  (`agency agent --agent code`).
- *A paused agent.* An agent that stops for an approval keeps its
  persona until the resumed call finishes. This is the `llmCall` rule
  and needs no new code. Task 5's tests pin it.

Tests. Add them to `tests/agency-js/handoff/`, or as Agency tests beside
`tests/agency/threads/expires-llm-call.agency`, whichever can assert on
the requests the model received. Use the deterministic client. Use a
small handoff written for the test with the same two-line shape as the
stdlib agents; do not drive a real stdlib agent.

1. **From code.** A function opens a thread, pushes its own system
   message, and calls the handoff. During the handoff's `llm()` call the
   request holds both system messages. Afterwards the thread holds the
   caller's system message, the handoff's prompt, and the reply, and not
   the persona.
2. **The caller's next call.** After case 1, the caller makes an `llm()`
   call. The request has no persona.
3. **As a tool.** A model calls the same handoff. The final thread has
   the same roles and text as it has on main. Record the thread on main
   first and compare against it.
4. **A pause and a resume.** The handoff's `llm()` call has a tool that
   raises an interrupt nobody handles. The run returns the interrupt
   with a checkpoint, and the thread in the checkpoint still holds the
   persona. Resume with an approval. The persona is gone when the call
   finishes, and no request held it twice. Before writing this, ask what
   would make it fail: it must fail if the pause removed the persona.
5. **A failure.** The handoff's `llm()` call fails. The persona is gone.
6. **Twice on one thread.** Two from-code calls in a row. Each request
   holds the persona once, and the thread holds none after each.
7. **The researcher's second call.** With a mocked empty first answer,
   the follow-up request holds the persona. This one drives
   `researcherAgent` itself; see how `docs/dev/agents/research-loop.md`
   and the existing researcher tests mock an empty answer.

Run the existing `tests/agency-js/handoff` and `tests/agency-js/end-turn`
suites, and the agent tests that cover `--agent code`, `--agent
research`, `--agent oracle`, and `--agent explorer`.

Update the docs for this part:

- `docs/dev/language/handoff-functions.md`: in "Called from code", say
  that the stdlib agents' personas expire with their `llm()` call, so a
  from-code call no longer leaves one behind, and that a handoff's other
  system messages still stay when code calls it. In "What happens", note
  that a persona pushed with its own expiry is removed by that expiry
  and not by the handoff's close.
- `docs/dev/runtime/expiring-messages.md`: the list at the top names the
  persona as the first expiring message, removed "when the body
  returns". Correct it: the stdlib agents' personas are `llmCall`
  messages now. The `handoff` owner still exists for any other system
  message a handoff body pushes.
- `docs/dev/contributing/message-thread-tests.md` lists every
  message-thread test case. Add the cases from this task, and fix its
  `twoDispatches` line, which says the persona is pushed fresh "through
  `ensureSystemMessage`".
- Keep the index lines for both docs in `CLAUDE.md` and in the
  `agency-language-docs` and `agency-runtime-docs` skills true, in the
  same words in both places.

## Part C: the router

### Task 6: the `router` slot

A slot is a named purpose a model fills.
`lib/agents/agency-agent/lib/slots.agency` lists them: `main`,
`reasoning`, and `embedding`. Add `router`.

The slot is optional and has no default. When nothing sets it, routing
is off. Give it the existing `derived` kind in `SLOT_KIND`. That kind
already behaves the way this slot needs: it resolves to empty by
default, it never inherits the main provider
(`lib/agents/agency-agent/lib/resolution.agency`), a bare `--model`
does not set it, and `promoteAll` in
`lib/agents/agency-agent/shared.agency` leaves its provider alone. Do
not add a new kind. A new kind would get the chat slots' provider
handling, which turns `openai` into `openai-responses` and would break
a decision call.

Several places handle the embedding slot by name, not by kind. These
are all of them outside tests. Paths are under
`lib/agents/agency-agent/`. Confirm the list with
`rg -n '"embedding"' lib/agents/agency-agent`, which also searches
`shared.agency`.

| Place | What it does for the embedding slot | What the router needs |
| --- | --- | --- |
| `lib/modelRequest.agency`, `modelFlagProblem` | refuses a `--model` value with no provider | the same check, with the router's provider list |
| `lib/modelRequest.agency`, `modelFlagsFromArgs` | counts every other slot as a chat slot for the `--local` rule | the router is not a chat slot |
| `lib/modelRequest.agency`, `localModelOf` | carries the value into `LocalModel` | carry the router value too |
| `lib/session.agency`, the mixed-provider warning | leaves the slot out | leave the router out too |
| `lib/session.agency`, `/model` | refuses a value with no provider | the same check, with the router's provider list |
| `lib/session.agency`, `/model` | warns when the provider's key is missing | nothing (see "A failure is reported once" in Task 7) |
| `lib/settings.agency` | ignores a `settings.json` value with no provider | the same check, with the router's provider list |
| `lib/presetRules.agency` | refuses a preset value with no provider | the same check, with the router's provider list |
| `shared.agency`, local embedding name | resolves a local name to its served name | nothing; a `llama-cpp` router value is a file path |
| `shared.agency`, `configureLocalModel` | builds a local session's slots by hand and calls `applyResolved` | add the router here |

Where two slots now share a rule, write the rule once over a list of
the slots it applies to. Do not copy the embedding lines.

The four "needs the provider/model form" checks all call
`embeddingSpecHasProvider` in `lib/models.agency`, which reads
`knownProviders()`. Give that check the provider list as an argument
and call it with each slot's own list (see "Which providers the slot
accepts" below). Otherwise `router=typesafe/jev-1.14` passes the parse
and is then refused by the check.

The mixed-provider warning fires when an `llmOptions` block sets a
provider-specific option and the session's slots use more than one
provider. A decision call ignores those options, so a router on
`openrouter` beside a main model on `anthropic` must not trigger it.

`lib/agents/agency-agent/lib/models.agency` labels a derived slot's
default as `"built-in:embedding(derived)"`. `/model` would print that as
the router's source. Make the label name the slot.

Follow the slot through every place
`docs/dev/agents/agent-presets.md` names:

- `--model router=openrouter/jev-1.14` on the command line. Like the
  embedding slot, the value must be in the `provider/model` form, and a
  value without a provider is refused with a message that shows the
  form.
- `slots.router` in a preset, checked by `checkPreset` in
  `lib/agents/agency-agent/lib/presetRules.agency`.
- `settings.model` in `settings.json`.
- `/model`, which prints each slot and the layer that set it.

**Which providers the slot accepts.** A slot value such as
`openrouter/jev-1.14` is split by `parseModelSpec` in
`lib/agents/agency-agent/lib/models.agency`. It treats the part before
the slash as a provider only when it is in `knownProviders()`, and that
list has neither `typesafe` nor `laya`. So `--model
router=typesafe/jev-1.14` would be refused as having no provider. Add a
separate list of the providers the router slot accepts, `typesafe`,
`laya`, `openai`, `openrouter`, and `llama-cpp`, and use it only when
parsing that slot. Do not add them to `knownProviders()`; that would
let `typesafe` and `laya` into the chat slots, where they cannot work.

**With `--local`.** `modelFlagsFromArgs` in
`lib/agents/agency-agent/lib/modelRequest.agency` treats every slot
other than `embedding` as a chat slot, and refuses a chat slot together
with `--local`. The router is not a chat slot. Allow
`--local <model> --model router=...`, the way the embedding slot is
allowed: a local session may route with a hosted decision model. The
`LocalModel` record in the same file then needs the router value, and
`configureLocalModel` in `lib/agents/agency-agent/shared.agency`, which
builds a local session's slots by hand, must add the router to them.
Without that, `getRouterModel()` is `""` in every local session. Test
that a `--local` session with the slot set has a non-empty
`getRouterModel()`.

Add `getRouterModel()` and `getRouterProvider()` to
`lib/agents/agency-agent/shared.agency`. Both return `""` when the slot
is unset. They cannot copy `getSlowModel()`, which returns a module
global that `applyResolved` sets: `applyResolved` does nothing for a
derived slot. Read the slot from `getResolvedSlots()["router"]`.

Tests: add cases to the existing slot, model-request, and preset tests
in `lib/agents/agency-agent/tests/`. Cover: the flag sets the slot; a
value with no provider is refused; a preset sets it; nothing set means
`getRouterModel()` is `""`; a bare `--model` leaves it unset; `/model`
prints the router's own label; `router=typesafe/jev-1.14` and
`router=laya/laya` are accepted; `--model main=typesafe/jev-1.14`
still gives the main slot no `typesafe` provider (today the whole
string becomes the model name, and that must not change); `--local`
with a router slot is accepted; a router on another provider than the
main model does not trigger the mixed-provider warning.

### Task 7: the router module

Create `lib/agents/agency-agent/brains/coordinator/router.agency`. It
holds one idea: given a user's message, which of `research`, `code`, or
`coordinator` should handle it.

The sketch below is the shape; adjust it to what you find. It
type-checks once Part A has added the `decision` option.

```ts
import { lastReply, userMessage } from "std::thread"

export type Route = "research" | "code" | "coordinator"

type RoutePick = {
  route: Route;
  confidence: number
}

// From the routing test: at 0.7 no logged turn went to a wrong subagent.
static const ROUTE_MIN_CONFIDENCE = 0.7

def askRouter(text: string, question: string, model: string, provider: string): RoutePick {
  let pick: RoutePick = { route: "coordinator", confidence: 0 }
  thread(label: "route") {
    userMessage(text)
    const route: Route = llm(question, {
      model: model,
      provider: provider,
      decision: true,
      retries: 0,
      timeout: 3s
    })
    const reply = lastReply()
    if (reply != null && reply.answers != null) {
      const answer = reply.answers["answer"]
      if (answer.type == "choice" && answer.confidence != null) {
        pick = { route: route, confidence: answer.confidence }
      }
    }
  }
  return pick
}

export def pickRoute(text: string, question: string, model: string, provider: string): Route {
  const asked = try askRouter(text, question, model, provider)
  if (isFailure(asked)) {
    return "coordinator"
  }
  if (asked.value.confidence < ROUTE_MIN_CONFIDENCE) {
    return "coordinator"
  }
  return asked.value.route
}
```

How it works, and what must stay true:

- **Its own thread.** `thread(label: "route")` is a fresh thread, so
  the question and the answer never appear in the main conversation.
  `userMessage(text)` puts the user's message on it. For a decision
  call, the thread before the prompt is what the model reads and the
  prompt is the question, so the model reads the message and answers
  the question (`docs/dev/llm/decision-models.md`, "The state").
- **It is a decision call.** `decision: true` (Part A) lets the router
  use a model the catalog does not list as a decision model, such as a
  local chat model.
- **The confidence.** A decision call returns only the chosen option.
  `lastReply().answers` holds the full answer. For a call with a bare
  type annotation the answer is named `answer`. Part A makes
  `confidence` nullable; the sketch already checks for `null`.
- **Every doubt goes to the coordinator.** A failed call, a timeout, a
  missing key, a confidence below the floor, a missing confidence, and
  the answer `coordinator` all return `"coordinator"`. The `try` turns a
  thrown error into a failure. The router must never make a turn fail.
- **It is fast or it is skipped.** `retries: 0` and a 3 second timeout.
  Check the option names and units against
  `lib/typeChecker/builtins.ts`.
- **A cancel is not a doubt.** If the user presses Ctrl+C while the
  router call is in flight, the turn must stop. It must not be caught
  and turned into a coordinator call. The retry classifier lets an abort
  through (`lib/runtime/llmRetry.ts`); confirm that `try` does too, and
  if it does not, check for the abort before falling back.
- **A failure is reported once.** A missing key or a misspelled model
  name makes the router fail on every turn, and the user would think
  routing is on. The first time the router call fails in a session,
  print one dim line with the error. That one line covers a missing
  key, a wrong model name, and a server that is down, so do not add a
  key check at startup as well. Keep a flag for "already reported" in a
  module-level `let`, as `coordinator.agency` does for `first`, and
  clear it when `/model` changes the router slot, so a user who fixes
  one problem and hits another sees the second.
- **It asks once.** No voting.

**The question.** Build the prompt text in a function in the same file.
It is the question followed by one line per option:

```
Which agent should handle the user's latest message?

research: <description>
code: <description>
coordinator: <description>
```

Use this text. It is the question from the last row of the table in
the background, the version that was measured. Keep each description as
a named constant, and do not reword them.

```
Which agent should handle the user's latest message?

research: Answer a question that needs reading rather than writing: looking something up on the web, fetching a URL, summarizing a document, gathering background, or recalling a stored fact.
code: A coding task in any language except Agency: reading, writing, and editing code, running commands, builds, and tests.
coordinator: Anything small enough to handle directly: a short answer or a follow-up about the conversation so far, a few file reads, searches, or edits, running a saved skill or learned tool, or saving a skill. Also any question about the Agency language. Its other tools: <names>.
```

Each option is one line, `<name>: <description>`, and the options are
joined with single newlines after a blank line. " Its other tools:
<names>." is added only when there are names (see below).

The descriptions came from a nine-option question in
`scripts/decision-shadow/runDecisions.ts` in the
`worktree-decision-shadow` worktree. The `research` and `code` lines
are unchanged from it. The `coordinator` line has the added sentence
about the Agency language. With three options, a request for a review,
a second opinion, a survey of many files, or Agency code also belongs
to the coordinator, which reaches those subagents itself. The measured
text does not say so in words; the tool names carry it, because
`reviewAgent`, `oracleAgent`, `explorerAgent`, `writingAgent`,
`rewriteAgent`, and `agencyCodeAgent` are among the coordinator's other
tools. Do not add a sentence for it without measuring first.

The thirty names used in the measured run, in order, were:
`learned_indiaNews`, `learned_skills`, `learned_tv`,
`mcp_linear_list_issues`, `mcp_linear_get_issue`,
`mcp_linear_save_issue`, `mcp_github_search_code`,
`mcp_github_get_pull_request`, `skill`, `reviewAgent`, `oracleAgent`,
`explorerAgent`, `writingAgent`, `rewriteAgent`, `agencyCodeAgent`,
`generateImageFile`, `viewImageFile`, `learnSkill`, `writeToolFor`,
`coordinator_skills`, `listPresets`, `savePreset`, `deletePreset`,
`setDefaultPreset`, `useLlmOptions`, `read`, `write`, `edit`, `ls`,
`grep`. The first nine stand in for a user's own tools; the rest are
built in. They were joined with ", ".

**The coordinator's other tools.** The coordinator has tools the
subagents do not: learned tools and skills, MCP tools, Claude skills,
generated tools, and its own small tools. The test found a turn where
the model picked `research` for a request a learned tool answers in two
seconds, because it did not know the tool existed. So the function that
builds the question takes a list of tool names and adds " Its other
tools: <name>, <name>, ..." to the `coordinator` line when the list is
not empty. Names only, capped at 30, keeping the order it is given.
The caller supplies the list, already ordered (Task 8). This module
does not read the tools itself.

**What the module does not do.** It does not call a subagent and it
does not touch the main thread. It is given a message and a list of
names, and it returns a `Route`.

Tests, in `lib/agents/agency-agent/tests/`, with the deterministic
client and `{ decide }` mocks (see `lib/runtime/deterministicClient.ts`
and how `tests/agency-js/decision-model` mocks a decision):

- a confident `research` answer returns `research`;
- a `research` answer with confidence 0.6 returns `coordinator`;
- an answer with no confidence returns `coordinator`;
- a failed decision call returns `coordinator` and does not fail, and
  the failure is printed once across two failing turns;
- a cancelled router call cancels the turn and makes no coordinator
  request. The deterministic client's `decide` returns its mock at once
  (`lib/runtime/deterministicClient.ts`), so a test cannot cancel a
  decision call in flight. Text mocks take a `delayMs` that waits on the
  abort signal; give decision mocks the same field, with a unit test in
  `deterministicClient.test.ts`. This is test support in `lib/runtime/`
  and the one exception to "nothing there beyond Part A";
- the request the mock received has the user's message as its state and
  the three descriptions in its question;
- given tool names, the question lists them on the `coordinator` line,
  and given more than 30 it lists 30;
- the caller's thread is unchanged after `pickRoute` returns.

### Task 8: use the route in `mainAgent`

`mainAgent` in `coordinator.agency` today pushes the system prompt on
the first turn, adds the global instructions, and makes one `llm()`
call, all inside `thread(label: "main", session: "main")`.

Ask for a route before that `thread` block, when all of these hold.
Otherwise the route is `"coordinator"`.

- The `router` slot is set.
- The prompt is plain text. A prompt with attachments goes to the
  coordinator.
- The text is at most `ROUTE_MAX_CHARS` long. Set it to 8,000. The REPL
  sends `withPendingNotes(msg)`, which puts every pending note above
  the message in one string, and a note can be the whole output of a
  `!` shell command. Such a prompt is not a message the router was
  tested on, the subagent would receive the note as its task, and a
  long one can exceed what the decision model accepts.

Pass the router the names of the turn's tools that are not routed
subagents: the names in `turnTools(turnStart)` other than
`researchAgent` and `codeAgent`. Order matters, because the router
keeps the first 30. `turnTools` lists the built-in tools first, and one
or two MCP servers would fill the cap before any learned tool is
reached, which is the kind of tool the list exists for. Put the tools
that differ per user first: learned tools, generated tools, Claude
skills, MCP tools. Then the built-in ones. Build the two groups from
the same calls `turnTools` makes; do not sort by name pattern.

Then, inside the `thread` block, where the `llm()` call is today:

```ts
const result = match (route) {
  "research" => replyText("The researcher", researchAgent(text))
  "code" => replyText("The coder", codeAgent(text))
  _ => llm(prompt, mainOptions(turnStart))
}
```

`replyText` is already in the file; `researchTurn` and `coderTurn` use
it to turn a subagent's `Result` into the reply. `text` is the user's
message, unchanged. `mainAgent` takes `prompt: string | (string |
Attachment)[]` and has no `text` today. Get the text and the "is plain
text" check from one `match` on `prompt`, the way `promptText` in the
same file reads it, so the two cannot disagree. Everything before the
`match` stays as it is: the
system prompt on the first turn and `addGlobalInstructions()` still run
for a routed turn, so the main thread is set up the same way whichever
arm runs. A `match` is allowed as the value of a `const`
(`docs/dev/language/match-expression-positions.md`).

Because of Part B, the subagent's persona is on the main thread only
while the subagent works. The subagent's prompt and its reply stay, so
the coordinator sees them on a later turn.

Things to check while doing this:

- **The global instructions.** `addGlobalInstructions()` pushes a
  message that expires with the next `llm()` call. On a routed turn that
  call is the subagent's, so the subagent reads the global instructions
  and they are removed when it finishes. The subagent wrappers also pass
  the same text as context. Check a routed request and make sure the
  model does not get the instructions twice in a way that matters; if
  it does, skip `addGlobalInstructions()` for a routed turn.
- **The memory id.** `researchAgent` calls `setMemoryId("research")`.
  On a routed turn that runs on the main thread, after `mainAgent` set
  the id to `"main"`, and the next turn sets `"main"` again. Check
  whether anything between the end of a routed turn and that next call
  reads the id, such as memory saved at the end of a turn. If something
  does, set the id back to `"main"` after the routed call.
- **The subagent announces itself.** `researchAgent` and `codeAgent`
  call `announce(...)` with the message. Run a routed turn in the REPL
  and check the line reads sensibly when the message is the user's own
  text.
- **A resumed turn.** Read `docs/dev/agents/agent-sessions.md`. The
  route is computed by ordinary Agency code, so a turn that pauses on an
  approval and resumes does not ask the router again. Confirm this with
  the test below; do not assume it.

Tests, as agent turn tests beside
`lib/agents/agency-agent/tests/turn.agency`, with the deterministic
client:

- slot unset: no decision request is made, and the turn runs as today;
- a confident `research` route: the researcher runs with the user's
  message as its task, and the coordinator model receives zero requests
  for the turn;
- a confident `code` route: the same for the coder;
- a `coordinator` route: the turn runs as today, with one decision
  request before it;
- a prompt with an attachment: no decision request;
- a prompt longer than `ROUTE_MAX_CHARS`: no decision request;
- the decision request's question lists a tool from `turnTools` that is
  not a routed subagent;
- after a routed research turn, the main thread holds the coordinator's
  system prompt, the researcher's prompt and reply, and no system
  message from the researcher;
- a turn after a routed turn goes to the coordinator, and the request
  the coordinator model receives holds the routed turn's prompt and
  reply and no researcher persona;
- a routed turn whose subagent pauses on an approval: after the resume
  there is still exactly one decision request for the turn. This only
  means something if the pause goes through a checkpoint and
  `mainAgent` runs again from its saved frame. If the test answers the
  approval in the same process, nothing re-runs and the count is one
  however the route is computed. Find out which path the test harness
  takes and use the one that re-enters `mainAgent`. Before writing the
  test, ask what would make it fail.

### Task 9: try it for real

Run the agent with `--model router=openrouter/jev-1.14` and
`OPENROUTER_API_KEY` set, with `HOME` pointing at a scratch folder and
the statelog written to a scratch file. Send four messages: a research
question, a coding request, a greeting, and a follow-up question about
the previous answer. For each, read the trace with
`pnpm run agency logs outline --log <file>` and record in the pull
request description:

- the route and its confidence;
- how long the route call took;
- the time from the start of the turn to the subagent's first model
  request;
- which coordinator model the run used, since the saving depends on it.

Then run the same four with the slot unset and record the same time.
For the follow-up question, say whether the answer used the earlier
turn; a routed subagent works on the main thread, so it should. Do not
paste message text from any real session into the description.

### Task 10: the router's dev doc

Write `docs/dev/agents/agent-router.md`. Keep it to the mechanism and
the rules:

- what the router does and when it runs;
- the `router` slot and how to set it;
- the question, the three options, why the descriptions are in the
  prompt, and why the coordinator's other tools are named;
- the confidence floor, where the number came from, and that every
  doubt goes to the coordinator;
- the length cap and what it guards against;
- how a routed turn runs: the subagent is called from code on the main
  thread, its persona expires with its `llm()` call (Part B), and its
  prompt and reply stay for the coordinator to read later;
- what the main thread holds after a routed turn. The user's message is
  not pushed as a message of its own. The thread gets the subagent's
  prompt, which for the researcher is the user's text followed by the
  REPL style notes and the global instructions. When the coordinator
  calls a subagent as a tool, the user's message is on the thread as
  well;
- interrupts and policy: unchanged, and why;
- sessions: what a saved and resumed turn does;
- the known limits listed near the top of this plan;
- how to add a routed subagent: a description, an arm in the `match`,
  and a measurement first.

Add it to the index in `CLAUDE.md` under "Agents", and to the
`agency-agent-docs` skill, in the same words. Add the `router` slot to
`docs/dev/agents/agent-presets.md` where the slots are described.

## Before opening the pull request

- `make`, `pnpm run typecheck`, `pnpm run lint:structure`, and the tests
  named in each task pass, the agent tests with `--check-capabilities`.
  Paste the summary lines into the description.
- Check the diff against `docs/dev/contributing/anti-patterns.md`.
- Read the whole diff once and remove anything a task did not ask for.
- The description says:
  - what callers of `lastReply().answers` must change;
  - what changes for a program that calls a stdlib agent from code, and
    for `ensureSystemMessage`;
  - the Task 9 numbers and the router's known limits;
  - which pages under `docs/site/` need the owner's update: the decision
    models guide page, the handoff section of the functions guide page,
    and wherever the agent's model slots are described.
