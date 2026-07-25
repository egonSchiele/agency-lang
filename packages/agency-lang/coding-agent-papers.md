# Coding-Agent Research: Most-Cited Recent Papers (2023–2026)

> Compiled via deep-research (fan-out web search → source fetch → adversarial verification → synthesis).
> Citation counts were **not** independently retrieved — "influence" is inferred from venue prestige
> (ICLR/NeurIPS/FSE/ISSTA), primary-source prominence, and how frequently each work anchors the literature.
> Headline accuracy/cost numbers are self-reported historical SOTA markers, not current standings.

---

## Part 1 — Building coding agents (accuracy, context, memory, efficiency)

### Foundational benchmark (accuracy / correctness)

**SWE-bench: Can Language Models Resolve Real-World GitHub Issues?**
Jimenez, Yang, Wettig et al. (Princeton) — ICLR 2024 (oral) — https://arxiv.org/abs/2310.06770
The field's dominant accuracy benchmark: 2,294 real tasks from GitHub issues + merged PRs across 12
Python repos. Best model at launch (Claude 2) resolved only **1.96%**. The paper itself foregrounds
**long-context management** as a core difficulty. *Areas: accuracy, long-context.*

**SWE-bench Verified**
OpenAI with the original authors — 2024 — https://openai.com/index/introducing-swe-bench-verified/
A 500-sample human-validated subset that supersedes original SWE-bench and SWE-bench Lite. GPT-4o
(with the Agentless scaffold) hit **33.2%**. Became the de-facto industry accuracy standard for ~2 years.
*Areas: accuracy.*

### Agent scaffolding / architecture (accuracy)

**SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering**
Yang et al. (Princeton) — NeurIPS 2024 — https://arxiv.org/abs/2405.15793
Showed the **interface design itself** (file editor, repo navigation, test execution) is an accuracy
lever — then-SOTA **12.5% pass@1** vs a prior best of 3.8%. *Areas: accuracy, scaffolding.*

**AutoCodeRover**
Zhang et al. — ISSTA 2024 — https://arxiv.org/abs/2404.05427
Uses an **AST-based program representation + iterative code search** over class/method structure
instead of raw text retrieval (a context-efficiency win). ~**19%** on SWE-bench-lite at ~**$0.43/task**.
*Areas: accuracy, cost-efficiency, context management.*

**Agentless**
Xia et al. — FSE 2025 — https://arxiv.org/abs/2407.01489
The influential contrarian result: a simple 3-phase pipeline (localize → repair → validate) with
**no autonomous tool-use** beat complex agents — **32.0%** on SWE-bench Lite at ~**$0.70/issue**.
Widely cited as evidence that agentic complexity isn't always necessary.
*Areas: accuracy, cost-efficiency, simplicity.*

**OpenHands (formerly OpenDevin)**
Wang, Neubig et al. — ICLR 2025 — https://arxiv.org/abs/2407.16741
Open-source platform for generalist dev agents (write code, use CLI, browse web) with **safe sandboxed
execution** and multi-agent coordination. One of the most-used open agent frameworks.
*Areas: accuracy, safety (sandboxing).*

### Context-bloat / long-context management

**MemGPT**
Packer et al. (UC Berkeley) — 2023 — https://arxiv.org/abs/2310.08560
The canonical long-context paper: applies **OS-style virtual/hierarchical memory** to LLMs, paging
information in/out of external storage to give "the illusion of infinite context" with fixed-window
models. *Areas: context-bloat, memory.*

**ACON: Optimizing Context Compression for Long-horizon LLM Agents**
Kang, Chen et al. (Microsoft) — 2025 — https://arxiv.org/abs/2510.00615
Learned context compression for long-horizon agents — cuts **peak token usage by 26–54%** while
*improving* task success over prior compression baselines. *Areas: context-bloat, efficiency.*

**On the Importance of Reasoning for Context Retrieval in Repository-Level Code Editing**
Kovrigin et al. — 2024 — https://arxiv.org/abs/2406.04464
Isolates **context retrieval** as a standalone problem. Key finding: LLM reasoning improves retrieval
*precision* but cannot reliably judge whether the gathered context is *sufficient*.
*Areas: context management.*

### Agent memory / self-improvement

