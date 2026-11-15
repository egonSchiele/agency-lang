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

**No policy rule can answer it.** `approve()` from a rule carries no value, so a rule that "approved" a question would hand the call site an empty string — and the call site would take that for the user's answer. `_handler` refuses (`stdlib/policy.agency:1176`), and the approval menu withholds the "always" answers for the same reason (`askUserChoices`, `policy.agency:936`). Anyone who can supply a value still can: a person at the prompt, a host answering over HTTP, a handler in a test. What cannot answer is a rule, so `--policy approve-all` does not silently answer questions. Outside `agency agent`, `agency run --policy` and `--approve`, a serve host's policy, and `agency remote call` leave a question to the prompt under `--interactive`; in a non-interactive run an approve rule answers it with null, since the rule said yes and nobody is present to say more (`makeRunPolicyHandler` and `buildDecider`, described in `docs/dev/agents/approval-policies.md`).

**Typed text is the answer, not a rejection reason.** At the prompt, text the user types is normally the reason they are rejecting something. For a question it is the answer instead (`typedValue`, `policy.agency:1123`), and the footer says "or type your answer" rather than "or type a reason" (`lib/stdlib/cli.ts:601`).

**A run with no one to ask rejects it with an explanation.** Under the CLI policy handler, `agency agent -p` has nobody to ask, so the question comes back as a failure whose message is written for the model to read: take an approach that does not need an answer, or re-run interactively (`policy.agency:1188-1196`). The model reads that in the tool result and can carry on rather than the process hanging. `agency run --interactive` reaches the same outcome by a different path (`lib/runtime/interruptResolution.ts:87`). A hosted agent is not in this case — it has no terminal, but it does have a host that can answer.

## Which agents offer it

No stdlib agent offers `question`, and neither does the coordinator in `agency agent`. Models rarely called it, and an agent that needs something from the user can say so in its reply. A program that wants an agent to ask can still add `question` to that agent's `extraTools`.

`designTool`'s author is the one place in the stdlib that asks. It offers `askAndRecord` under the name `question`, so the answers are recorded for the reviewer, and its brief tells it to ask (`authorTools` and `ASK_RULE` in `stdlib/toolbox.agency`). It offers the tool in every run. In `agency agent -p`, the policy handler rejects the question with the message described above, and the author carries on.

## Tests

- `tests/agency/agent-question/` — the round trip with no LLM: an approval's value comes back from the call, the prompt reaches the handler, and a rejection's reason survives to the call site.
- `tests/agency/policy-ask-value-interrupt/` — the menu and `typedValue` behavior for a value-expecting raise.
- `tests/agency/agents/toolkits.agency` — `noAgentOffersQuestion` checks the ten stdlib agents that used to offer the tool.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency` — `subagentsOfferNoQuestion` and `coordinatorTurnOffersNoQuestion` check the coordinator's lists.
- `tests/agency/toolbox/brief.agency` — `authorAlwaysOffersQuestion` checks `designTool`'s author.
