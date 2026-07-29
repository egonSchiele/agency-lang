---
name: "researcher"
---

# researcher

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the researcher's tools: the encyclopedia and fetch tools that need
  no key, a local file read for material the caller points at, and whichever
  search providers the environment has a key for.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/composable/researcher.agency#L8))

### researcherAgent

```ts
researcherAgent(topic: string): string
```

Research a topic in depth and give a response.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| topic | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/composable/researcher.agency#L38))
