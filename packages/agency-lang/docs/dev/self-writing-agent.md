# The self-writing agent: investigation notes

Working notes from a session on 2026-07-28 that started as "why is the agency
agent slow and expensive" and turned into an evaluation of a different
architecture: **an agent that writes the agent that answers the request.**

This is a findings document, not a spec. Every claim is tagged with where it
came from, because they are not equally solid:

- **[measured]** — run in this session against this repo. Reproducible.
- **[repo]** — from a file already in the repo.
- **[relayed]** — from published work, gathered by a research subagent and
  **not independently verified**. Treat as second-hand.
- **[mine]** — reasoning and framing, not a citation. Argued, not measured.

---

## 1. The central idea

Instead of one fixed agent loop with a fixed tool set that must handle every
request, the top-level agent **writes a small Agency program** for the request
in front of it, and runs it. The program composes library primitives — an LLM
call, a research agent, a coding agent, `guard` for budgets, `fork` for
parallelism — and is exactly as large as the request needs.

The prototype is `foo.agency`. Its shape:

1. Take the user message.
2. Ask a model to write an Agency program that answers it.
3. `review()` the program — parse and typecheck it. Reject if it does not compile.
4. `runCode()` it in a subprocess.
5. Return the program's output, optionally judged by a `judge` tool.

**Why Agency specifically.** Generated code runs in a subprocess whose
interrupts cross the process boundary. The parent's handler chain extends into
the child, a parent rejection beats a child approval, and an interrupt nobody
resolves checkpoints the child and surfaces to the user. So generated code
cannot do anything the user has not approved. **[repo:
`docs/dev/subprocess-ipc.md`]**

This is the part that is genuinely Agency's. The closest published system,
CaMeL, had to build the equivalent from scratch. **[relayed: arXiv 2503.18813]**

---

## 2. Why the current agent needed replacing

The trigger was one run: *"What are today's top news stories? Please answer
quickly."* It took 5m36s, cost **$3.3922**, burned **1,688,488 tokens**, and
returned nothing. Analysis of `log.jsonl`, run `14:25:05–14:31:01Z`:
**[measured]**

