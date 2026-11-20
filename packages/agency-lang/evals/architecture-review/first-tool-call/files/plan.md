# Plan: an `llm()` option that starts the tool loop with a chosen tool call

This is the second of three plans. Each is one pull request.

1. `2026-11-10-decision-option.md`: the `decision` option and the new
   decision providers.
2. This plan: an `llm()` option, `firstToolCall`.
3. `2026-11-10-agent-router.md`: the agent uses a decision model to send
   a turn straight to a subagent. It needs this plan.

This plan does not depend on plan 1 or on any smoltalk release.

## Background

### The problem this solves

`agency agent` has a coordinator model that reads each user message and
usually hands it to a subagent by calling a tool such as `researchAgent`.
That first coordinator call is slow. In 60 logged turns its median was
13.2 seconds, and nearly all of that time went to reasoning and to
writing a brief for the subagent. Picking the subagent is the small
part, and a decision model can do it in 0.2 seconds. (The measurements
are in the results document of the routing test, in the
`worktree-decision-shadow` worktree under
`docs/superpowers/specs/2026-11-09-decision-routing-shadow-test-results.md`.)

So the program already knows which tool should run and with what
arguments. What it lacks is a way to say so. Today the only way to run a
tool inside an `llm()` call's tool loop is for the model to ask for it.

### Why not call the subagent from code

The subagents are `handoff def` functions
(`docs/dev/language/handoff-functions.md`). Read that doc in full; this
plan leans on it. The short version:

- When a **model** calls a handoff as a tool, the body continues the
  caller's conversation. The runtime removes the tool call from the
  thread, gives every system message the body pushes an expiry tied to
  this dispatch, and when the body returns it removes those messages and
  adds a hand-back message. `endTurn()` inside the body can end the
  caller's `llm()` call with the body's answer.
- When **code** calls a handoff, it is an ordinary function call.
  Nothing is removed afterwards. The subagent's persona, a system
  message, stays on the caller's thread for good, and `endTurn()` has
  nothing to end.

A direct call from code would therefore leave the researcher's persona
in the coordinator's conversation, where every later coordinator call
would read it as its own instructions. Everything needed to avoid that
already exists in the tool loop. The cleanest fix is to let the program
put a tool call into the loop, so the rest of the loop runs as it does
today.

### What the option does

```ts
const answer = llm(prompt, {
  tools: [researchAgent, codeAgent],
  firstToolCall: { name: "researchAgent", args: { userMsg: "..." } },
})
```

The call pushes the prompt onto the thread as usual. Then, where it
would send the first request to the model, it acts as though the model
had replied with exactly that one tool call. From that point nothing is
different. The call passes through the same refusal gates, the same
handoff steps, the same handlers and interrupts, and the same hand-back.
If the tool ends the turn with `endTurn()`, `llm()` returns with no
model request at all. Otherwise the loop sends its next request to the
model as it does after any tool round.

The option is general. It is the piece that lets any program say "a
cheaper decision already picked the tool; run it", which is the use the
owner asked about when this work began.

### How the tool loop is built

Read `docs/dev/agents/promptRunner.md` before touching
`lib/runtime/prompt.ts`. The parts that matter here:

- `runPrompt` resumes after an interrupt by running again from the top.
  Each `pr.step(key, body)` runs its body once; a resumed pass skips a
  completed step. Code between steps runs again on every pass.
- So anything that must happen once goes inside a step, and anything a
  later pass must read goes on `self` (the frame) or `self.runnerState`,
  which are saved in the checkpoint.
- The prompt is pushed in the `pushPrompt` step. The first model request
  is made in the step right after it, inside
  `requestStepWithTripRetry({ first: true }, ...)`. That step calls
  `_runPrompt`, then sets `messages`, `toolCalls`, `lastStopReason`,
  `lastUsageKind`, `self.messagesJSON`, and `self.pendingToolCalls`.

## What this plan changes

1. `llm()` takes `firstToolCall: { name, args }`.
2. The first request step uses it in place of a model request.
3. The logs show that the first round's call was chosen by the program.
4. A new dev doc records the mechanism.

## What this plan does not change

- Handlers, policies, and interrupts. The chosen call is not an
  approval of anything. The tool raises its interrupts and every handler
  in the chain is consulted, exactly as for a call the model made. This
  is a requirement, and Task 3 tests it.
- The refusal gates in `docs/dev/agents/tool-loop-guards.md`. They run
  on the chosen call as on any other.
- More than one chosen call, or a chosen call in a later round. One
  call, first round only.
- The agent. Plan 3 uses the option.

## Before you start

- Create a worktree inside `packages/agency-lang` and work there. Never
  work in the main checkout.
