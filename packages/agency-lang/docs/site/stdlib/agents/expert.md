---
name: "expert"
---

# expert

Expert-guided coding agent.

  A weak model often fails a task not because it can't reason, but because it
  is missing a domain convention (e.g. "an overlap-extension primer's annealing
  arm must be 15-45 nt", "ELF memory addresses come from `p_vaddr`, not a
  hardcoded 0x400000"). This agent first ACQUIRES that expertise — routing to an
  Agency-language specialist (bundled docs) or a general-knowledge specialist
  (web / Wikipedia) — then hands the task plus a concrete rules-and-checklist to
  the coding agent to actually solve.

  This is a temporary experiment: it is wired in as a drop-in for `plannerAgent`
  on the code agent's "complex" triage branch, to see whether front-loading
  domain expertise lifts a weak model. It implements the `consultExpert` design
  in docs/superpowers/specs/2026-07-13-consult-expert-subagent-design.md, minus
  the verify-side integration (that comes with the full change).

## Types

### ExpertGuidance

What an expert consult returns. `rules` are for the solver to read;
  `checklist` are concrete, checkable acceptance criteria. Empty rules AND
  checklist means "nothing domain-specific here".

```ts
/** What an expert consult returns. `rules` are for the solver to read;
  `checklist` are concrete, checkable acceptance criteria. Empty rules AND
  checklist means "nothing domain-specific here". */
export type ExpertGuidance = {
  domain: string;
  rules: string[];
  checklist: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L34))

## Functions

### agencyExpert

```ts
agencyExpert(question: string): ExpertGuidance
```

Agency-language specialist: returns rules + a checklist grounded in the
  bundled docs. @param question - the task to advise on.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** [ExpertGuidance](#expertguidance)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L93))

### domainExpert

```ts
domainExpert(question: string): ExpertGuidance
```

General-knowledge specialist: returns rules + a checklist, using web /
  Wikipedia lookups. @param question - the task to advise on.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** [ExpertGuidance](#expertguidance)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L105))

### consultExpert

```ts
consultExpert(question: string): ExpertGuidance
```

Route to the Agency-language or general-domain specialist automatically and
  return its guidance. @param question - the task to advise on.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** [ExpertGuidance](#expertguidance)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L117))

### expertAgent

```ts
expertAgent(
  task: string,
  context: string = "",
  maxCost: number = $20.00,
  maxTime: number = 15m,
): string
```

Expert-guided coding agent. Consults a domain expert for the task's rules and
  acceptance criteria, then solves the task with that guidance in hand. A
  drop-in for plannerAgent: takes a task, returns a summary string; the real
  output is filesystem side effects.

  @param task - what to accomplish.
  @param context - optional extra material passed through to the solver.
  @param maxCost - hard spend cap for the whole run (default $20).
  @param maxTime - hard wall-clock cap for the whole run (default 15 minutes).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/expert.agency#L148))