**Reflexion: Language Agents with Verbal Reinforcement Learning**
Shinn et al. — NeurIPS 2023 — https://arxiv.org/abs/2303.11366
The canonical "reflection + episodic memory" paper — agents verbally self-reflect on failures and store
the reflections in a memory buffer (no weight updates). **91% pass@1 on HumanEval** vs GPT-4's 80%.
Among the highest-cited agent-memory works. *Areas: memory, accuracy.*

### The 2026 twist: benchmark validity

**"Why we no longer evaluate on SWE-bench Verified"** (OpenAI, Feb 2026)
https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
**The SWE-bench Illusion** — Liang et al. — NeurIPS 2025 — https://arxiv.org/abs/2506.12286
OpenAI **stopped reporting** SWE-bench Verified, citing training-data contamination and flawed test
cases (**≥59.4%** of audited hard problems had faulty tests). The "Illusion" paper corroborates
**memorization** (up to 35% consecutive 5-gram reproduction on SWE-bench vs ≤18% elsewhere).
*Areas: accuracy / eval validity.*

### Gaps noted in this pass
- **Safety was thin** — beyond OpenHands' sandboxing, no dedicated safety paper survived verification.
  Unverified leads surfaced: **AgentSpec** (DSL for runtime safety-constraint enforcement, 2025),
  **AGrail** (lifelong agent guardrail framework, 2025), **A-Mem** (Zettelkasten-style dynamic memory, 2025).
  → Being investigated in a dedicated Part 2 pass (see below).
- **"Speed" here mostly means token/dollar cost**, not wall-clock latency.

---

## Part 2 — Safe tool use for agents (sandboxing, human-in-the-loop, guardrails, benchmarks)

> Focus: papers that survey/taxonomize and *comparatively evaluate* safety mechanisms with measured
> trade-offs (safety vs. utility, latency, cost, false-positive rate). 23 claims verified, 2 refuted.

### Best entry points — surveys / SoK (taxonomy + trade-offs)

**A Survey on Trustworthy LLM Agents: Threats and Countermeasures** (the **TrustAgent** framework)
Yu, Meng et al. (incl. Yongfeng Zhang, Bo An, Qingsong Wen) — 2025 — https://arxiv.org/abs/2503.09648
Organizes agent trustworthiness into **intrinsic** (brain, memory, tool) and **extrinsic** (user, agent,
environment) dimensions, covering attacks, defenses, and evaluation. Best modular map of the design space.

**The Landscape of Prompt Injection Threats in LLM Agents: From Taxonomy to Analysis** (SoK)
Wang et al. — 2026 (submitted Feb 2026) — https://arxiv.org/abs/2602.10453
Taxonomizes attacks by payload strategy (heuristic vs. optimization) and **defenses by intervention stage
(text-level / model-level / execution-level)**. Its AgentPI benchmark finds the key trade-off result:
**no single defense simultaneously achieves high trustworthiness, high utility, and low latency.**
(Very new; AgentPI not yet widely reproduced.)

### Benchmarks that measure safety (several compare mechanisms head-to-head)

**ToolEmu — Identifying the Risks of LM Agents with an LM-Emulated Sandbox** *(sandboxing)*
Ruan et al. — ICLR 2024 — https://arxiv.org/abs/2309.15817
Landmark **LM-emulated sandbox**: a language model emulates tool execution so agents can be tested
against many tools/scenarios without manually building each sandbox, plus an LM-based safety evaluator.
Note: this is risk-*discovery* emulation, not OS/container isolation.

**AgentDojo** *(prompt-injection attacks + defenses)*
Debenedetti et al. (ETH Zurich) — NeurIPS 2024 Datasets & Benchmarks — https://arxiv.org/abs/2406.13352
The reference benchmark for tool-calling agents: **97 realistic tasks + 629 security test cases**,
evaluating multiple attack and defense paradigms head-to-head. The de-facto testbed others report against.

**Agent Security Bench (ASB)** *(the most comprehensive head-to-head comparison)*
Zhang et al. (Yongfeng Zhang group) — ICLR 2025 — https://arxiv.org/abs/2410.02644
Comparatively evaluates **27 attack/defense methods** across 10 scenarios / 400+ tools, attacking at four
stages (system prompt, user prompt, tool use, memory retrieval): 10 prompt-injection attacks, memory
poisoning, a Plan-of-Thought backdoor, 4 mixed attacks, **11 defenses across 13 LLM backbones**. Peak
average ASR **84.30%**; finds current defenses have **limited effectiveness**. → strongest single benchmark
for comparing safety mechanisms.

