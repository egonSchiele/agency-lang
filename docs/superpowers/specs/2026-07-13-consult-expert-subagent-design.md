# Design: `consultExpert` — on-demand expertise for the code agent

**Date:** 2026-07-13
**Status:** Design (approved for planning)
**Author:** brainstormed with the owner

## Problem

The Agency coding agent underperforms on Terminal-Bench tasks that require
domain knowledge the model lacks. Two representative failures:

- **dna-insert:** the model designed overlap-extension primers whose annealing
  arm was out of the required 15–45 nt range — 2 nt in one run, 86 nt in
  another. It has no grip on the domain rule and misses it in both directions.
- **extract-elf:** the model wrote a correct ELF parser but hardcoded the memory
  base to `0x400000` (from the task's example) instead of reading `p_vaddr` from
  the program headers, and validated only against the provided binary. The
  hidden grader runs the program against a freshly-compiled PIE binary (base
  ≈ 0), so the hardcoded base gives 0% overlap — yet the model declared success.
  A missing domain convention *plus* self-verification against the wrong target.

These are **domain-knowledge failures**, not reasoning failures — and the
one-shot code agent has no way to fix them:

1. In one-shot mode (how Terminal-Bench runs the agent) the code agent is
   invoked as `codeAgent(userMsg, allowHandoff: false)` — a *solo* agent. It
   cannot reach `researchAgent`, `oracleAgent`, or anything else. It is a brain
   in a jar.
2. The existing `verify` step is **domain-blind**: it checks the artifact
   against the task's *stated* criteria ("values must match the reference"),
   which are abstract. It doesn't know primer biochemistry or ELF conventions,
   so it can't catch the miss.

This is precisely where Agency's thesis — composition lets a *weak* model
perform well — should pay off. The fix is not a stronger model; it is giving
the isolated agent a way to **acquire domain knowledge and domain-specific
acceptance criteria on demand**.

## Non-goals

- **No per-domain hand-written specialists** (a "bioinformatics agent", an
  "ELF agent"). Terminal-Bench spans effectively unbounded domains; pre-writing
  one specialist per known task is overfitting to the test, not a general
  capability.
- **No stronger model.** Every new agent runs on the same weak model as the
  solver. (This rules out reusing `oracleAgent`, which escalates to a stronger
  model.)
- **No solver-side upfront consult in v1.** A "consult before you start so you
  do it right the first time" step is a plausible follow-on, but it adds cost
  and wrong-domain risk. v1 ships the tool + the verify-side net only.
- **No planner/decomposer work.** Tracked separately.

## Overview

Introduce a shared, composable expertise capability with two specialists behind
an automatic classifier, consumed through two entry points.

```
                       consultExpert(question)          <- automatic classifier
                        /                     \
             agencyExpert(question)     domainExpert(question)
             docs + typecheck           web / Wikipedia / fetch
                        \                     /
                     ExpertGuidance { domain, rules[], checklist[] }
                        /                     \
     (1) solver tool: codeTools          (2) verify-side: verifyWithExpert(task)
         model pulls help when             -> consultExpert(task)
         it knows it's stuck               -> verify(task, criteria)  (domain-aware)
```

- **Entry point 1 (pull):** the model calls `consultExpert` as a tool when it
  knows it needs help. Catches the cases where the model *is* aware it's stuck.
- **Entry point 2 (push):** `verify` structurally consults for the domain's
  acceptance criteria and checks the artifact against them. Catches the cases
  where the model is *confidently wrong* — the harder, more common failure.

The two entry points reinforce each other: the pull path helps a self-aware
model do it right; the push path is the safety net for an overconfident one.

## Components

### `std::agents/expert.agency` (new file)

New building blocks in the `std::agents` composable family (alongside
`coding`, `research`, `agency` from PR #534). Composition, not configuration:
plain `def`s, shared logic as helpers, no base class.

**Shared output contract:**

```
type ExpertGuidance = {
  domain: string        // e.g. "molecular biology / primer design", "agency-lang"
  rules: string[]       // conventions and knowledge — consumed by the solver
  checklist: string[]   // concrete, checkable acceptance criteria — consumed by verify
}
```

Empty `rules` **and** `checklist` means "nothing domain-specific here"; every
downstream consumer then behaves exactly as it does today.

**`agencyExpert(question: string): ExpertGuidance`**
The Agency-language specialist. Tools: `docsSkill("guide")`, `docsSkill("cli")`,
`docsSkill("diagnostics")`, `typecheck` — the authoritative bundled corpus that
`research`/`oracle` already use. Answers "how do I express X in Agency" and
returns the rules + a checklist for Agency correctness. Weak model.

**`domainExpert(question: string): ExpertGuidance`**
The general-knowledge specialist. Tools: web search, `std::wikipedia`,
`std::http` `fetch`/`fetchJSON`/`fetchMarkdown`. Answers arbitrary technical
domains (primer design, ELF layout, HTML sanitization) and returns rules + a
checklist. Weak model.

**`consultExpert(question: string): ExpertGuidance`**
The dispatch layer. Runs one `llm()` classification returning
`"agency" | "general"` (biased: mentions of Agency / `.agency` / Agency syntax
→ `agency`; **defaults to `general` when unsure**), then delegates to the
matching specialist. Both specialists remain individually callable for a caller
that already knows the domain.

Each specialist runs its loop inside a `guard(cost:, time:)` block and returns
via the shared `unwrapGuard`-style pattern, so a budget trip yields empty
guidance rather than throwing (see Error handling).

### `std::agency::verify` (modified)

Add an optional parameter:

```
export def verify(task: string, criteria: string[] = []): Result<Feedback[]>
```

`verifyInner` injects a non-empty `criteria` list into its **analysis** prompt
(step 1 of the existing two-step flow), appending: "Also check the artifact
against these domain-specific acceptance criteria: `<checklist>`." Step 2
(convert-to-`Feedback[]`) and the fail-open wrapper are unchanged. With an empty
`criteria` list the prompt — and thus the behavior — is byte-identical to today.

This keeps `std::agency` free of any dependency on `std::agents` (the caller
supplies the criteria), avoiding an import cycle: `std::agents/*` already
imports `std::agency`.

### `verifyWithExpert(task: string): Result<Feedback[]>` (new, in `std::agents`)

The structural consult+verify composition, living at the `std::agents` layer
that is allowed to know about both `consultExpert` and `std::agency::verify`:

```
def verifyWithExpert(task):
  const guidance = consultExpert(task)     // fail-open -> empty guidance
  return verify(task, guidance.checklist)  // empty checklist -> today's verify
```

### Code-agent wiring (`lib/agents/agency-agent/subagents/code.agency`)

Two edits:

1. Add `consultExpert` (the router) to `codeTools` so the solver can pull help.
2. Replace the loop's `verify(originalUserMsg)` call with
   `verifyWithExpert(originalUserMsg)`.

The agent's `verify.agency` adapter (Verdict shaping) is unchanged except that
it now delegates to `verifyWithExpert`.

## Data flow

**Pull (solver tool):** model → `consultExpert(question)` → classify →
specialist → `ExpertGuidance`; the model reads `rules` and continues.

**Push (verify-side):** finalize → `verifyWithExpert(task)` →
`consultExpert(task)` → `ExpertGuidance` → `verify(task, checklist)` → the
domain criteria enter the analysis prompt → domain violations surface as
`error: true` `Feedback` items → the existing fix loop re-prompts the solver
with those gaps (this is how the domain knowledge reaches the solver on the
push path).

## Error handling

- **Fail-open everywhere.** `consultExpert` and both specialists return empty
  `ExpertGuidance` on any failure (guard trip, tool error, unparseable output).
  Verification can only help, never block — the same discipline `verify`
  already follows.
- **Empty guidance == status quo.** Empty `checklist` → `verify` behaves
  exactly as today. This is the guardrail against the real risk of a structural
  consult: manufacturing false "rules" that break an otherwise-correct solution.
- **Bounded cost.** Each specialist is `guard(cost:, time:)`-wrapped like
  `codingAgent`. The verify-side consult is additionally bounded by the code
  loop's existing `verifyRounds` cap (2), so at most two consults per run on the
  push path.

## Testing

**Deterministic (`test:agency`, no LLM calls):**
- `consultExpert` routing: agency-flavored vs general-flavored inputs delegate
  correctly (classification stubbed via the deterministic LLM provider).
- `ExpertGuidance` shape and the empty-guidance fail-open path.
- `verify(task, criteria)` criteria-injection: empty list reproduces current
  behavior; non-empty list changes the analysis prompt (assert via statelog,
  per the deterministic-mock convention).

**Real-LLM efficacy (`tests/integration/agents`, non-blocking, mirrors PR #534).**
The two cases below are drawn from real Terminal-Bench failures, so they double
as regression targets for the benchmark. Each pairs a "the expert surfaces the
rule" assertion with a "verify catches a planted violation" assertion — because
the checklist is only useful if verify actually enforces it.

- **dna-insert (missing domain rule).** The model has no grip on the constraint
  that the annealing (template-binding) portion of an overlap-extension primer
  must be 15–45 nt: across benchmark runs it produced a 2-nt arm (too short) and
  an 86-nt arm (too long) — same rule, opposite directions.
  - `domainExpert("design overlap-extension / Gibson primers to insert DNA")`
    returns a `checklist` item asserting the annealing arm is 15–45 nt.
  - `verifyWithExpert` flags a planted `primers.fasta` whose forward-primer
    annealing arm is 2 nt (and, separately, 86 nt) as an `error` finding.

- **extract-elf (hardcoded assumption + no generalization test).** The model
  built a correct ELF parser but (a) hardcoded the memory base to `0x400000`
  from the task's example instead of reading `p_vaddr` from the program headers,
  and (b) validated `extract.js` only against the provided `a.out`, never
  compiling a second binary. The hidden grader runs the program against a
  freshly-compiled **PIE** binary (base ≈ 0) and a hidden reference extractor,
  so the hardcoded base yields 0% address overlap.
  - `domainExpert("extract memory values from an ELF binary")` returns
    `checklist` items covering *both* facts: "compute addresses from `p_vaddr`
    in the program headers; do not hardcode 0x400000 (modern executables are
    PIE, base 0)" **and** "validate the program on a freshly-compiled binary,
    not only the one provided."
  - `verifyWithExpert` flags an `extract.js` that hardcodes `0x400000` as an
    `error` finding (checked by running it against a PIE binary the test
    compiles).

- **agencyExpert (specialization + routing).** `consultExpert` routes an
  Agency-syntax question to `agencyExpert`, which answers it grounded in the
  bundled docs (not the web).

## Rollout

1. `std::agents/expert.agency` with the three `def`s + `ExpertGuidance` +
   deterministic tests.
2. `std::agency::verify` optional `criteria` param + injection + tests.
3. `verifyWithExpert` in `std::agents`.
4. Wire into `code.agency` (tool + verify swap).
5. Real-LLM efficacy cases; re-run dna-insert / extract-elf via the benchmark
   tarball to measure movement.

## Open questions / risks

- **Classifier accuracy on ambiguous inputs.** Mitigated by defaulting to
  `general` and by both specialists staying individually callable.
- **Consult latency/cost per task.** Measured in step 5; the `guard` caps and
  `verifyRounds` bound the worst case. If cost is material on trivially-simple
  tasks, a future gate can skip the consult, but v1 keeps it unconditional
  (a weak model can't reliably self-identify when it needs help).
- **Checklist quality drives verify quality.** A vague checklist yields vague
  gaps. The specialist prompts must demand *concrete, checkable* criteria
  (numbers, formats, invariants), not platitudes.
