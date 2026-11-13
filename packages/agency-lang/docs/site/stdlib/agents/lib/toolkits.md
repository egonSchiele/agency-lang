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

No bundle has a status tool. An agent whose prompt includes
`PROGRESS_NOTE` reports progress in a sentence it writes beside each tool
call, and nothing prints that sentence by default. To show it, register an
`onLLMCallEnd` callback. `agency agent` does this in its trace.

```ts
callback("onLLMCallEnd") as data {
  const calls = data.result.toolCalls ?? []
  if (calls.length > 0 && data.result.output != null && data.result.output != "") {
    print(data.result.output)
  }
}
```

## Constants

### CODING_RULES

The opening of a system prompt for an agent that offers
`codingFileAndShellTools()`: one sentence, and a rule for each tool. The
first rule sends listing and searching to `bash`, because the bundle has no
tool for either.

```ts
/** The opening of a system prompt for an agent that offers
`codingFileAndShellTools()`: one sentence, and a rule for each tool. The
first rule sends listing and searching to `bash`, because the bundle has no
tool for either. */
export static const CODING_RULES = """You are a coding assistant. Help users inspect files, run commands, and modify code.

- Use bash for file operations like ls, grep, find.
- Use read to examine files instead of cat or sed.
- Use edit for targeted changes. Batch changes to one file in a single call.
- Use write only for new files or complete rewrites.
- Be concise in your responses.
"""
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L223))

### PROGRESS_NOTE

```ts
export static const PROGRESS_NOTE = "- When you call a tool, write one short sentence in the same response saying what you are doing. That sentence is how the user follows your progress."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L459))

### ASK_USER_HINT

```ts
export static const ASK_USER_HINT = "\n\nWhen the work turns on something only the user can tell you — which account they mean, which of two readings of the request, a value you cannot look up — ask with the `question` tool, and ask before you build on the guess rather than after. Do not ask for anything you could find yourself, and do not ask the user to narrow a scope they left broad on purpose. When nobody can answer, your question comes back rejected; when that happens, pick the most reasonable reading, say which one you picked, and carry on."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L464))

### SAVE_DRAFT_HINT

```ts
export static const SAVE_DRAFT_HINT = "\n\nIf you might run low on time or budget, call `saveDraft` with your best answer so far as you work, and update it as you improve. If the run is cut short, the last draft you saved is what the user receives — a run that saved nothing returns nothing."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L469))

## Functions

### setUserCanAnswer

```ts
setUserCanAnswer(canAnswer: boolean)
```

Say whether anyone can answer a question in this run. When false, `communicationTools()` returns no tools and `askUserHint()` returns no text.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| canAnswer | `boolean` |  | false when the run has nobody to ask, such as an unattended command-line run |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L122))

### userCanAnswer

```ts
userCanAnswer(): boolean
```

Return whether anyone can answer a question in this run. True unless a program called `setUserCanAnswer(false)`.

For code that offers its own asking tool or writes its own rule about
asking, and so cannot use `communicationTools()` or `askUserHint()`.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L133))

### communicationTools

```ts
communicationTools(): any[]
```

Return the tool that asks the user a question, or no tools when nobody can answer.

`question` raises an interrupt the host or a handler answers with a value.
Use it in hosted as well as terminal agents. Approval policy rules cannot
supply a question's reply. The list is empty after `setUserCanAnswer(false)`.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L143))

### askUserHint

```ts
askUserHint(): string
```

Return `ASK_USER_HINT`, or an empty string when nobody can answer.

Add this to the system prompt of an agent that offers
`communicationTools()`. It is built per call, not spliced into a `static`
prompt, because a program may call `setUserCanAnswer` after statics run.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L156))

### readOnlyFileTools

```ts
readOnlyFileTools(): any[]
```

Return file inspection tools rooted in the agent's working directory.

ls, glob, and grep always respect `.gitignore`. The setting is bound so
the model cannot include ignored files by changing an argument. The model can
still search an ignored folder by naming it as the folder to search.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L169))

### writableFileTools

```ts
writableFileTools(): any[]
```

Return file inspection, write, and edit tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L186))

