# Routing-Stickiness for Multi-Thread Agents

## The Problem

When an agent splits a conversation across per-category subagents (e.g. the
agency-agent's `code` / `research` split — see
`docs/superpowers/plans/2026-05-29-agency-agent-multi-thread.md`), every new
user message has to be routed to one of the subagents. A naïve `categorize()`
LLM call routes message-by-message in isolation, which produces a bad UX:

1. User starts a coding session — routed to `code` ✓
2. User's third message is ambiguous ("can you make it faster?") — categorize
   returns `research` ✗
3. The `research` subagent has none of the conversation context. It tries to
   answer cold.
4. User is confused: "why did the agent forget what we were doing?"

The cost-asymmetry matters. A **false-stay** (we should have switched but
didn't) is recoverable — the agent answers slightly off-topic, the user
re-prompts. A **false-switch** is catastrophic — the new agent looks dumb,
the user loses trust. So the design rule is: **strongly bias toward
stay; only switch on high-confidence evidence of a category change**.

This document collects all the routing-stickiness techniques we brainstormed.
The v1 implementation in `lib/agents/agency-agent/` uses just one of them
(let-the-current-agent-decide via `handoff()`), but the rest are worth trying
in follow-ups to see which combination produces the best behavior.

## The Techniques

### 1. Sticky-default categorizer

Save the previous category on the run. The categorizer prompt says: *"If
you're not sure, return the previous category as the default."* The LLM is
explicitly told to bias toward stay.

- **Cost:** zero extra LLM calls.
- **Implementation effort:** trivial — one extra field in the categorize
  prompt + one local variable.
- **Failure mode:** the LLM might ignore the "if unsure" instruction.
  Models vary in how literally they take soft hints in prompts.

### 2. Probability-distribution categorizer

Don't ask for a single category. Ask for a probability for each category.
If the top category's probability is above a threshold (say 0.7), switch;
otherwise stay. The threshold encodes the bias-toward-stay tunably.

- **Cost:** same number of LLM calls; slightly longer prompt.
- **Implementation effort:** small — change `Category` return type to
  `Record<Category, number>`, add threshold logic.
- **Failure mode:** LLM-reported probabilities are notoriously
  uncalibrated. A 0.9 from one model is not the same as 0.9 from
  another. May need empirical tuning per model.

### 3. Forked probability averaging

Same as #2, but `fork` the same prompt N times (N=3 or 5) at temperature > 0
and average the per-category probabilities. Reduces single-sample noise.

- **Cost:** N× LLM calls per turn — significant.
- **Implementation effort:** small — Agency already has `fork`/`race`
  primitives.
- **Failure mode:** N× cost for marginal accuracy gain in most cases.
  Probably only worth it for ambiguous/borderline messages — could
  combine with #2 (only fork when single-shot probability is in the
  uncertain range).

### 4. Parallel speculative execution

When a new user message comes in, in parallel:
- Send it to the *current* category's agent (speculatively assume stay).
- Send it to the categorizer.

When both return, check categorizer confidence + whether the current agent's
reply looks like it answered the message well (a third LLM call could
self-rate the answer). Decide post-hoc: keep the speculative answer, or
discard it and route to the new category.

- **Cost:** at least 2× LLM calls per turn (categorizer + speculative
  agent); 3× if we add a self-rate. But latency is `max`, not `sum`,
  since they run in parallel.
- **Implementation effort:** moderate — coordinate two threads, decide
  which to commit, drop the loser's thread or rewind it.
- **Failure mode:** discarding the speculative answer wastes
  significant compute. Mitigated by only speculating when prior turn
  was confidently in the same category.

### 5. Two-stage continuation classifier

First ask a binary question: *"Is this message a continuation of the
previous topic? yes/no."* Only on `no` do we ask the full categorizer.
The binary question is much cheaper (smaller prompt, possibly a smaller
model) and the LLM has a clearer task.

- **Cost:** one extra cheap call on the common (stay) case; one extra
  cheap call + the categorize call on the switch case. Net: cheaper than
  always-categorize if stay >> switch (which is the whole premise).
- **Implementation effort:** small — one new helper def.
- **Failure mode:** "continuation" is itself ambiguous for ambiguous
  messages. Pushes the same problem one level down.

### 6. Let the current agent decide (handoff tool)

Don't categorize on every turn. The current category's LLM gets the user
message with a single tool: `handoff(category: Category, reason: string)`.
If the agent thinks it can handle the message, it just answers. If clearly
out of scope, it calls `handoff()` and the runtime closes the current
thread + reroutes to the chosen category.

- **Cost:** zero extra LLM calls on the common case (the answering call
  *is* the routing decision). One extra call only on switch.
- **Implementation effort:** small — register `handoff` as a tool;
  detect tool-call result in the runtime loop and reroute. No
  categorizer at all.
- **Failure mode:** the agent has to *remember* the handoff tool is
  there and use it appropriately. Depends on prompt quality. Models
  prone to "I'll try my best" might rarely hand off.
- **Why this is the v1 pick:** it's the simplest end-to-end design.
  Categorization is implicit in the existing answering call. The agent
  that knows the conversation context is the one that decides.

