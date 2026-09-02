# Harness versus model: what each contributes, and where fixes belong

A harness is everything around the model: the tools it can call, the
prompts and reminders it sees, the loop that feeds tool results back, the
context management, the safety gates, and the way work escalates from
"just answer" to "dispatch a subagent". The model is the thing that
decides. This doc records how to divide credit and blame between the
two, where a fix should land when the agent misbehaves, and what a
harness genuinely cannot do.

It came out of a real comparison (September 2026). The same
architecture question — should the built-in agent split into its own
package? — was put to the agency agent's coordinator brain and to
Claude Code. The coordinator spent seven and a half minutes and $2.54
dispatching an explorer and then an oracle that re-did the explorer's
work, and only produced its (good) verdict after the user interrupted.
Claude Code read three files and answered in about a minute, with a
better-organized answer. The trace is pinned as the
`evals/agency-agent/packaging-decision` eval.

## The decomposition rule

**The harness sets transmission efficiency and the failure floor. The
model sets the insight ceiling.**

Transmission efficiency: what fraction of the model's capability
actually reaches the task. In the comparison above, the coordinator's
architecture taxed every step — the model forming the verdict could not
read a file itself, so three facts cost a full research survey, and the
oracle started from zero because subagents share no context. About 86%
of the spend went to a subagent whose findings the final answer never
used. None of that waste was the model being weak; all of it was the
harness losing capability in transmission.

Failure floor: how gracefully things degrade when a step goes wrong.
Five rounds of that trace died to a `grep` tool whose `flags` parameter
feeds a JavaScript `RegExp` constructor but reads like grep flags.
A harness with sanded tools does not lose those rounds.

Insight ceiling: the parts only the model contributes. In the same
comparison, Claude Code's answer killed a false choice in the user's
framing and surfaced a version-skew problem (two compiler versions on
one machine) that the coordinator's answer never found. No harness
change puts that argument into a model that cannot find it — and that
comparison ran a Mythos-class model against Sonnet, so the insight gap
was partly the model, not the harness.

To verify the split empirically, hold one side constant and vary the
other. The same harness on a weak and a strong model shows similar
mechanics and very different insight; the same model under two
harnesses (the comparison above, and mini-swe-agent's ~75% on SWE-bench
Verified in 100 lines of Python) shows the efficiency gap.

## Where a fix should land: the six tiers

When the agent misbehaves, the fix can land in six places. They are
ordered: prefer the earliest tier that can hold the fix, and migrate
existing fixes downward when a lower tier becomes able to hold them.
Prose is the weakest mechanism; use it only where mechanism cannot
reach.

**1. Make the mistake impossible (harness or compiler code).**
Claude Code's edit tool refuses to edit a file the model has not read
this session — nobody wrote "please read files before editing" and
hoped. Agency is unusually strong here because it owns a compiler: a
rule like "no mutation may drop a handler" can be a static check
instead of a runtime hope.

**2. Make the right thing automatic (harness code).** File reads
arrive with line numbers. Oversized tool results spill to a file with a
preview instead of flooding context. The model never has to remember
to do these, so it cannot forget.

**3. Just-in-time injected context.** The harness watches state and
injects a reminder when a condition becomes true. Contrast the
coordinator prompt's "use the `elapsedTime` tool frequently" — called
zero times in seven minutes — with a harness that injects "you have
been working five minutes and have sent the user nothing" when that
becomes true. Instructions-to-remember lose to state-triggered
injections, and the gap widens as sessions get longer.

**4. Scoped prose: tool descriptions and skills.** Claude Code's core
prompt is modest but its total guidance is large — attached to the
capability it governs, in context exactly when the model decides how to
use that capability. Git conventions live on the shell tool, not in the
global prompt. Docstrings-as-tool-descriptions already give Agency this
channel.

**5. The global system prompt.** Reserved for cross-cutting judgment
calibration: answer first, act when you can act, match effort to the
task. Everything that could migrate to tiers 1–4 should have.

**6. The model.** The slowest, deepest channel: failure patterns no
harness tier fixes cleanly become training signal. When a new model no
longer needs a tier-3/4 rule, delete the rule.

A worked audit: the coordinator prompt's "tell the user when you
consult the oracle" is tier 2 pretending to be tier 5 (announce
dispatches automatically). "Pass the oracle a self-contained question
with full context" exists only because cross-thread context is missing
— a tier-1/2 gap patched with prose. The oracle-frequency section is
per-task-class calibration written as a global rule; it was correct for
Terminal-Bench tasks and wrong for the conversational question above.

## What a harness cannot do

A harness can stop a weak model from wasting the capability it has —
that is worth a lot; the trace above wasted nearly all of its spend —
but it cannot raise the ceiling:

- It cannot manufacture insight. The version-skew argument, knowing
  which three facts an answer hinges on, spotting a false framing:
  these come from the model or not at all.
- Prescriptive scaffolding added to compensate for weak judgment
  ("always consult the oracle") encodes one task distribution's failure
  modes and misfires on every other distribution. It also rots: each
  model generation obsoletes the previous generation's crutches, which
  is why harnesses that tried to be smart get rewritten every few
  months.
- The ceiling claim has hard evidence: on fluid-intelligence
  benchmarks (ARC-AGI-3), frontier systems score under 2% where humans
  score 100%, under any harness.

The floor claim also has hard evidence: on Terminal-Bench 2.0,
optimizing only the harness, tools, and skills — same model — moved an
agent from 62.5% to 79.2% ("Do Agent Optimizers Compound?",
arxiv.org/abs/2607.14004). Both numbers are true at once. That is the
whole point of the decomposition: harness work is neither futile nor
sufficient, and knowing which side of the line a problem sits on tells
you whether to fix the harness or wait for (or switch) the model.

## Related

- `harness-guidelines.md` — the prescriptive companion: rules for
  writing a harness.
- `agent-brains.md` — the harness/brain split this vocabulary maps onto.
- `evals/agency-agent/packaging-decision/` — the pinned trace.