### shellTools

```ts
shellTools(): any[]
```

Return command execution and saved-output readers for the agent's working directory.

`safeBash` parses pipelines and raises effects for recognized operations.
`exec` runs one binary with arguments. Both use the agent's working directory.
The saved-output readers retrieve output too large to return inline.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L205))

### codingFileAndShellTools

```ts
codingFileAndShellTools(): any[]
```

Return the file and shell tools for a coding agent.

The six tools a model needs to work on code: `read`, `bash`, `edit`,
`write`, and the two readers for output too long to return inline,
`readSpill` and `grepSpill`. Three are shaped for a model: `read` returns
at most 2,000 lines when the model gives no limit, `write` always
overwrites, and `safeBash` is offered as `bash` with its `cwd` bound to the
agent's working directory. There is no `ls`, `glob`, `grep`, or `exec`:
`bash` does the listing, searching, and running, and every tool definition
is sent with every request. An agent that uses this bundle tells the model
so with `CODING_RULES`.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L276))

### jobTools

```ts
jobTools(): any[]
```

Return the tools for running a shell command as a background job.

Start a shell command in the background, read its output, and stop it.
Not part of `shellTools()`: an agent that exits when its turn ends would
stop its jobs before they finish.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L292))

### spillTools

```ts
spillTools(): any[]
```

Return tools for reading and searching saved tool output.

Add these when an agent enables `spillToolResultsOver`, so it can retrieve
long tool results. `shellTools` already includes them.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L301))

### readOnlyGitTools

```ts
readOnlyGitTools(): any[]
```

Return Git repository inspection tools.

Use `gitIsRepo` to detect a repository from a package subdirectory.
Git finds the repository root even when `.git` is in a parent directory.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L310))

### gitTools

```ts
gitTools(): any[]
```

Return Git repository inspection and modification tools.

Repository modifications raise approval interrupts. The inspection tools
are also available separately from `readOnlyGitTools`.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L329))

### githubReadTools

```ts
githubReadTools(): any[]
```

Return tools for reading GitHub pull requests, issues, and their comments.

The tools resolve the repository from the origin remote under the agent's
working directory. They read remote data and cannot post reviews or comments.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L349))

### githubTools

```ts
githubTools(): any[]
```

Return GitHub lookup, review, comment, and issue-management tools.

Each remote write raises an approval interrupt. Pull-request approval
has its own effect, so policies can permit comments while refusing approvals.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L370))

### fetchTools

```ts
fetchTools(): any[]
```

Return the HTTP tool, which returns HTML as Markdown and other bodies as received.

For an agent that reads a page it was given the address of, and does
not look things up. `webTools()` is this plus the Wikipedia tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L394))

### webTools

```ts
webTools(): any[]
```

Return HTTP and Wikipedia lookup tools for named sources.

Add search tools when an agent must discover sources before fetching them.
The HTTP tool returns HTML as Markdown and other bodies as received.
Its `refresh` argument is bound to false to reuse a page within a conversation.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L404))

### agencyDocTools

```ts
agencyDocTools(): any[]
```

Return the five packaged Agency documentation tools.

The bundles cover the guide, CLI, diagnostics, stdlib, and agent docs.
Reads through these tools still raise `std::read`.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L418))

### agencyDocToolsBrief

```ts
agencyDocToolsBrief(): any[]
```

Return packaged documentation tools with compact page listings.

Use compact listings when the prompt already teaches the language.
Offer this bundle or `agencyDocTools`: both use the same tool names.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L427))

### agencyCodeTools

```ts
agencyCodeTools(): any[]
```

Return Agency parsing, typechecking, and test-harness tools.

`testFile` runs a saved `.test.json` harness in a subprocess.
Use parse and typecheck for source text that has not been saved.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L442))

### memoryTools

```ts
memoryTools(): any[]
```

Return fact storage and retrieval tools for enabled memory.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L449))

### draftTools

```ts
draftTools(offer: boolean): any[]
```

Return the `saveDraft` tool, or no tools when `offer` is false.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| offer | `boolean` |  | Whether a caller reads the agent's draft when its budget runs out. |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L474))