### 7. Embedding similarity to recent context

Embed the new message. Embed the last N messages of the current thread.
Compute cosine similarity. If high (above threshold), stay without any
categorizer call. If low, fall back to a categorizer.

- **Cost:** two embedding calls per turn (cheap — embeddings are
  ~free compared to chat completions). Categorizer only on misses.
- **Implementation effort:** moderate — needs an embedding client
  + threshold tuning + integration with the routing loop.
- **Failure mode:** semantic similarity ≠ category similarity. A
  message can be on-topic but use very different vocabulary, or
  off-topic but use the same vocabulary ("write me a haiku about
  Python" looks similar to a coding session).

### 8. Hysteresis / sticky counter

Only switch categories if the categorizer returns the same non-current
category for K turns in a row (K=2 or 3). A single ambiguous
categorization never causes a switch.

- **Cost:** zero extra LLM calls.
- **Implementation effort:** trivial — a counter on the run state.
- **Failure mode:** introduces lag — a genuine category switch takes
  K turns to actually happen. Bad UX if K is too large.

### 9. Context-aware categorizer

Pass the last N messages of the current category to the categorizer
along with the new message. The categorizer sees "we've been talking
about React for 5 turns" and naturally biases toward `code` for
ambiguous follow-ups. No threshold tuning needed.

- **Cost:** same number of LLM calls; longer prompt = more input
  tokens.
- **Implementation effort:** small — pass extra context into the
  categorize prompt.
- **Failure mode:** very long contexts can confuse smaller models;
  may need summarization for long threads.

### 10. Short-message bypass

Heuristic: messages under ~5 words or pure acknowledgments ("yes",
"more", "fix it", "go on", "what about errors?") always stay in the
current category. No categorizer call.

- **Cost:** zero LLM calls for bypassed messages.
- **Implementation effort:** trivial — string-length check + a stop
  list of common acknowledgments.
- **Failure mode:** rare edge cases ("stop" might genuinely be a
  reset). Easy to widen the stop list as patterns emerge.

### 11. Few-shot in-session calibration

The categorizer prompt includes the last K `(message, category)` pairs
from this run. The LLM learns "this user's 'fix it' messages have all
been `code` in this session". Per-session calibration without
fine-tuning.

- **Cost:** same number of LLM calls; longer prompt.
- **Implementation effort:** small — record recent decisions, splice
  into the prompt.
- **Failure mode:** early in a session, K examples don't exist yet.
  Falls back to standard categorization.

## Auto-Context-Injection on Switch

Even *correct* routing yields a context-less new agent. If the user
genuinely switches from `code` to `research` mid-conversation, the
`research` agent starts cold. The user can manually invoke
`getThread`/`listThreads` to give it context, but that's extra friction.

**The technique:** on first entry to a new category mid-run, automatically
inject a one-line summary of the immediately-prior conversation. The new
agent's first system message becomes something like:

> *"The user was previously in the `code` thread working on
> `/tmp/server.py`. Their new message routes here for research."*

We already have the eager-summarize machinery (`stdlib/threads.agency`).
The auto-injection is a small wrapper: when routing produces a switch,
read the previous thread's cached summary, prepend it as context to the
new thread's system message.

- **Cost:** zero extra LLM calls (summary is already eagerly cached).
- **Implementation effort:** small — one helper in the agent's REPL
  loop.
- **Failure mode:** summary may not be the *right* context. Better
  than nothing.

**Why this matters separately:** none of the routing techniques above
can be 100% accurate. Even with perfect routing, the new agent still
needs context. Auto-injection decouples routing accuracy from the
context-loss penalty: a misroute becomes "agent answers from one
sentence of summarized context" instead of "agent has nothing".

## Recommended Stack

For a future "best-effort" implementation that combines the cheap and
clever techniques:

- **#10 (short-message bypass)** as a free pre-filter — catches the
  acknowledgment-continuation failure mode at zero cost.
- **#8 (hysteresis, K=2)** — kills single-glitch misroutes for free.
- **#7 (embedding similarity)** as the everyday gate — most turns
  never even hit the categorizer.
- **#9 (context-aware categorizer)** as the fallback when the cheap
  filters say "uncertain".
- **Auto-context-injection** on confirmed switches so misroutes are
  recoverable.

The v1 implementation picks #6 alone because it's the simplest
end-to-end design and exercises the full thread-switching machinery
without any of the surrounding scaffolding.

## Open Questions for Empirical Work

- Which technique (or stack) produces the highest user-perceived
  conversation continuity? We need a test harness: a corpus of
  multi-turn conversations with ground-truth category labels per
  turn, scored on (a) correct routing rate and (b) catastrophic
  misroute rate (the "agent lost context" failure mode).
- Are the cost/quality trade-offs model-dependent? A bigger model
  might handle #6 (handoff tool) so well that the extra cheap
  filters don't help.
- Does #11 (in-session calibration) actually learn from K=3 or K=5
  examples, or does it need K=20+?
- For #2 (probability distribution), what's the right threshold? Is
  there a single answer or does it depend on the category set size?
