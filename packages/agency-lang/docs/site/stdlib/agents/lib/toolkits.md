---
name: "toolkits"
description: "Compose agents from named bundles of file, web, GitHub, and other tools."
---

# toolkits

Build an agent's tool list by combining the bundles it needs. Construct
lists inside a function when they include `searchTools`, so API-key
selection happens at call time. Bundle membership describes the tools
available; the caller's handlers still decide their interrupts.

```ts
import { readOnlyFileTools, communicationTools } from "std::agents/lib/toolkits"

node main() {
  const tools = [...readOnlyFileTools(), ...communicationTools()]
  const answer: string = llm("Summarize README.md", { tools: tools })
  print(answer)
}
```

## Constants

### ASK_USER_HINT

```ts
export static const ASK_USER_HINT = "\n\nWhen the work turns on something only the user can tell you — which account they mean, which of two readings of the request, a value you cannot look up — ask with the `question` tool, and ask before you build on the guess rather than after. Do not ask for anything you could find yourself, and do not ask the user to narrow a scope they left broad on purpose. When nobody can answer, your question comes back rejected; when that happens, pick the most reasonable reading, say which one you picked, and carry on."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L321))

### SAVE_DRAFT_HINT

```ts
export static const SAVE_DRAFT_HINT = "\n\nIf you might run low on time or budget, call `saveDraft` with your best answer so far as you work, and update it as you improve. If the run is cut short, the last draft you saved is what the user receives — a run that saved nothing returns nothing."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L326))

## Functions

### whatIAmDoing

```ts
whatIAmDoing(message: string): string
```

Tell the user what you are doing. Use this tool often to update the user on what you're up to.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L102))

### communicationTools

```ts
communicationTools(): any[]
```

Return progress-reporting and user-question tools.

`question` raises an interrupt the host or a handler answers with a value.
Use it in hosted as well as terminal agents. Approval policy rules cannot
supply a question's reply.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L113))

### readOnlyFileTools

```ts
readOnlyFileTools(): any[]
```

Return file inspection tools rooted in the agent's working directory.

The grep tool always respects `.gitignore`. The setting is bound so the
model cannot include ignored files by changing an argument.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L122))

### writableFileTools

```ts
writableFileTools(): any[]
```

Return file inspection, write, and edit tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L134))

### shellTools

```ts
shellTools(): any[]
```

Return command execution and saved-output readers for the agent's working directory.

`safeBash` parses pipelines and raises effects for recognized operations.
`exec` runs one binary with arguments. Both use the agent's working directory.
The saved-output readers retrieve output too large to return inline.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L153))

### spillTools

```ts
spillTools(): any[]
```

Return tools for reading and searching saved tool output.

Add these when an agent enables `spillToolResultsOver`, so it can retrieve
long tool results. `shellTools` already includes them.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L162))

### readOnlyGitTools

```ts
readOnlyGitTools(): any[]
```

Return Git repository inspection tools.

Use `gitIsRepo` to detect a repository from a package subdirectory.
Git finds the repository root even when `.git` is in a parent directory.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L171))

### gitTools

```ts
gitTools(): any[]
```

Return Git repository inspection and modification tools.

Repository modifications raise approval interrupts. The inspection tools
are also available separately from `readOnlyGitTools`.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L190))

### githubReadTools

```ts
githubReadTools(): any[]
```

Return tools for reading GitHub pull requests, issues, and their comments.

The tools resolve the repository from the origin remote under the agent's
working directory. They read remote data and cannot post reviews or comments.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L210))

### githubTools

```ts
githubTools(): any[]
```

Return GitHub lookup, review, comment, and issue-management tools.

Each remote write raises an approval interrupt. Pull-request approval
has its own effect, so policies can permit comments while refusing approvals.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L231))

### webTools

```ts
webTools(): any[]
```

Return HTTP and Wikipedia lookup tools for named sources.

Add search tools when an agent must discover sources before fetching them.
The HTTP tool returns HTML as Markdown and other bodies as received.
Its `refresh` argument is bound to false to reuse a page within a conversation.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L256))

### agencyDocTools

```ts
agencyDocTools(): any[]
```

Return the five packaged Agency documentation tools.

The bundles cover the guide, CLI, diagnostics, stdlib, and agent docs.
Reads through these tools still raise `std::read`.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L270))

### agencyDocToolsBrief

```ts
agencyDocToolsBrief(): any[]
```

Return packaged documentation tools with compact page listings.

Use compact listings when the prompt already teaches the language.
Offer this bundle or `agencyDocTools`: both use the same tool names.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L279))

### agencyCodeTools

```ts
agencyCodeTools(): any[]
```

Return Agency parsing, typechecking, and test-harness tools.

`testFile` runs a saved `.test.json` harness in a subprocess.
Use parse and typecheck for source text that has not been saved.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L294))

### memoryTools

```ts
memoryTools(): any[]
```

Return fact storage and retrieval tools for enabled memory.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L301))

### planningTools

```ts
planningTools(): any[]
```

Return tools for replacing and reading the agent's todo list.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L311))