- Read, in this order: the "MUST READ" section on interrupts in
  `CLAUDE.md`; `docs/dev/runtime/interrupts.md`;
  `docs/dev/agents/promptRunner.md`;
  `docs/dev/language/handoff-functions.md`;
  `docs/dev/agents/tool-loop-guards.md`;
  `docs/dev/runtime/checkpoint-patch.md` (it explains why the loop
  records its tool names); and the four contributing docs named in
  `CLAUDE.md`.
- Then read `runPrompt` in `lib/runtime/prompt.ts` from `pushPrompt` to
  the end of the tool loop.

## Rules

- Run only the tests that cover what you changed, with the output saved
  to a file. Do not run the whole Agency test suite locally.
- Run `pnpm run build` before trusting a test of compiled fixtures, and
  `pnpm run typecheck` after every task. Run `pnpm run fmt:ts` on the
  TypeScript files you changed, by name.
- `lib/runtime/prompt.ts` is under a line limit and a
  lines-per-function limit that `pnpm run lint:structure` enforces. Put
  new logic in a helper in its own file.
- Do not hand-edit anything under `docs/site/`. Do not edit
  `CHANGELOG.md`.
- Never amend or force push. Write commit messages and the pull request
  description to a file.
- One commit per task. Open the pull request and stop.

## Tasks

### Task 1: the option, and its check before anything is pushed

Add the option everywhere an `llm()` option has to appear. `logprobs` is
a recent option that passes through the same lists; search for it
(`rg logprobs lib`) and follow it:

- `PromptConfig` in `lib/runtime/llmClient.ts`:

  ```ts
  /** A tool call the program chose for the first round. The tool loop
   *  runs it in place of the first model request. */
  firstToolCall?: FirstToolCall;
  ```

  with `export type FirstToolCall = { name: string; args: Record<string, unknown> };`
- `toSmolConfig` must not forward it to smoltalk.
- `LlmOpts` in `lib/runtime/agencyLlm.ts`.
- The option list in `lib/typeChecker/builtins.ts`: an object with a
  string `name` and an object `args`.
- `lib/runtime/prompt.ts`, where per-call options are read. This option
  is per call only. It must not be accepted by `setLlmOptions`, and it
  must not be inherited from a branch default: a default that made every
  call start with the same tool would be a trap. Add a test that
  `setLlmOptions({ firstToolCall: ... })` is refused by the type
  checker.

Check the option before the prompt is pushed, so a bad one changes
nothing. Each of these fails the call with an error, which Agency turns
into a failure for the calling function:

- `name` is not the name of a tool offered to this call: `firstToolCall
  names "<name>", which is not one of this call's tools.`
- The call is a decision call. A decision model cannot call tools, and
  `prepareDecision` already refuses a call with tools.
- The tool list is empty.

Do not check `args` here. The loop already resolves and checks a tool
call's arguments, and a bad argument produces a tool message the model
reads. For a chosen call that means the model is asked to continue,
which is the right fallback.

Put the check in a small function in a new file,
`lib/runtime/firstToolCall.ts`, and unit-test it there.

### Task 2: use it in the first request step

In the first request step, when `firstToolCall` is set, do not recall
memory facts and do not call `_runPrompt`. Build the same values that
step sets after a model reply:

- an assistant message holding one tool call, pushed onto the thread
  the way `_runPrompt` pushes the model's reply. Find how the loop
  builds an assistant message with tool calls and use the same
  constructor. The message has no text;
- `toolCalls` holding that one call, with a generated call id. Generate
  the id inside the step, with the id helper the runtime already uses.
  The step body runs once and its results are saved on the frame, so the
  id is stable across a resume. Do not derive it from a clock or a
  counter outside the step;
- `lastStopReason` as the value a model reply with tool calls has;
- `lastUsageKind` as `"completion"`;
- `self.messagesJSON` and `self.pendingToolCalls`, exactly as the step
  sets them today.

Write this as one function in `lib/runtime/firstToolCall.ts` that
returns those values, and have the step choose between it and the model
request. The step body should read as: "if the program chose the first
call, take it; otherwise ask the model".

Things to get right:

- **Nothing is metered and no request is counted.** No model was
  called. Check the cost, token, and retry accounting around
  `dispatchWithRetry` and make sure the chosen round adds zero. A cost
  guard must not trip on it.
- **The round counts as a round.** The chosen call is round 0 of the
  loop. Round limits and the round-cap warning behave as if the model
  had made the call.
- **Trip retry.** The first request step is wrapped so a guard trip can
  re-issue the request. With a chosen call there is no request to
  re-issue. Read `requestStepWithTripRetry` and make sure a re-entry
  does not push a second assistant message.
