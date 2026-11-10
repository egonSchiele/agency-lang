# Review: an `llm()` option that starts the tool loop with a chosen tool call

Plan: `docs/superpowers/plans/2026-11-10-first-tool-call.md`

I checked the plan against `lib/runtime/prompt.ts`, `lib/runtime/llmClient.ts`,
and `lib/stdlib/llm.ts` on main (`5b2ff90a8`). The design is sound: the
chosen call enters the loop where a model reply would, so handlers,
gates, handoffs, and resume all run through the code that exists. Test
cases 5 and 6 pin the two properties that matter most. Findings are
ordered by severity.

## Important

### 1. Remove the option from the config where it is read, or it is sent to the provider on every request

A new key on the per-call options lands in `restClientConfig`
(`prompt.ts:596`). From there it is merged into `clientConfig`
(`prompt.ts:662-668`), passed to every `_runPrompt`, spread into
`PromptConfig` (`prompt.ts:335-341`), and spread again into the smoltalk
config through `...metadata` (`llmClient.ts:478`). So `firstToolCall`
would ride along on every later model request of the call.

The plan says "`toSmolConfig` must not forward it". The better place is
the destructure at `prompt.ts:582-597`, beside `tools` and `memory`. That
reads the option from the per-call config only, and keeps it out of
`clientConfig` entirely.

The same destructure answers the branch-default rule. The type checker
refuses `setLlmOptions({ firstToolCall: ... })` because
`stdlib/llm.agency:121` does not list it, so that test passes before any
change is made. At run time, though, `_setLlmOptions` copies every key it
is given (`lib/stdlib/llm.ts:93-104`), so a TypeScript caller can still
put it in the branch defaults, and `stackSmolDefaults` merges it into
`clientConfig` (`prompt.ts:641-662`). Either drop it from
`stackSmolDefaults` the same way `maxToolCallRounds` is dropped, or
accept that it is ignored there, and test that a branch default does not
start a call with a tool.

### 2. Run the check before the call-entry boundary, not only before the prompt push

The plan checks the option "before the prompt is pushed, so a bad one
changes nothing". Before `pushPrompt` there is `runInitialBoundary`
(`prompt.ts:849`), which delivers queued messages and runs the guard
gate, and both can change the thread. Put the check where the tools are
resolved (`prompt.ts:529-566`). Test case 7 should then assert that a
queued message is still queued after the failed call.

### 3. Check the name against the tools the loop would offer

Check `name` against `exposedFunctions` (`prompt.ts:542`), which leaves
out tools removed after rejections. Also refuse the option when the
round cap means the first request offers no tools (`atRoundCap()`,
`prompt.ts:573`, and `toolsOffered`). Otherwise the chosen call runs a
tool the model could not have called.

### 4. Skipping `_runPrompt` skips more than metering

`_runPrompt` also fires the `onLLMCallStart` and `onLLMCallEnd` callbacks
(`prompt.ts:320-330`, `:400-411`) and runs `runPostTurnMemory`
(`prompt.ts:398`). None of these run for the chosen round. That is
probably right, since no model was called, but the plan only discusses
cost. Add both to the dev doc's "what is not metered" section, and check
that nothing in the agent's display waits on `onLLMCallEnd` to show the
first tool call.

### 5. Test case 9 cannot fail on its own

Case 2 already asserts there are zero model requests. With no request,
nothing is metered, so a cost guard around case 2 can only trip if case 2
already fails. A guard of exactly zero dollars may also trip at entry
for reasons unrelated to this feature, depending on whether the
comparison is `>` or `>=`. Replace it with an assertion that the run's
cost and token totals are unchanged after the chosen round, or drop it.

## Minor

### 6. Name the constructor for the assistant message

`_runPrompt` pushes `buildReplyMessage(completion, toolCalls, ...)`
(`prompt.ts:385`), which takes a model completion. Say whether to build a
`PromptResult` for it or to build smoltalk's assistant message directly.
A message built from a completion carries the completion's usage, cost,
and model. Test case 3 compares the thread against a model-made call, so
compare roles, text, and tool calls. Do not compare message metadata, or
the test fails for reasons that have nothing to do with the feature.

### 7. One of the three refusals is redundant, and one has the wrong reason

"The tool list is empty" is already covered by "`name` is not one of this
call's tools". Cut it.

Keep the decision-call refusal, but fix its reason. The plan says
`prepareDecision` already refuses a call with tools. It does, but
`prepareDecision` runs inside the dispatch, and the chosen round never
dispatches. Without this check, a decision call would run the chosen tool
and only fail on the next request.

### 8. A number in the background is off

"In 60 logged turns its median was 13.2 seconds." In the results
document, 13.2 seconds is the median from turn start to dispatch over the
38 turns that dispatched. The median first coordinator call over all 60
turns is 11.7 seconds.
