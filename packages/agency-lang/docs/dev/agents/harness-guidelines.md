# Guidelines for writing a harness

Rules for building and changing the agency agent's harness, distilled
from comparing it against Claude Code on the same task and from the
2026 agent-optimization literature. The background and the evidence are
in `harness-and-model.md`; this doc is just the rules. "Harness" here
means everything around the model: tools, prompts, the loop, context
management, escalation.

## Must do

**Make the cheap path the default and every escalation a choice.**
The default answer path should be: think, maybe read a little, answer.
Subagents, oracles, and surveys are opt-ins the model (or a router)
picks per task — never the only way to touch the world. When the
maximal structure is the only path, every simple question pays the
maximal tax.

**Keep the thinking model and the reading model the same, unless the
work is genuinely parallel or bulk.** Every handoff between contexts
loses information (a paraphrased brief is not the transcript) and
buys latency. Dispatch pays for itself on parallel fan-outs and on
work whose output would drown the caller's context — not on "look
three facts up".

**Sand the tools until the model's first attempt usually works.** A
failed tool round costs latency, money, and context pollution. Accept
what a model will plausibly pass (or fail with a message that names
the valid inputs), return results in the form the next step needs
(line numbers, previews), and treat every tool-error event in the
statelogs as a papercut list. The comparison trace lost five rounds to
one badly-described `flags` parameter.

**Put guidance in the lowest tier that can hold it.** The six tiers,
in order of preference: make the mistake impossible (code, or the
compiler); make the right thing automatic; inject state-triggered
reminders; attach prose to the tool or skill it governs; the global
prompt; the model. Audit every prompt rule by asking which tier it
should actually live in. Most prompt bloat is a tier-1-to-3 gap
patched with prose.

**Inject state, don't ask the model to poll it.** "Use the elapsed-time
tool frequently" was called zero times in seven minutes. A reminder the
harness injects when a threshold trips fires every time.

**Keep the global prompt for judgment calibration only.** Answer the
question first; act when you can act; match effort to the task. These
degrade gracefully across task types. Workflow prescriptions do not.

**Charge for everything in the evals.** Score cost, latency, and rounds
alongside correctness (the economy graders in
`evals/agency-agent/packaging-decision/`). A harness whose evals only
score outcomes will grow oracle-everywhere habits, because a second
opinion is free when nobody is counting.

**Mine every bad session into an eval before fixing it.** The suite
converges on the real usage distribution instead of a guessed one, and
the fix cannot silently regress later. Fix nothing you have not pinned.

**Record why every rule exists.** Attach to each prompt rule, guard,
and workflow prescription the failure it was added for (the eval case,
the trace, the benchmark). Scaffolding without provenance can never be
safely deleted; scaffolding with provenance gets retested against each
new model and removed when the model no longer needs it.

**Show the work while it happens.** A user watching tool calls stream
by catches misdirected research at thirty seconds, not seven minutes.
Visibility is a steering channel, and it is the harness's job, not a
courtesy the prompt asks the model to remember.

## Must not

**Don't prescribe pipelines in the global prompt.** "Use the oracle
FREQUENTLY" was correct for Terminal-Bench and wrong for a
conversational question, because a prescriptive rule encodes one task
distribution's failure modes as universal law. Per-task-class behavior
belongs in per-task-class configuration (a router, a brain, a policy)
— not in global prose.

**Don't let one benchmark write global rules.** When a benchmark keeps
exposing a failure, the pressure is to add emphasis until the failure
stops. Pin the other behaviors as evals first, so the emphasis has
something to push back against. Optimizing against a single suite
demonstrably trades away general behavior for suite-specific shortcuts
— this is true of human tuners, not just optimizers.

**Don't add coordination you cannot pay for.** Multi-agent structure
costs roughly an order of magnitude more tokens and a context handoff
at every boundary; measured against optimized single agents it usually
loses. Add a subagent when the work is parallel or its output is bulk,
and make the case in the PR — never as the default shape of the system.

**Don't compensate for weak model judgment with more prescription.**
It caps the strong model that comes next, and it rots — each model
generation obsoletes the previous one's crutches. If the model's
judgment is the problem, the durable fixes are a better model, routing
to a stronger configuration, or a tier-1/2 mechanism that removes the
judgment call entirely.

**Don't let a rule outlive its reason.** When a new model ships, rerun
the suite with candidate rules removed. A rule that no longer moves any
eval is scaffolding the next refactor should delete.

**Don't hide safety in prose.** Anything that must never happen —
a handler skipped, an approval widened — belongs in tier 1: enforced
by the harness or the compiler, never requested of the model. This
repo's handlers-are-safety-infrastructure rule is the standing example.