**The agent had the answer 26 seconds in.** At `14:25:31` it said: *"Got a good
picture. Digging into a few specific stories: UK PM change, Colombia election,
Seattle shooting, France wildfire."* Everything after that was re-verification.
It ran **53 distinct hosted web searches**, many near-duplicates of each other
("Seattle shooting July 28 2026", "Seattle mass shooting July 2026", "Seattle
Bite of Seattle shooting"). It was cancelled at `14:30:42` before printing
anything.

**Where the money went:**

| Category | Tokens | Cost |
|---|---:|---:|
| Cache **writes** | 551,284 | **$2.0673 (61%)** |
| Cache reads | 1,122,123 | $0.3366 |
| Output | 14,420 | $0.2163 |
| Fresh input | — | $0.0020 |

**Four causes, all in our own code:**

1. **The search tools handed the model an `apiKey` slot.** It filled it with
   its own tool-call markup — `"</antml_parameter>\n<parameter
   name=\"searchDepth\">basic"` — which reached the HTTP layer as an
   Authorization header. Three searches failed. The tool's env-var fallback
   did not save it, because that only applies when `apiKey` arrives *empty*,
   and a hallucinated key is not empty. The failures then convinced the
   researcher its search was broken, so it wrote an answer explaining it could
   not get the news; the reviewer correctly rejected that, and the loop went
   around again.
2. **One tool was eating a third of the tool budget.** `std::syntax::highlight`
   serialized to **17,775 characters** of JSON Schema (`diff`: 18,505) against
   a norm of 300–1,000 for the rest of the stdlib, because `theme` accepted a
   nested `ColorScheme` object. It was in the researcher's toolkit for a news
   query.
3. **Ceremony.** 19 of 20 logged tool calls were `whatIAmDoing`, `todoWrite`,
   and `saveDraft` — each a full LLM round trip returning a 4-character result.
   The three real search calls all crashed.
4. **"Please answer quickly" was discarded twice.** The coordinator rewrote the
   user's message before dispatch and dropped the phrase. The budget parser
   ignores vague urgency by design ("Vague urgency like 'quickly' with no
   number is NOT a budget"). The active guard was `$50 / 30 minutes`.

### Fixes landed (commit `c488937ce`)

- `theme` is now a `ThemeName` union of the eight built-in scheme names.
  `highlight` **17,775 → 807 chars**; `diff` **18,505 → 1,537**. **[measured]**
- Search API keys are bound with `.partial(apiKey: env(...))` before the tool
  reaches a model, so `apiKey` is not in the schema at all.
- New `client.maxToolSchemaChars` in `agency.json` (default **2000**, `0`
  disables). Checked in `runPrompt` after `assertUniqueToolNames`; emits a
  statelog `warn` with `warnType: "toolSchemaSize"`, once per tool name per
  run. Verified end-to-end.
- 16 new unit tests; existing suites green (14/14 search, 6/6 toolWiring).

The default of 2000 rather than 500 or 1000 is deliberate: every well-formed
stdlib tool measured under ~1,100 characters, so a lower threshold would fire
on healthy tools from day one and get ignored.

---

## 3. Prior art

**[relayed throughout this section — not verified.]**

The architecture has precedent and the numbers are good:

| System | Result | Source |
|---|---|---|
| **CaMeL** — privileged LLM writes a restricted program, interpreter prompts the human at tool boundaries | 77% of AgentDojo with provable security vs 84% undefended | arXiv 2503.18813 |
| **CodeAct** — code as the action space, 17 LLMs | GPT-4: 74.4% vs 53.7% text vs 52.4% JSON; 5.5 vs 7.7 turns | arXiv 2402.01030 |
| **LLMCompiler** — model emits a task DAG, runtime parallelizes | 3.7× latency, 6.7× cost, +9% accuracy vs ReAct | arXiv 2312.04511 |
| **DynaSaur** — agent writes and accumulates its own functions | GAIA 38.2% vs 29.0%; Level-3 11.5% → 26.9% | arXiv 2411.01747 |
| **ReWOO** — plan upfront instead of interleaving | 64% fewer tokens, +4.4% accuracy | arXiv 2305.18323 |

No mainstream framework ships this. The OpenAI Agents SDK frames orchestration
as *either* LLM-driven *or* human-written code; CrewAI splits adaptive Crews
from human-authored Flows; Devin's Playbooks are natural-language
pseudo-programs, not executable code. LangChain's `langgraph-codeact` is the
closest official artifact. **The space is open.**

**The main documented risk** is the language. *Syntax Without Semantics*
(arXiv 2605.15607) built a deliberately-unseen language and put the full spec
in the prompt: Sonnet 4.5 scored **58.0% vs 87.5% on Python, a −29.5 point
gap** — and **75% of its failures were correct-algorithm-but-wrong-syntax**.
Corroboration: merely renaming Isabelle's keywords dropped GPT-3.5 from 30.0%
to 9.29% (arXiv 2311.09635).

That prior predicted the prototype would struggle. It did not — see below.

---

## 4. Tests run, in order

All probes live in `investigate/`. They typecheck generated programs and never
run them.

### Probe 1 — `writerprobe.agency`: does the prompt produce code that compiles?

Three tasks × two conditions (prompt alone / prompt + the whole
`basic-syntax.md` guide), claude-sonnet-5. **[measured]**

- **4 of 6 compiled.**
- **Both failures were the same error, copied verbatim from the prompt**: the
  guard example said `guard(maxTime: 2m)` where the real parameter is `time:`
  (`AG6025`).
- **Adding the full syntax guide changed nothing** — outputs were byte-identical
  to the no-guide condition. The model was not confused about syntax; it was
  faithfully copying a wrong example.

That last result is the most actionable thing in this document: **reference
prose is not the lever. Correct examples are.** It matches the finding that
demonstrations beat descriptions 39.3% vs 15.0% **[relayed: arXiv 2311.09635]**.

### Probe 2 — `composeprobe.agency` v1: does it compose, or only slot-fill?

Five tasks that cannot be answered by copying one example, × two conditions
(with and without three added composing examples), run twice. **[measured]**

- **19 of 20 compiled** (one truncated generation).
- **It composes without being told how.** Given only one-call examples it still
  chained research→coding, wrapped a guard for a deadline, and ran three
  separate takes for a consensus question. An earlier claim of mine that it
  "only copies templates" was wrong, and came from tasks that did not require
  composition.
- **Composing examples bought parallelism, not correctness.** Both conditions
  were 100% correct; the difference was `fork` versus sequential calls — a 2–3×
  latency difference for the same work.
- **The one task whose capability was not demonstrated failed every time.**
  Asked to question the user, the model invented `ask()`, which did not exist.
  3 of 4 generations did this. The typechecker reports it as **`AG4004`, a
  warning, not an error**.

Tallied by coverage: **capability demonstrated → 16/16 correct; capability not
demonstrated → 0/4**, with invention as the failure mode. This is Voyager's
most-cited pitfall reproduced **[relayed: arXiv 2305.16291]**.

### Probe 3 — `composeprobe.agency` v2 against the fixed prompt

After `maxTime` was fixed, `ask` was made real in
`std::agents/composable/utils`, and `fork`/`ask` examples were added. Six
tasks; the probe now reads the live prompt out of `foo.agency` so it cannot
drift. **[measured]**

- **6 of 6 compiled. Zero errors, zero non-`AG3009` warnings, no invented
  functions.**
- `ask` now used correctly — the 0/4 failure disappeared once the primitive
  existed *and* was demonstrated.
- `fork` used for the parallel comparison.
- The new composable researcher appeared in 6/6 programs and eliminated the
  `AG3009` guard warnings that used to ride along on every generation.

**Two tasks used capabilities the prompt does not cover, and the failure mode
changed from invention to silent degradation:**

- *"whichever source answers first"* → dropped the requirement entirely and put
  "any reliable source" in the task string. `race` exists; the model does not
  know it.
- *"keep improving until it cites three sources"* → hand-rolled a 15-line
  `while` loop with an LLM yes/no check, instead of `revise` from
  `std::strategy`. It works, but it is six unbudgeted `researcherAgent` calls.

**One real bug found, in 2 of 6 programs.** Both wrote:

```agency
node main() {
  guard(time: 5m) {
    ...
    return comparison
  }
}
```

A bare `guard` statement **does not propagate its return value** — verified
directly: a function whose body is `guard(time: 5m) { return "inner value" }`
returns `undefined`. Those programs do all the work and hand back nothing, with
no error and no warning. The prompt's guard example taught this shape; it has
since been fixed to capture the result.

That is the fourth time a defect in an example became a defect in the output
(`maxTime`, a stray `\\n` in my own examples, and this). **Every example in the
prompt should be a file that CI typechecks.**

---

## 5. What works

- **The architecture fits the problem.** The failing news run failed because a
  fixed loop applied a grounding loop, a reviewer, and a supervisor to a
  question needing one search. Generated programs size themselves correctly:
  a bare researcher call for a price lookup, a `fork` for a comparison, a
  90-second guard when told to hurry. **[measured]**
- **The DSL penalty did not materialize.** Across three rounds — 4/6, 19/20,
  6/6 — every failure traced to a defect in an example, not to the model's grasp
  of Agency. The programs stay inside a small, demonstrated surface. **[measured]**
- **Compile-before-run is the right skeleton** and is the strongest asset here.
  Self-repair beats plain resampling specifically when feedback is *external*
  rather than self-generated; a typechecker is exactly that. **[relayed:
  arXiv 2304.05128, 2306.09896]**
- **The safety property is real** and verified in the repo docs. **[repo]**

## 6. What does not work yet

- **Generated programs have no resource ceiling.** `runCode`'s `maxCost`
  defaults to `null` — no limit — and `foo.agency` passes only `wallClock`. The
  hand-rolled six-call loop above would have run unbudgeted. The interrupt
  system gates *capabilities*, not *spending*, and spending is what broke the
  original run. **[measured/repo]**
- **Coverage gaps degrade silently now instead of loudly.** `revise`, `race`,
  `consensus`, and `supervise` all exist in the stdlib and go unused.
- **Upfront programs are structurally brittle.** A program written before any
  information arrives cannot express "research X, and if it turns out Y, do Z."
  ReWOO names this as its own tradeoff. Currently mitigated by the writer being
  able to call `execute` repeatedly, but each iteration rewrites the whole
  program. **[relayed: arXiv 2305.18323]**
- **There is a latency floor.** Writing code, typechecking, and forking a
  subprocess all happen before any work starts. For "what is the capital of
  India" that is strictly worse than answering. A fast path that skips codegen
  belongs in front of this, not in competition with it. **[mine]**
- **Verification creep may return one level up.** The `judge` tool is
  conditional today, which is right. Making it unconditional is how the
  researcher got to 26 LLM calls. **[mine]**
- **Nothing has been measured end to end.** Every result here is *does the
  generated program typecheck*. The claim that matters — does the news query now
  return in under a minute for under a dollar, against a baseline of 5m36s and
  $3.3922 — is still untested.

---

## 7. The building blocks

The original complaint was that the stdlib agents are too complex to compose.
Measured: **[measured/repo]**

`researcherAgent` had **10 parameters** wrapping five layers a caller could not
remove — `guard` → `thread` → `revise` → `checkGrounding` (which calls
`reviewAgent`, itself a guarded agent) → `saveDraft`, plus unconditional hosted
web search. The module exported exactly two things, and the inner loop was a
private `def`. A code-writing agent could not reach it.

Meanwhile `std::strategy` already exports `sample`, `consensus`, `retry`,
`retryWithFeedback`, `revise`, `firstValid`, and `std::supervise` exports
`supervise`. **The composable layer already existed**; the agents just did not
expose the seam below themselves.

`std::agents/composable/researcher` is the response to this: `systemMessage` +
one `llm` call with tools, no guard, no review loop, no thread. It appeared in
6/6 generated programs and carries none of the old warnings.

**One bug worth fixing regardless of direction:** `hostedSearchTools(model)`
accepts a `model` parameter and **ignores it entirely**, always returning
`["web_search"]`. Seven stdlib agents call it, so every agent — including the
coding agent and the reviewer — unconditionally requests provider-hosted web
search with no way to turn it off. **[measured]**

---

## 8. Terminal-Bench and DNA-insert

The self-writing direction addresses the *news* goal and barely touches the
*Terminal-Bench* goal. Writing `codingAgent(task)` more intelligently does not
make `codingAgent` better at splicing a plasmid. These are two projects.

From the DNA-insert instruction: transform a circular plasmid into a target
using Q5 site-directed mutagenesis primers; constraints are length 15–45,
Tm 58–72, pair ΔTm ≤ 5, minimal number of pairs, output `primers.fasta`, and
**ground-truth Tm is `primer3`'s `oligotm` with exact flags**
(`-tp 1 -sc 1 -mv 50 -dv 2 -n 0.8 -d 500`).

Both plausible failure modes land in the two clusters `terminal-bench.md`
already identifies as harness-addressable: computing Tm with a different
library than the one specified (spec-adherence), and not checking the output at
all (verification).

**Highest-value move for this task: verify by reconstruction.** Simulate the
mutagenesis from the generated primers and assert the product equals the target
sequence. That catches the two traps I would expect to sink an attempt — the
plasmid is *circular*, so the edit can straddle the origin of the linear
representation and a naive diff mislocalizes it; and Tm applies only to the
annealing portion, so the inserted bases on the 5′ tail must be excluded.
Generalized: **write the checker before the solution, and make it use the tool
the task names.** **[mine, grounded in the task text]**

### Four harness changes, prioritized

1. **Stop telling the model to avoid the shell.** `stdlib/agents/coding.agency`
   says *"Avoid using [bash and exec] if at all possible… every time you use
   bash or exec, it will require human approval."* Under the benchmark adapter
   that is false — it runs `--policy approve-all` — and DNA-insert cannot be
   solved without repeatedly shelling out to `oligotm`. **[measured/repo]**
   For context, Terminal-Bench's own reference harness Terminus has **one tool,
   a tmux session**, and mini-swe-agent is bash-only at >74% on SWE-bench
   Verified. **[relayed]**
2. **Make verification a gate, not advice.** `oneShot.md` already says
   under-verifying is the number-one failure, and it is still the top failure
   cluster — prose has been tried. The measured version is structural:
   LangChain moved Terminal-Bench 2.0 from **52.8% → 66.5% with the same
   model**, centered on a middleware that blocks completion until a
   verification pass has run. `verifierAgent` and `verify.agency` already
   exist; the change is making the path through them mandatory and requiring
   quoted tool output. **[relayed]**
3. **Cut the tool surface.** `codingAgent` exposes **48 tools**, 18 of them git,
   on tasks with no repository. **[measured]** Selecting a relevant subset
   rather than presenting the full catalog took tool-selection accuracy from
   13.62% to 43.13% in one study. **[relayed: arXiv 2505.03275]**
4. **Add a stall detector.** Repeating failed actions is Magentic-One's #1
   failure mode; their fix is a counter forcing re-planning at threshold 2.
   **[relayed: arXiv 2411.04468]** The same pathology appeared in the news run
   as 53 near-duplicate searches. **[measured]**

**Ceiling estimate:** clearing the whole addressable bucket takes ~0.38 to
roughly **0.65** (24 tasks of 89) — the same order as the LangChain jump. It
does not touch the ~46 capability-bound tasks. **[repo + mine]**

---

## 9. Model-addressable vs harness-addressable

**[mine — this framework is my synthesis, not from a paper.]**

The useful question is not "model or harness" but **can the missing ingredient
be supplied from outside the model?**

**The oracle test.** Give the agent a free, unlimited, perfectly accurate
"correct / incorrect" checker. Would it eventually pass?

- **Yes → harness-addressable.** It can generate a correct candidate and is
  failing to recognize one. A *search* problem, and a harness is a
  search-improvement device.
- **No → model-bound.** It cannot produce a correct candidate, so filtering
  buys nothing. A *generation* problem.

DNA-insert passes the oracle test: Q5 primer design is standard chemistry.

**Transcript signals for harness-addressable:** the task is flaky (near-proof —
a task that passes even once at k=5 is inside model capability by
demonstration, so everything preventing consistency is scaffold); a
correct-shaped artifact was produced and never run; a failure was seen and the
same action repeated; time or budget ran out mid-work; the answer was right and
the format wrong; the agent contradicted something it had established earlier.

**Signals for model-bound:** consistent failure with *structurally different*
wrong approaches each attempt; every attempt confidently wrong the same way
with no way to notice; the task reduces to one reasoning step that cannot be
decomposed or checked incrementally.

**An example that isolates it.** *"This program produces correct output in 45
seconds. Make it byte-identical in under 500ms. Tests provided."* Verification
is free, perfect, and immediate; retries are unlimited; there is no format
ambiguity. An agent can still fail 5/5, because the required move is
recognizing that a quadratic scan can be replaced by a suffix automaton. **A
perfect oracle just says "still too slow" a hundred times.** Any task where
that is true is model-bound.

**The boundary moves,** which matters more than the taxonomy. Much of what gets
filed as "needs a better model" is really "needs the right three paragraphs in
context" — a skill file substituting for model knowledge. Tools move it too: a
profiler converts part of the optimization example from insight into
observation. Verification supplies signal, skills supply knowledge, tools
supply observation. Only genuine synthesis is left over.

**A cheap protocol for classifying the 70 failing tasks:** flaky → harness, no
further analysis (that is 31 already). For consistent fails, read three
transcripts: was there ever a correct artifact that was lost, unchecked, or
timed out → harness. Then **the hint test** — give one paragraph of the key
insight and rerun; converting to a pass means knowledge-bound, which is a doc
or a skill, not a new model. That step is the cheapest and splits the ~46
"capability" bucket into two very different piles.

---

## 10. Where I would go next

1. **Fix the guard example** so it captures the result (done) and **make the
   prompt's examples CI-typechecked files.** Four for four example defects have
   shipped into generated code.
2. **Cap `runCode` with a `maxCost`.** The one gap where generated code can
   still reproduce the original failure.
3. **Add `revise` and `race` examples.** Currently the model hand-rolls the
   first and silently drops the second.
4. **Measure end to end.** "Today's top news, quickly" against the 5m36s /
   $3.3922 baseline. Nothing else settles whether this direction is right.
5. Separately, on the benchmark track: items 1–4 of §8.

---

## Citations

**Verified in this repo:** `docs/dev/subprocess-ipc.md` (interrupt propagation
across the subprocess boundary), `docs/dev/terminal-bench.md` (benchmark scores
and the 46/24 failure split), `stdlib/agents/*` (agent structure and tool
counts), `log.jsonl` (the failing run).

**Relayed, not verified.** These came from a research subagent. If one is going
to drive a decision, check it first.

- CaMeL — arXiv 2503.18813
- CodeAct — arXiv 2402.01030
- LLMCompiler — arXiv 2312.04511
- DynaSaur — arXiv 2411.01747
- Voyager — arXiv 2305.16291
- ReWOO — arXiv 2305.18323
- Magentic-One — arXiv 2411.04468
- RAG-MCP — arXiv 2505.03275
- Syntax Without Semantics — arXiv 2605.15607
- Keyword-renaming / demonstrations-vs-description — arXiv 2311.09635
- Self-Debugging — arXiv 2304.05128; Is Self-Repair a Silver Bullet? — arXiv 2306.09896
- Long-Horizon Terminal-Bench (79% timeouts) — arXiv 2607.08964
- Terminal-Bench 2.0 failure taxonomy (verification class 47–60%) — Snorkel blog / OpenReview
- LangChain Deep Agents harness engineering (52.8% → 66.5%) — langchain.com blog
- Anthropic engineering: writing effective tools, context engineering, code
  execution with MCP
- SWE-agent (+10.7pp from a purpose-built interface) — arXiv 2405.15793

**Adjacent literature the §9 framework rests on** (named, not consulted for
this document): the generator–verifier gap behind best-of-N and process reward
models (Lightman et al., *Let's Verify Step by Step*); pass@k versus pass@1 as
capability-versus-reliability (Chen et al., 2021, the Codex/HumanEval paper).

---

## Artifacts

- `foo.agency` — the prototype
- `stdlib/agents/composable/{researcher,utils}.agency` — the small primitives
- `investigate/writerprobe.agency` — probe 1
- `investigate/composeprobe.agency` — probes 2 and 3; reads the live prompt from
  `investigate/prompt.txt`, regenerated with the `awk` command in its header
- `lib/runtime/toolSchemaSize.ts` + tests — the oversized-schema warning
