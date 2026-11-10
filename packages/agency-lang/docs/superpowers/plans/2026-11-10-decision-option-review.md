# Review: the `decision` option and the new decision providers

Plan: `docs/superpowers/plans/2026-11-10-decision-option.md`

I checked the plan against the code on main (`5b2ff90a8`) and against the
smoltalk 0.20.2 catalog in `node_modules`. Findings are ordered by
severity.

## Status

The plan cannot start today. `npm view smoltalk` lists 0.20.2
(2026-10-30) as the latest release, and the plan needs a release with
smoltalk #78, #79, and #80. The plan already says to stop in that case.

## Blocking

### 1. The catalog lookup in rule 3 would make every typed call to `gpt-6-luna` a decision call

The "catalog entry" paragraph of Task 2 says `isDecisionCall` rule 3
should look the model up with `getDecisionModelForProvider` first, "so
that a decision entry is found even when a text entry with the same name
comes first". For `gpt-6-luna` under `openai`, that lookup finds the
decision entry. With no `decision` option, the call becomes a decision
call.

That breaks programs that work today. `gpt-6-luna` is a chat model, and
the smoltalk catalog names it as the migration target for GPT-4o,
GPT-4.1, GPT-4.1 mini, and GPT-5.4 nano
(`node_modules/smoltalk/dist/models.js:155`, `:178`, `:417`, `:440`,
`:729`). `isDecisionCall` does not look at the response type, so even an
untyped call such as `llm("hi", { model: "gpt-6-luna" })` would go to the
Decisions API and fail in `planDecision`.

It also contradicts the plan itself. The plan says rule 3 "stays so that
every program that works today keeps working", and the problem statement
says a typed call goes to the chat API and needs a way to opt in.

Fix: rule 3 keeps `modelRecord` exactly as it is today
(`lib/runtime/decision/dispatch.ts:44-50`). Only `questionCapFor` uses
the decision lookup, and it runs only once a call is already a decision
call. Add a test: `gpt-6-luna` under `openai` with no option is a text
call.

### 2. The "needs a provider" refusal will almost never fire; the common failure is a provider inherited from a chat default

The plan refuses `decision: true` when there is "no provider anywhere".
In practice there nearly always is one. `config.provider` is the merge
of the `agency.json` default, the branch default from `setLlmOptions`,
and the call. The agent, for example, sets a provider on every branch in
`applyResolved` (`lib/agents/agency-agent/shared.agency:370-375`).
`modelProviderOverride` (`lib/runtime/llmConfig.ts:30-52`) changes the
provider only when the new model's catalog entry is a decision entry,
which an unknown model does not have.

So this call, in a program whose default provider is `anthropic`:

```ts
const x: Dept = llm("Which department?", { model: "new-decider", decision: true })
```

passes the plan's check and sends a `decide()` request to `anthropic`.

Recommended rule for Task 2: with `decision: true`, refuse before the
request when the resolved provider does not answer decisions, and name
the provider in the message. Check whether the new smoltalk release
exports its list of decision providers; use it if so. Also say what
`modelProviderOverride` should do for `decision: true` with no explicit
provider and a model that has a decision entry: take the decision
entry's provider. Test both with a default provider of `anthropic` in the
fixture, because a test with no default provider at all does not match
how programs run.

## Important

### 3. The `logprobs` trail points at the wrong places

`logprobs` appears only in `PromptConfig` (`lib/runtime/llmClient.ts:35`),
`toSmolConfig` (`llmClient.ts:469`, `:492`), and the type checker
(`lib/typeChecker/builtins.ts:148`). It is not in `LlmOpts`
(`lib/runtime/agencyLlm.ts:48`), it is not read in `lib/runtime/prompt.ts`,
and `setLlmOptions` does not accept it. So "follow how `logprobs` is
treated there" gives the implementer nothing for three of the six bullets.

What actually happens to a new per-call key:

1. It lands in `restClientConfig` (`prompt.ts:596`), which is merged into
   `clientConfig` (`prompt.ts:662-668`). No change to `prompt.ts` is
   needed for `decision` to reach `PromptConfig`, because `_runPrompt`
   spreads `clientConfig` into it (`prompt.ts:335-341`).
2. The same path sends it to smoltalk. `toSmolConfig` spreads
   `...metadata` (`llmClient.ts:478`), and `metadata` is the whole
   `clientConfig`. The fix belongs in `toSmolConfig`: drop `decision` from
   the metadata spread. The plan's "check that it does not leak" is right;
   make it the instruction.
3. `setLlmOptions` takes its type from `LlmDefaults` in two places:
   `lib/stdlib/llm.ts:34` and the Agency mirror in
   `stdlib/llm.agency:121`. The type checker checks the Agency one.

Rewrite the bullet list with these locations.

### 4. Leave `decision` out of `setLlmOptions` unless there is a user for it

A branch default of `decision: true` makes every later `llm()` call in
that branch a decision call. Calls with tools are then refused by
`prepareDecision`, and untyped calls fail in `planDecision`. The case the
plan gives ("a branch that runs every call against a decision model")
is already covered when the model is in the catalog, because rule 3 reads
its entry type. Adding it to `setLlmOptions` also means a doc entry in
`stdlib/llm.agency` and a test. I recommend dropping it from this pull
request. If it stays, the docstring has to say what happens to a call
with tools or an untyped call in that branch.

### 5. Task 3's search misses the Agency mirror of the base URL type

`rg typesafe lib` does not search `stdlib/`. `stdlib/llm.agency:71` holds
the `baseUrl` type that `setLlmOptions` accepts, and it lists
`typesafe`. Search `lib stdlib`, and add `laya` there too. Also update
the `Pick<..., "typesafe">` in `lib/runtime/llmConfig.ts:12` to include
`laya` once smoltalk's `DecideConfig` has it.

## Minor

### 6. The test of an unknown model "under another provider"

Task 2's first test keeps today's answer for "an unknown model under
another provider". After finding 2, add the same case with
`decision: true`, which is the case the refusal is for.

### 7. The batching check

The plan expects no batching change and confirms it with the existing
`decision-batch` test. That test only runs calls the catalog already
marks as decision calls. One case with `decision: true` on a text-catalog
model inside `parallel` would show the collector groups it like the
others. This is cheap and catches a missed list.

## What the plan gets right

The rule order in Task 2 is clear and testable. The plan names the
leak through `...metadata`, keeps the guide page out of scope, and stops
on the missing smoltalk release.
