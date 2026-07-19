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

## Functions

### readOnlyFileTools

```ts
readOnlyFileTools(): any[]
```

Return tools that inspect the file system without changing it: read, list,
  glob, and grep, resolved against the agent working directory.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L53))

### writableFileTools

```ts
writableFileTools(): any[]
```

Return the read-only file tools plus write and edit.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L66))

### shellTools

```ts
shellTools(): any[]
```

Return tools that run commands: bash for a shell pipeline, exec for a
  single binary with arguments.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L77))

### gitTools

```ts
gitTools(): any[]
```

Return the git tools. The read-only ones run without an approval prompt;
  the ones that change the repository prompt for approval.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L88))

### webTools

```ts
webTools(): any[]
```

Return tools that retrieve a named web resource: HTTP fetches and Wikipedia
  lookups. These retrieve something you can already name; to discover a
  source you cannot name yet, add a search tool as well.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L114))

### agencyDocTools

```ts
agencyDocTools(): any[]
```

Return the bundled Agency documentation tools: the language guide, the CLI
  reference, the type-checker diagnostic codes, and the standard-library
  reference.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L130))

### agencyCodeTools

```ts
agencyCodeTools(): any[]
```

Return tools that inspect Agency source without running it: the type
  checker and the parser.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L139))

### memoryTools

```ts
memoryTools(): any[]
```

Return tools that persist and retrieve facts across sessions.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L147))

### planningTools

```ts
planningTools(): any[]
```

Return tools an agent uses to organize a long run: a todo list, and
  saveDraft for checkpointing partial work so an aborted run still returns
  something.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/toolkits.agency#L154))
