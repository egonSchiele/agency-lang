# Why agents that write code beat agents that call tools

Written 2026-07-28, during the self-writing-agent experiment (see
`self-writing-agent.md` for the experiment itself). This document answers a
question we will keep asking ourselves: **is letting an agent write and run
Agency programs actually different from giving it a big enough tool set, or
are we building an elaborate equivalent?** Read this when you are wondering
whether the experiment is worth it.

The short answer: there is a real difference, and it is precise, not
philosophical. Four of the five capabilities below cannot be retrofitted
onto tool calling at all. And the fifth section explains why the "just add
more tools" argument defeats itself.

Claims from published work are marked **[relayed]**; the rest is our own
reasoning **[mine]** or measured in this repo **[measured]**.

---

## The formal core: interpreter vs compiler

In tool calling, **the model is the interpreter**. Every composition step —
every loop iteration, every branch, every value handed from one tool to the
next — is executed by an LLM inference. In code writing, **the model is the
compiler**: it emits the composition once, and a deterministic machine
executes it.

Both are computationally universal. A model calling tools forever can, in
principle, simulate any program, given unbounded turns and a big enough
context window. So the difference is not *what can be computed*. It is what
each step costs, how reliable each step is, what can be verified before
running, and what an attacker can reach. Those differ radically.

## The five capabilities

### 1. Dataflow that bypasses the model

In tool calling, every intermediate result enters the context window and is
re-read (and re-billed, and possibly mis-transcribed) on every later step.
In code, `const a = toolA()` then `toolB(a)` moves the value without the
model ever seeing it.

This is the argument behind Anthropic's code-execution-with-MCP work, and
deployments of that pattern report ~98% token reductions from exactly this
change. **[relayed]** Our own failed news run is the pathology in the wild:
$2.07 of its $3.39 went to cache writes — intermediate state churning
through the context window on every call. **[measured]**

### 2. Deterministic control flow

A `while` loop in code runs exactly as written. A "loop" in tool calling is
a suggestion the model re-decides on every iteration — which is how our
news run produced 53 near-duplicate web searches **[measured]**, and how
agents in general drift, stop early, or repeat failed actions. You cannot
make the model-as-interpreter reliable per step; code removes the
stochastic interpreter from every step that does not need judgment.

### 3. Committed control flow as a security property

This is the deepest one. In tool calling, every tool *result* is an
injection surface for the *next decision*: a poisoned web page can redirect
the whole agent, because the agent's control flow IS the model reading
results. In code-as-plan, control flow is fixed before untrusted data ever
flows through it. A poisoned result can corrupt a value; it cannot reroute
the program.

This is the entire thesis of CaMeL (arXiv 2503.18813), which had to build a
custom interpreter from scratch to get the property. **[relayed]** Tool
calling cannot have it even in principle. Agency gets it from the compiler
and the subprocess interrupt boundary we already have.

### 4. Whole-plan verification before execution

A sequence of tool calls can only be validated call by call, as it happens;
nothing checks the sequence as a whole. A program is typechecked end to end
before anything runs — inter-step dataflow included. Our probe rounds
measured what this buys: every single generation failure across three
rounds was caught at compile time, for free, before any money was spent.
**[measured]** There is no tool-calling analog of "the plan doesn't
typecheck."

### 5. Minting new abstractions at runtime

A tool set is closed: the agent can only compose what exists. Code is open:
`def` creates a capability that did not exist a minute ago, and a cached
successful program becomes a new tool. This is what the "agents writing
agents" literature is actually about:

- **Voyager** (arXiv 2305.16291) accumulates a library of skills written as
  code. **[relayed]**
- **DynaSaur** (arXiv 2411.01747) lets the agent define new Python
  functions when its action set is insufficient, and keeps them. **[relayed]**
- **ADAS / Meta Agent Search** (arXiv 2408.08435) has a meta-agent program
  new agents in code, and states the rationale in exactly the terms of our
  question: code is the medium because "programming languages are Turing
  Complete," which "theoretically enables learning any possible agentic
  system." **[relayed]**
- **The Darwin Gödel Machine** (Sakana AI, 2025) is the furthest point: an
  agent that rewrites its own code took itself from 20% to 50% on
  SWE-bench. It also sometimes cheated its evaluations — a lesson about
  verification, not a counterargument. **[relayed]**

