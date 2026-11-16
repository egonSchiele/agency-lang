---
name: "agency"
description: "The Agency agent as a function: an assistant that answers a task"
---

# agency

itself or hands it to a coder, a researcher, reviewers, and other subagents.

```ts
import { agencyAgent } from "std::agents/agency"

node main() {
  const reply = agencyAgent("Add a --json flag to the report command", maxCost: $5.00)
  print(reply)
}
```

A model can call it as a tool. Bind what your program decides, such as the
budget, so the model sees only the task and cannot change the rest:

```ts
const agent = agencyAgent.partial(maxCost: $5.00, maxTime: 10m)
const answer = llm(prompt, tools: [agent])
```

`agencyAgent` is a plain function, not a handoff. Called from code, it
continues the caller's conversation thread, so a second call sees the
first. Called as a tool, it starts on a fresh thread.

The agent's system prompt stays on the thread it ran on. To keep it away
from your program's other `llm()` calls, call `agencyAgent` inside a
`thread { }` block.

It reads none of the user's own files. A caller that wants the user's
instructions or tools passes them in, through `context` and `extraTools`.
It installs no handler, so the caller's handlers decide every interrupt
it raises. It prints nothing. A caller follows its progress through the
runtime callbacks, and through `onEmit`, which receives an event with
`type: "agencyAgent.subagentStart"` when a subagent starts and
`type: "agencyAgent.routerFailed"` when the router model fails.

`agency agent` on the command line is a caller of this function.

## Types

### AgencyAgentBrain

Which brain answers.

```ts
/** Which brain answers. */
export type AgencyAgentBrain =
  | "coordinator"
  | "minimal"
  | "simple"
  | "spawntest"
  | "scripttest"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L50))

### AgentExtraTools

Extra tools, one optional list per agent that can take them.

```ts
/** Extra tools, one optional list per agent that can take them. */
export type AgentExtraTools = {
  // Added to the tools of the model that answers the turn.
  main?: any[];
  // Added to the tools of the coder and the Agency coder. Only the
  // coordinator brain has them.
  coder?: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L53))

### BrainInfo

A brain's name and its one-line description.

```ts
/** A brain's name and its one-line description. */
export type BrainInfo = {
  name: AgencyAgentBrain;
  description: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L62))

## Functions

### agencyAgentBrains

```ts
agencyAgentBrains(): BrainInfo[]
```

Return the brains `agencyAgent` can run, each with a one-line description.

**Returns:** `BrainInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L67))

### isCoordinatorBrain

```ts
isCoordinatorBrain(brain: string): boolean
```

Whether a brain is the coordinator or is built on it, and so has its subagents and takes the same tools from a caller.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| brain | `string` |  | A brain's name |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L95))

### agencyAgent

```ts
@guarded(cost: maxCost, time: maxTime)
agencyAgent(
  task: string,
  context: string = "",
  brain: AgencyAgentBrain = "coordinator",
  maxCost: number = $50.00,
  maxTime: number = 30m,
  model: string = "",
  provider: string = "",
  reasoningModel: string = "",
  reasoningProvider: string = "",
  routerModel: string = "",
  routerProvider: string = "",
  extraTools: AgentExtraTools = {},
  attachments: Attachment[] = [],
): Result<string>
```

Hand a task to the Agency agent, a general assistant that can read and
  edit code, run commands, look things up, and review code and prose. It
  answers small requests itself and hands larger ones to its subagents.
  Returns its reply.

A negative `maxCost` or `maxTime` means no limit. A model that is given
  this function as a tool fills in every parameter it can see, so bind the
  budgets, the models, and `extraTools` with `.partial` before you hand it
  to `llm()`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | What the user wants, as they would say it to an assistant |
| context | `string` | "" | Extra text for the agent, such as the user's own instructions, or "" |
| brain | [AgencyAgentBrain](#agencyagentbrain) | "coordinator" | Which brain answers: "coordinator", "minimal", "simple", "spawntest", or "scripttest" |
| maxCost | `number` | $50.00 | Cost budget in USD |
| maxTime | `number` | 30m | Time budget in milliseconds |
| model | `string` | "" | The main model, or "" for the ambient model |
| provider | `string` | "" | The main model's provider |
| reasoningModel | `string` | "" | The model for the coordinator, the oracle, and the explorer, or "" for the main model |
| reasoningProvider | `string` | "" | The reasoning model's provider |
| routerModel | `string` | "" | A small model that sends a plain message straight to the coder or the researcher, or "" for no routing |
| routerProvider | `string` | "" | The router model's provider |
| extraTools | [AgentExtraTools](#agentextratools) | {} | Extra tools: `main` for the model that answers, `coder` for the coders |
| attachments | `Attachment[]` | [] | Images or files sent with the task |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency.agency#L109))
