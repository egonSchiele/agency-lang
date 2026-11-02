---
name: "expertGuidance"
description: "Render expert guidance for a solver and handle failed consultations."
---

# expertGuidance

Expert agents return `ExpertGuidance`. Pass it through `renderGuidance` for
a coding agent's context and use its `checklist` as acceptance criteria.
`guidanceOrEmpty` turns a failed consultation into empty guidance.

## Types

### ExpertGuidance

Guidance for a solver: domain conventions in `rules` and checkable
acceptance criteria in `checklist`. Empty lists mean the consult supplied
no domain-specific guidance.

```ts
/** Guidance for a solver: domain conventions in `rules` and checkable
acceptance criteria in `checklist`. Empty lists mean the consult supplied
no domain-specific guidance. */
export type ExpertGuidance = {
  domain: string;
  rules: string[];
  checklist: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L12))

## Constants

### emptyGuidance

```ts
export static const emptyGuidance: ExpertGuidance = {
  domain: "",
  rules: [],
  checklist: []
}
```

**Type:** [ExpertGuidance](#expertguidance)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L18))

## Functions

### renderGuidance

```ts
renderGuidance(guidance: ExpertGuidance): string
```

Fold expert guidance into a context block the coding agent reads
  before it starts. Empty guidance yields an empty string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| guidance | [ExpertGuidance](#expertguidance) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L24))

### guidanceOrEmpty

```ts
guidanceOrEmpty(result: Result<ExpertGuidance>): ExpertGuidance
```

Return expert guidance, or empty guidance if the consultation failed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| result | `Result<ExpertGuidance>` |  |

**Returns:** [ExpertGuidance](#expertguidance)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L35))
