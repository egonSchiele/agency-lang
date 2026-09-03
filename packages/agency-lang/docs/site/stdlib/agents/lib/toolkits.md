---
name: "toolkits"
description: "Named bundles of tools that agents compose into their tool lists."
---

# toolkits

An agent's tool list should read as a description of what that agent may
  do. Bundling also means a tool added to a category reaches every agent that
  claimed the category, instead of drifting between hand-maintained arrays.

  Every bundle is a function rather than a constant, matching searchTools() in
  std::agents/lib/search, which must be a function because it reads API keys
  at call time. An agent whose list includes searchTools() must build that
  list inside a function too, or it freezes the environment at module load.

## Constants

### SAVE_DRAFT_HINT

```ts
export static const SAVE_DRAFT_HINT = "\n\nIf you might run low on time or budget, call `saveDraft` with your best answer so far as you work, and update it as you improve. If the run is cut short, the last draft you saved is what the user receives — a run that saved nothing returns nothing."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L207))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L56))

### communicationTools

```ts
communicationTools(): any[]
```

Return tools that help the agent communicate with the user.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L64))

### readOnlyFileTools

```ts
readOnlyFileTools(): any[]
```

Return tools that inspect the file system without changing it: read, list,
  glob, and grep, resolved against the agent working directory.

  grep honours .gitignore, and the setting is locked by partial application
  so the model cannot turn it off and search generated files.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L71))

### writableFileTools

```ts
writableFileTools(): any[]
```

Return the read-only file tools plus write and edit.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L87))

### shellTools

```ts
shellTools(): any[]
```

Return tools that run commands: safeBash for a shell pipeline, exec for
  a single binary with arguments. safeBash rather than raw bash: it
  parses the command and raises the narrowest effects that describe it
  (a recognized write raises std::write, a git read raises its git
  effect), so a policy can pre-approve what raw bash never could. It
  needs no useAgentCwd binding — its empty cwd already resolves to the
  agent working directory (resolveCwd in std::safeBash).

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L98))

### readOnlyGitTools

```ts
readOnlyGitTools(): any[]
```

Return the read-only git tools: history, diffs, status, branches. Nothing
  here changes the repository, so read-only agents (verifiers, reviewers,
  writers with read-only project access) can carry them. gitIsRepo is
  included because "am I inside a repo?" is the question an agent otherwise
  answers by probing for a `.git` directory by hand — which fails in a
  monorepo, where `.git` lives above the package directory (git itself
  walks up; a manual probe does not).

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L111))

### gitTools

```ts
gitTools(): any[]
```

Return the git tools. The read-only ones run without an approval prompt;
  the ones that change the repository prompt for approval.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L134))

### webTools

```ts
webTools(): any[]
```

Return tools that retrieve a named web resource: HTTP fetches and Wikipedia
  lookups. These retrieve something you can already name; to discover a
  source you cannot name yet, add a search tool as well.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L153))

### agencyDocTools

```ts
agencyDocTools(): any[]
```

Return the bundled Agency documentation tools: the language guide, the CLI
  reference, the type-checker diagnostic codes, and the standard-library
  reference.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L169))

### agencyCodeTools

```ts
agencyCodeTools(): any[]
```

Return tools for checking Agency source: the type checker, the parser,
  and testFile, which runs a .test.json harness in a sandboxed subprocess.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L178))

### memoryTools

```ts
memoryTools(): any[]
```

Return tools that persist and retrieve facts across sessions.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L186))

### planningTools

```ts
planningTools(): any[]
```

Return tools an agent uses to organize a long run: writing and reading a
  todo list.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L196))