- **The tool list sent later.** The next request, if there is one,
  offers the same tools as it would after a model-made first round.

### Task 3: tests

Use an agency-js test, in a new folder under `tests/agency-js/`, with
the deterministic client so every model request is counted. See
`docs/misc/TESTING.md`, and `tests/agency-js/decision-model` for a test
that records what the runtime sent. Each case below is one small Agency
function plus assertions on its result, the thread, and the number of
model requests.

1. **An ordinary tool.** `llm(prompt, { tools: [add], firstToolCall: {
   name: "add", args: { a: 1, b: 2 } } })`. The tool runs once with
   those arguments. Exactly one model request follows, and its messages
   are: the prompt, an assistant message with the tool call, the tool
   result.
2. **A tool that ends the turn.** The tool calls `endTurn()`. `llm()`
   returns the tool's value and there are zero model requests.
3. **A handoff.** The chosen tool is a `handoff def` whose body pushes a
   system message and makes one `llm()` call. After the call returns,
   the caller's thread holds the body's messages, does not hold the
   system message, does not hold the dropped tool call, and ends with
   the hand-back message. Compare with the same handoff called by the
   model in a second run: the two threads must be equal apart from call
   ids.
4. **A handoff that ends the turn.** As case 3, with `endTurn()` in the
   body: zero model requests on the caller's `llm()` call.
5. **A handler is consulted.** The chosen tool raises an interrupt.
   Wrap the `llm()` call in `handle { ... } with (intr) { return
   reject() }`. The tool does not complete, and the model's next request
   carries the rejection message an ordinary rejected call carries.
   Then the same with `approve()`: the tool completes. This case exists
   to prove no handler is skipped.
6. **An interrupt with no handler, and a resume.** The chosen tool
   raises an interrupt nobody handles. The run returns the interrupt
   with a checkpoint. Resume with an approval. The tool body runs to
   completion once, the thread holds one assistant message with the
   tool call, not two, and no model request was made for the first
   round on either pass.
7. **A name that is not offered** fails, and the thread is unchanged:
   the prompt was not pushed.
8. **A bad argument.** The chosen call's arguments fail the tool's
   parameter check. The model's next request carries the argument
   error, as it would for a model-made call.
9. **Cost.** With a cost guard of zero dollars around case 2, the guard
   does not trip.

Before writing case 6, ask what would make it fail. If the assertions
would pass with the step's body re-running on resume, they are not
testing the resume.

### Task 4: the logs

A reader of a trace must be able to tell that no model chose this call.
Read "Event catalog" in `docs/dev/hosting/statelog.md`. Prefer an
existing event with a field over a new event type. One option: the
`toolCallStart` event for this call carries `chosenBy: "program"`. If
you add a field, add it to the wire types and to the logs viewer's row
for that call, so the outline shows it. Do not emit `promptStart` or
`promptCompletion` for the chosen round; no prompt was sent.

Add one assertion to a Task 3 case that the event is in the log.

### Task 5: the dev doc

Write `docs/dev/runtime/first-tool-call.md`. Keep it to the mechanism
and the rules:

- what the option does, with the example;
- where the chosen call enters the loop, and that everything after that
  point is unchanged;
- interrupts and handlers: the call is not an approval, every handler is
  consulted, and a rejection reaches the model as for any call;
- resume: the step that takes the call is idempotent, and what is saved
  on the frame;
- what a checkpoint holds: the chosen call is in the saved messages and
  pending tool calls, the same place a model-made call is, so editing a
  checkpoint can change it to the same extent it can change any pending
  call;
- isolation: the tool runs on the thread a model-made call would run on;
- what is not metered;
- why the option is per call and not a branch default.

Add the doc to the index in `CLAUDE.md` under "Runtime", and to the
`agency-runtime-docs` skill, in the same words. Add a short "Starting
with a chosen call" section to `docs/dev/language/handoff-functions.md`
that points to it.

The user guide has pages on `llm()` under `docs/site/guide/`. Do not
edit them. List in the pull request description that the option needs a
guide entry from the owner.

## Before opening the pull request

- `pnpm run typecheck`, `pnpm run lint:structure`, and the new tests
  pass. Run the existing tool-loop tests the change could affect, at
  least `tests/agency-js/tool-rejection` and the handoff tests, and
  paste the summary lines into the description.
- Check the diff against `docs/dev/contributing/anti-patterns.md`.
- Read the whole diff once and remove anything a task did not ask for.
- The description answers, in plain sentences: what happens to
  handlers, what happens on resume, what a checkpoint holds, and what is
  metered.

