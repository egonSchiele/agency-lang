---
name: "expertGuidance"
description: "The ExpertGuidance type shared by the expert agents, with render"
---

# expertGuidance

and fail-open helpers.

## Types

### ExpertGuidance

What an expert consult returns.
- `rules` are for the solver to read;
- `checklist` are concrete, checkable acceptance criteria.
Empty rules and checklist means "nothing domain-specific here".

```ts
/** What an expert consult returns.
- `rules` are for the solver to read;
- `checklist` are concrete, checkable acceptance criteria.
Empty rules and checklist means "nothing domain-specific here". */
export type ExpertGuidance = {
  domain: string;
  rules: string[];
  checklist: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L10))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L16))

## Functions

### renderGuidance

```ts
renderGuidance(guidance: ExpertGuidance): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| guidance | [ExpertGuidance](#expertguidance) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L25))

### guidanceOrEmpty

```ts
guidanceOrEmpty(result: Result<ExpertGuidance>): ExpertGuidance
```

Unwrap a consult Result, failing open: a consult that errored yields empty
  guidance, so the caller proceeds exactly as it would without a consult.
  Guidance can only help, never block.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| result | `Result<ExpertGuidance>` |  |

**Returns:** [ExpertGuidance](#expertguidance)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/expertGuidance.agency#L37))
