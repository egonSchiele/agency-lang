---
name: "researcher"
description: "Research a topic in an isolated conversation with source tools."
---

# researcher

This composable researcher returns the model's answer directly. Use
`std::agents/researcher` when you need configurable budgets, model overrides,
and the shared-conversation handoff behavior.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return source lookup tools for the composable researcher.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/composable/researcher.agency#L17))

### researcherAgent

```ts
researcherAgent(topic: string): string
```

Research a topic with source tools and return a cited answer.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| topic | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/composable/researcher.agency#L39))