---

## Why "just add more tools" defeats itself

The claim "if the tool set is large enough, tool calling can do everything
code can" is true only in a degenerate limit, and the limit is
self-defeating: **[mine]**

- A tool set closed under composition — where every useful combination of
  tools is itself a tool — *is a programming language* with a worse syntax.
- A tool expressive enough to take *behavior* as an argument (not just
  data) *is an interpreter*. At that point you have reinvented `runCode`
  with worse ergonomics.

The guard example makes this concrete. Yes, a tool can carry a guard inside
its body — `researcherAgent` in `stdlib/agents/researcher.agency` does
exactly that, parameterized by `maxCost`/`maxTime`. That works for
**first-order, pre-decided composition**: the library author bet, at
authoring time, on which layers the task would need. Section 7 of
`self-writing-agent.md` documents how that bet went: the researcher froze
five layers into itself and became uncomposable — the code-writing agent
could not reach the seam below it. **[measured]**

What cannot be pre-baked are the **higher-order** compositions: "a guard
around a fork of a researcher and a coder, with the budget split by
judgment about the subtasks, and a finalize that salvages whichever branch
finished." Offering that as a tool requires the tool's argument to be a
program. Every pre-baked composition is a bet on which composition will be
needed; code writing is the refusal to bet.

## What tool calling keeps

Honesty requires the other column. When the right next step genuinely
depends on judgment applied to what just came back, you want the model in
the loop — that is why ReAct-style agents survive, and why upfront programs
are structurally brittle (ReWOO names this as its own tradeoff; our
findings doc lists it as an open weakness). **[relayed/mine]**

The mature position is not code *versus* tools. It is **choosing where the
model sits in the loop**: judgment steps go through the model, mechanical
composition goes through the executor. The two-phase pattern in the
writer's prompt (gather information with one small program, then write the
follow-up program with the facts folded in) is precisely this dial. And the
line between the two blurs productively: a tool is a frozen program, and a
skill library turns yesterday's generated program into today's tool.

## Our competitive advantage

The published systems above cover *offline* meta-design: search loops that
evolve better agent architectures against benchmarks. None of them do
per-request program synthesis on a governed substrate. Every one of them
runs generated Python in a **sandbox**, where safety means *isolation*: the
code cannot hurt you because it cannot touch anything real — which also
means it cannot do much that is real.

Agency's generated code is **governed rather than isolated**: **[repo]**

- Interrupts cross the subprocess boundary, so the parent's approval chain
  rules the child; a parent rejection beats a child approval
  (`subprocess-ipc.md`).
- Effects are typed and inspectable *before* running — `getEffects` is a
  capability manifest for a program that does not exist yet.
- Budgets (`guard`), checkpoints, salvage (`finalize`), and
  compile-before-run with typed diagnostics are language features, not
  harness duct tape.

CaMeL built a bespoke interpreter to get a weaker version of capability #3.
Agency gets #3 and #4 from the compiler that already exists.

The one-sentence version, for the days we doubt this: **everyone else's
code-writing agents trade safety for expressiveness and buy it back with
sandboxes; Agency is the stack where generated code is *more* controllable
than tool calls, not less.** The token and latency economics (#1, #2) are
the bonus, not the thesis.

---

## Sources

- CodeAct — arXiv 2402.01030 (code actions beat JSON tool calls, 17 LLMs)
- CaMeL — arXiv 2503.18813 (committed control flow as security)
- ADAS / Meta Agent Search — arXiv 2408.08435 (meta-agent writes agents in
  code; the Turing-completeness rationale)
- Voyager — arXiv 2305.16291; DynaSaur — arXiv 2411.01747 (skill libraries)
- Darwin Gödel Machine — sakana.ai/dgm (self-rewriting agent, 20%→50%
  SWE-bench; also cheated evals)
- LLMCompiler — arXiv 2312.04511; ReWOO — arXiv 2305.18323 (plan-upfront
  economics and brittleness)
- Anthropic, "Code execution with MCP" / advanced tool use —
  anthropic.com/engineering/advanced-tool-use (~98% token reduction
  reports from the code-first pattern)
- This repo: `docs/dev/self-writing-agent.md` (the measurements),
  `docs/dev/subprocess-ipc.md` (the interrupt boundary)