**R-Judge** *(risk awareness)*
2024 — EMNLP 2024 Findings — https://arxiv.org/abs/2401.10019
Tests whether LLMs can identify safety risks in agent tool-use interaction records (behavioral safety,
distinct from content harmlessness): **569 multi-turn records, 27 scenarios, 5 domains, 10 risk types**,
human-annotated. Best model GPT-4o reaches only **74.42% (F1)**; no other model significantly beats random
— a large gap in unsafe-action recognition.

**AgentHarm** *(harmfulness of tool-using agents)*
Andriushchenko et al. — ICLR 2025 — https://arxiv.org/abs/2410.09024
**110 explicitly malicious agent tasks (440 with augmentations)** across 11 harm categories (fraud,
cybercrime, harassment, …). *Caveat: a claim that it measures a safety-utility trade-off via post-attack
capability retention was **refuted** — do not attribute that framing to it.*

### Concrete defense mechanisms (mapped to the options you named)

**Progent — Programmable Privilege Control** *(runtime policy DSL + human-in-the-loop, combined)*
Shi, He, Wang, Li, Wu, Guo, Song (Dawn Song's Berkeley group) — 2025 — https://arxiv.org/abs/2504.11703
Enforces **least privilege**: privilege = a policy of symbolic rules over tool names/arguments, checked
deterministically on every tool call. An LLM auto-generates the initial policy; an **SMT solver** classifies
each update as a narrowing (auto-applied) or an expansion (**requires explicit human approval**),
guaranteeing monotonic confinement. On AgentDojo + ASB it cuts ASR while maintaining high utility —
directly measuring the **safety-vs-utility** trade-off. Best concrete example combining options (2) + (3).

**AgentSpec — a DSL for runtime safety rules** *(runtime guardrails / policy enforcement)*
2025 — https://arxiv.org/abs/2503.18666
Lightweight **DSL of triggers → predicates → enforcement** to keep agents inside safety boundaries.
Prevents **>90%** of unsafe executions for code agents, eliminates all hazardous embodied-agent actions,
and enforces 100% compliance for AVs, at **millisecond overhead**. *Caveat: 90%/100% are for hand-written
expert rules; auto-generated (o1) rules score lower (~87% risky-code detection).*

**GuardAgent — an external guard agent** *(action monitor)*
Xiang, Zheng, Li, … Song, B. Li — 2024 — https://arxiv.org/abs/2406.09187
A **separate LLM guard agent** monitors a target agent without modifying it: analyzes safety requirements,
generates a plan, and compiles it into executable guardrail code via reasoning + retrieved demonstrations.
Represents the external-monitor design point.

**CaMeL — Defeating Prompt Injections by Design** *(design-level defense; quantifies the utility cost)*
2025 — https://arxiv.org/abs/2503.18813
Notable for making the **safety-vs-utility trade-off explicit**: solves **77% of AgentDojo tasks with
provable security vs. 84% undefended** — a ~7-point utility cost for the guarantee. *Caveat: the 77-vs-84
number is verified, but a specific control/data-flow + capability **mechanism** description was **refuted**
— re-check the paper before repeating how it works.*

### The recurring cross-paper finding: current defenses are brittle

**Adaptive Attacks Break Defenses Against Indirect Prompt Injection Attacks on LLM Agents**
Zhan, Fang, Panchal, Kang — 2025 — https://arxiv.org/abs/2503.00061
Evaluates **eight** indirect-prompt-injection defenses (detection-based, input/prompt-level, model-level)
and shows **adaptive attackers break all eight**, with attack success consistently **>50%**. Corroborates
ASB's "limited effectiveness" conclusion — the honest counterweight to any single defense's headline number.

### Two claims that were adversarially refuted (do NOT cite these)
1. That **AgentHarm** measures safety-utility via post-attack capability retention. (0-3)
2. The specific control/data-flow-separation + capability mechanism attributed to **CaMeL**. (0-3)
   (CaMeL's 77%-vs-84% result stands; only the mechanism description failed verification.)

### Gaps / open questions in the safety literature
- **OS/container-level sandboxing** (microVMs, gVisor, seccomp) isn't benchmarked head-to-head on
  latency/cost/safety here — ToolEmu is LM-emulation for risk discovery, not real isolation overhead.
- **Human-in-the-loop cost** (false-positive rate, approval burden on the operator) is under-reported;
  papers give ASR-reduction and utility, not the human's oversight load.
- **Malicious-tool / malicious-MCP-server / malicious-repo** threats (incl. RedCode) did not surface with
  verified primary-source claims in this batch — a distinct gap from prompt injection.

---

## How to read the two parts together

The single best "one paper per role" shortlist for **safe tool use**:
- **Taxonomy/orientation** → TrustAgent survey (2503.09648) + the 2026 SoK (2602.10453)
- **Testbed everyone reports against** → AgentDojo (2406.13352)
- **Broadest head-to-head of mechanisms** → Agent Security Bench (2410.02644)
- **Concrete policy-enforcement + human-approval design** → Progent (2504.11703)
- **Reality check on all of the above** → Adaptive Attacks (2503.00061)

---

## Part 3 — Mapping to Agency features

> Which of these research threads each Agency feature speaks to, for the "here's active
> research → here's how Agency helps" connections on the *Why Agency?* guide page. Papers
> below marked (P1/P2) are the verified entries from Parts 1–2 above; the rest were added
> in a follow-up web pass and verified against their arXiv abstracts.

### Agents that write and run their own code — safely (`std::agency` + handlers + guards)

The richest connection — it straddles *code-as-action* and *agent safety*.

- **CodeAct — Executable Code Actions Elicit Better LLM Agents** — Wang et al. — ICML 2024 — https://arxiv.org/abs/2402.01030
  Executable code as a unified action space beats JSON/text tool calls by **up to 20%** success across 17 models.
  `std::agency` is code-as-action taken to its conclusion (the model writes a whole program) — plus the governance CodeAct lacks.
- **OpenHands** (P1, 2407.16741) — sandboxed execution of agent-written code; Agency does this at the language level (subprocess + handler chain).
- **Progent — Programmable Privilege Control** (P2, 2504.11703) — least-privilege policy checked deterministically on *every* tool call, human approval for privilege *expansions*. The closest academic analogue to Agency handlers.
- **AgentSpec — DSL for runtime safety rules** (P2, 2503.18666) — trigger → predicate → enforcement. Agency handlers + guards + policies *are* this DSL, built into the language.
- **The brittleness → by-design pivot** — Agent Security Bench (P2, 2410.02644) and Adaptive Attacks (P2, 2503.00061) show detection-based defenses break (ASR >50%); the 2026 SoK (P2, 2602.10453) and CaMeL (P2, 2503.18813) argue for *execution-level, by-design* enforcement. **Agency is in that camp**: it gates every effect deterministically rather than trying to detect bad behavior.

### Pausing for a human — and resuming where you left off (interrupts + resumability)

- **LLM-Based Human-Agent Collaboration and Interaction Systems: A Survey** — Zou et al. — 2025 (accepted ACL 2026) — https://arxiv.org/abs/2505.00753
  Frames human info/feedback/**control** injected mid-run as the fix for autonomy's reliability & safety failures. Interrupts are that control channel, first-class and resumable.
- **Progent** (P2, 2504.11703) — human approval for privilege expansion (HITL + policy combined).
- **Honest hook** — Part 2's own gap note: *"human-in-the-loop cost / approval burden on the operator is under-reported."* Agency's `preapprove`, policies, and `with approve` are directly about lowering that burden.
- **Durable/resumable execution** — mostly an *industry* frontier (Temporal, LangGraph checkpointing), not a landmark-paper one. Frame as "agent infra teams are reaching for durable execution; Agency makes checkpoint-and-resume a language primitive" — don't hang a weak cite on it.

### A subagent is just a tool (subagents)

- **AutoGen** — Wu et al. — 2023 — https://arxiv.org/abs/2308.08155
- **MetaGPT** — Hong et al. — 2023 — https://arxiv.org/abs/2308.00352
- **Multi-Agent Collaboration Mechanisms: A Survey of LLMs** — 2025 — https://arxiv.org/abs/2501.06322
  Multi-agent collaboration measurably helps, but these frameworks add real orchestration machinery (roles, SOPs, conversation patterns). Agency's counterpoint: a subagent is just a function passed as a tool.

### Concurrency you don't have to think about (state isolation)

**Deliberately no citation.** Per-run state isolation is a systems/PL correctness property (actor-model-like), not an open LLM-agent research question — forcing a paper here would weaken the credibility of the others. Kept as a pure engineering-correctness argument on the guide page.
