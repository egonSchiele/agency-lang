# Asking the user: `question` and the `std::question` effect

An agent sometimes needs a fact nobody can look up — which of two accounts, which of two readings of a request, a value that only lives in the user's head. `question` from `std::agent` is how it asks.

```
export def question(prompt: string): string {
  let answer = interrupt std::question(prompt, { prompt: prompt })
  return answer
}
```

That is the whole implementation (`stdlib/agent.agency:66`). There is no terminal read in it. The effect is declared at `stdlib/agent.agency:19` as `effect std::question { prompt: string }`.

## Why an interrupt and not `input`

`input` (`stdlib/index.agency:143`) blocks on the terminal, so it only works for a program a person is sitting in front of. An interrupt goes through the handler chain instead, which means the same `question` call works in an `agency agent` REPL, in a hosted run that surfaces the interrupt over HTTP, and inside a test that answers it with `approve("...")` and never touches a terminal. It also means a program embedding an agent can answer its questions in code rather than forwarding them to a person.

## A question is a raise that expects a value

`question` uses the assignment form, `let answer = interrupt ...`, so the runtime marks the interrupt `expectsValue: true` (`lib/runtime/interrupts.ts:606`). That one flag changes how everything downstream treats it, and the reasoning is worth knowing before you touch any of it:

**No policy rule can answer it.** `approve()` from a rule carries no value, so a rule that "approved" a question would hand the call site an empty string — and the call site would take that for the user's answer. `_handler` refuses (`stdlib/policy.agency:1176`), and the approval menu withholds the "always" answers for the same reason (`askUserChoices`, `policy.agency:936`). So `--policy approve-all` cannot answer a question on the user's behalf. Only a person can.

**Typed text is the answer, not a rejection reason.** At the prompt, text the user types is normally the reason they are rejecting something. For a question it is the answer instead (`typedValue`, `policy.agency:1123`), and the footer says "or type your answer" rather than "or type a reason" (`lib/stdlib/cli.ts:601`).

**A run with nobody at a terminal rejects it with an explanation.** `agency agent -p` has no one to ask, so the question comes back as a failure whose message is written for the model to read: take an approach that does not need an answer, or re-run interactively (`policy.agency:1188-1196`). The model reads that in the tool result and can carry on rather than the process hanging. `agency run --interactive` reaches the same outcome by a different path (`lib/runtime/interruptResolution.ts:87`).

## Which agents have it

Most get it from `communicationTools()` (`stdlib/agents/lib/toolkits.agency:99`), the bundle that also carries `whatIAmDoing`: coding, explorer, planner, researcher, review, data, verifier, typescript/review and writing/review all claim that bundle, so all of them can ask.

Three do not claim it, and their callers hand them `question` explicitly instead: `oracleAgent`, `agencyReviewAgent`, and the expert and Agency coding agents. Those call sites are in `lib/agents/agency-agent/brains/coordinator/subagents/`.

**This split is the thing to be careful about.** Adding `communicationTools()` to one of those three without dropping the call-site copy sends two tools named `question` in one request, and `assertUniqueToolNames` (`lib/runtime/prompt.ts`) rejects it before it goes out. `composedOracleToolsHaveUniqueNames` and `composedAgencyReviewToolsHaveUniqueNames` in `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency` ping the composed list for exactly this.

The coordinator asks directly rather than through a subagent, so `question` is in `turnTools()` (`brains/coordinator/coordinator.agency`) beside `whatIAmDoing`.

## The prompt matters as much as the wiring

For a long time every subagent had `question` and none of them used it, because no system prompt mentioned it. A tool a model is handed but never told about is a tool it will not reach for. `ASK_USER_HINT` (`stdlib/agents/lib/toolkits.agency`) is the shared paragraph, spliced into each agent's prompt beside `SAVE_DRAFT_HINT`. It says three things: ask when only the user can tell you, ask before building on the guess, and when the question comes back rejected pick a reading, say which, and carry on.

Explorer's prompt needed a matching edit. It used to say "don't ask clarifying questions for broad asks", which reads as "never ask". It now distinguishes a broad scope, which the explorer should just cover, from a missing fact, which it should ask about.

## Tests

- `tests/agency/agent-question/` — the round trip with no LLM: an approval's value comes back from the call, the prompt reaches the handler, and a rejection's reason survives to the call site.
- `tests/agency/policy-ask-value-interrupt/` — the menu and `typedValue` behavior for a value-expecting raise.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency` — `subagentsOfferQuestion` and `coordinatorTurnOffersQuestion` check every list carries the tool; the composed pings check none carries it twice.
