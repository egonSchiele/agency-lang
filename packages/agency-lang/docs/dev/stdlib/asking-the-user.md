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

`input` (`stdlib/index.agency:143`) blocks on the terminal, so it only works for a program a person is sitting in front of. An interrupt goes through the handler chain instead, so the same `question` call works in an `agency agent` REPL, in a hosted run that surfaces the interrupt over HTTP and takes the answer at `/resume`, and inside a test that answers with `approve("...")` and never touches a terminal. It also means a program embedding an agent can answer its questions in code rather than forwarding them to a person.

## A question is a raise that expects a value

`question` uses the assignment form, `let answer = interrupt ...`, so the runtime marks the interrupt `expectsValue: true` (`lib/runtime/interrupts.ts:606`). That one flag changes how everything downstream treats it.

**No policy rule can answer it.** `approve()` from a rule carries no value, so a rule that "approved" a question would hand the call site an empty string — and the call site would take that for the user's answer. `_handler` refuses (`stdlib/policy.agency:1176`), and the approval menu withholds the "always" answers for the same reason (`askUserChoices`, `policy.agency:936`). Anyone who can supply a value still can: a person at the prompt, a host answering over HTTP, a handler in a test. What cannot answer is a rule, so `--policy approve-all` does not silently answer questions.

**Typed text is the answer, not a rejection reason.** At the prompt, text the user types is normally the reason they are rejecting something. For a question it is the answer instead (`typedValue`, `policy.agency:1123`), and the footer says "or type your answer" rather than "or type a reason" (`lib/stdlib/cli.ts:601`).

**A run with no one to ask rejects it with an explanation.** Under the CLI policy handler, `agency agent -p` has nobody to ask, so the question comes back as a failure whose message is written for the model to read: take an approach that does not need an answer, or re-run interactively (`policy.agency:1188-1196`). The model reads that in the tool result and can carry on rather than the process hanging. `agency run --interactive` reaches the same outcome by a different path (`lib/runtime/interruptResolution.ts:87`). A hosted agent is not in this case — it has no terminal, but it does have a host that can answer.

## Which agents have it, and the split to be careful about

Most get it from `communicationTools()` (`stdlib/agents/lib/toolkits.agency`), the bundle that also carries `whatIAmDoing`: coding, explorer, planner, researcher, review, data, verifier, typescript/review and writing/review all claim that bundle.

Five agents do not claim it, and their callers hand them `question` at the call site instead. All five call sites are in `lib/agents/agency-agent/brains/coordinator/subagents/`:

| agent | call site |
|---|---|
| `oracleAgent` | `oracle.agency` |
| `agencyReviewAgent` | `review.agency` |
| `agencyResearcherAgent` | `research.agency`, as `extraTools: [...researchTools, question]` |
| `expertAgent` and `agencyExpertAgent` | `code.agency`, in `consultExpert` |
| `agencyCodingAgent` | `code.agency`, in the Agency branch of `solve` |

**Adding `communicationTools()` to any of those five means dropping its call-site copy in the same change.** Two tools named `question` in one request are rejected by `assertUniqueToolNames` (`lib/runtime/prompt.ts`) before it is sent, so the dispatch fails outright. `composedOracleToolsHaveUniqueNames`, `composedAgencyReviewToolsHaveUniqueNames` and `composedAgencyResearchToolsHaveUniqueNames` in `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency` ping the composed lists for exactly this.

The coordinator asks directly rather than through a subagent, so `question` is in `turnTools()` (`brains/coordinator/coordinator.agency`) beside `whatIAmDoing`.

## Wiring the tool is not enough; the prompt has to name it

Every subagent carried `question` and none of them used it, because no system prompt mentioned it. A tool a model is handed but never told about is a tool it will not reach for.

`ASK_USER_HINT` (`stdlib/agents/lib/toolkits.agency`) is the shared paragraph, spliced into each agent's prompt beside `SAVE_DRAFT_HINT`. It says three things: ask when only the user can tell you, ask before building on the guess, and when the question comes back rejected pick a reading, say which, and carry on.

Two things to watch when adding it to another agent's prompt. First, the hint says "when nobody can answer", not "when nobody is at a terminal" — a hosted agent has no terminal and can still be answered. Second, check the prompt for an existing instruction not to ask. Explorer and researcher both had one, and a flat prohibition is the more categorical of the two rules, so the tool stays unused unless the old line is narrowed.

## Tests

- `tests/agency/agent-question/` — the round trip with no LLM: an approval's value comes back from the call, the prompt reaches the handler, and a rejection's reason survives to the call site.
- `tests/agency/policy-ask-value-interrupt/` — the menu and `typedValue` behavior for a value-expecting raise.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency` — `subagentsOfferQuestion` and `coordinatorTurnOffersQuestion` check every list carries the tool; the composed pings check none carries it twice.
