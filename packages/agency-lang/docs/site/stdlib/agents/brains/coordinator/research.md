---
name: "research"
description: "The reading specialist of the Agency agent's coordinator brain:"
---

# research

a router over two stdlib agents. `agencyTopic: true` goes to
  `agencyResearcherAgent` (the bundled Agency docs); false, the default,
  goes to `researcherAgent` (web, Wikipedia, URLs). General is the default
  because a general researcher asked about Agency is merely less expert,
  while the Agency researcher asked about anything else has only Agency
  documentation to answer from. This file adds the formatting rules and
  the memory tools the coordinator gives its specialists.

## Constants

### researchTools

```ts
export static const researchTools: any[] = memoryTools()
```

**Type:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/research.agency#L21))

## Functions

### researchAgent

```ts
researchAgent(
  settings: AgentSettings,
  userMsg: string,
  agencyTopic: boolean = false,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string>
```

Answer a question that needs reading rather than writing: looking something
  up, summarizing a document, gathering background, or recalling a stored
  fact.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | a message describing what needs to be found out. |
| agencyTopic | `boolean` | false | true when the question is about the Agency language itself (its syntax, types, stdlib, or CLI), which routes to the agent that reads the bundled Agency documentation. Leave it false for every other subject, including questions about other languages. |
| maxSeconds | `number \| null` | null | working-time cap in seconds, when the user gave a deadline; null for the default (30 minutes, 10 for an Agency topic). |
| maxDollars | `number \| null` | null | spend cap in dollars, when the user gave one; null for the default ($50, $10 for an Agency topic). |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/research.agency#L29))
