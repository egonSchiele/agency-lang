---
name: "github"
description: "Read and act on GitHub pull requests and issues."
---

# github

Give `githubAgent` to another agent as a tool. That agent then carries one
tool in place of the eighteen GitHub tools, which are only sent to the model
while `githubAgent` is working.

```ts
import { githubAgent } from "std::agents/github"

node main() {
  const answer: string = llm("Summarize the review comments on PR 12", { tools: [githubAgent] })
  print(answer)
}
```

When called as an LLM tool, `githubAgent` continues the caller's conversation,
so it sees the diff and the discussion that came before it. From code, wrap
the call in `thread { ... }` to keep its messages out of the current thread.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the GitHub tools with the progress and question tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/github.agency#L42))

### githubAgent

```ts
@guarded(cost: maxCost, time: maxTime)
githubAgent(
  task: string,
  context: string = "",
  maxCost: number = $5.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  extraTools: any[] = [],
): Result<string>
```

Read or act on GitHub pull requests and issues: look up a pull request, its
  diff, checks, reviews, and comments; search, create, comment on, label, and
  close issues; post a review or a review comment. It continues your
  conversation, so it already sees the work above.

Called from code, this runs on the caller's thread like any function:
  the reads and the answer stay there, and the system prompt is removed
  when the agent finishes. Wrap the call in `thread { ... }` to keep it
  apart.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | What to look up or post, with the pull request or issue number when known. |
| context | `string` | "" | Extra material folded into the prompt, or "". |
| maxCost | `number` | $5.00 | Cost budget in USD. |
| maxTime | `number` | 10m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| extraTools | `any[]` | [] | Tools to add to the built-in GitHub tools. |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/github.agency#L73))
