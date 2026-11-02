---
name: "skills"
description: "Load, save, and draft skill files for LLMs, and expand slash-command templates."
---

# skills

```ts
  import { skillsDir } from "std::skills"

  node main(request: string) {
    const skills = skillsDir("${cwd()}/skills") with approve
    const reply: string = llm(request, { tools: [skills] })
    print(reply)
  }
  ```

  Put each skill in `skills/<name>/SKILL.md` with `name` and `description`
  frontmatter. The tool lists the skills and lets the model read them on
  demand. Reads through the tool still need approval. Use the `"flat"`
  layout for loose Markdown files, including skills saved by `writeSkill`.
  Use `designSkill` when the user should review and revise a draft first.

  ```ts
  import { commandsDir, expandSlash } from "std::skills"

  static const commands = commandsDir("${cwd()}/.claude/commands") with approve

  node main(message: string) {
    const reply: string = llm(expandSlash(message, commands))
    print(reply)
  }
  ```

  A command file supplies the prompt for `/name`. Put `$ARGUMENTS` in its
  body where the user's arguments should appear.

## Types

### SkillEntry

A skill listing entry whose `location` is relative to its scanned directory.

```ts
/** A skill listing entry whose `location` is relative to its scanned directory. */
export type SkillEntry = {
  name: string;
  description: string;
  location: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L64))

### SkillGroup

Pass a group's `dir` and `entries` together to `skillsToolFromEntries`.

```ts
/** Pass a group's `dir` and `entries` together to `skillsToolFromEntries`. */
export type SkillGroup = {
  dir: string;
  entries: SkillEntry[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L339))

### SkillCommand

A prompt template from `commandsDir` or `scanClaudeSkills` for `expandSlash`.

```ts
/** A prompt template from `commandsDir` or `scanClaudeSkills` for `expandSlash`. */
export type SkillCommand = {
  name: string;
  description: string;
  argHint: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L391))

### ClaudeSkillsScan

Use `names` when merging folders by precedence: it includes accepted names
before the model and user invocation switches filter `entries` and `commands`.
A manual-only skill can therefore hide a model-invocable skill in another folder.

```ts
/**
Use `names` when merging folders by precedence: it includes accepted names
before the model and user invocation switches filter `entries` and `commands`.
A manual-only skill can therefore hide a model-invocable skill in another folder.
*/
export type ClaudeSkillsScan = {
  dir: string;
  names: string[];
  entries: SkillEntry[];
  commands: SkillCommand[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L403))

## Effects

### std::skills::skillsDir

```ts
@alwaysUnder(dir)
effect std::skills::skillsDir {
  dir: string;
  layout: "flat" | "standard"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L196))

### std::skills::commandsDir

```ts
@alwaysUnder(dir)
effect std::skills::commandsDir {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L201))

### std::skills::save

```ts
@alwaysUnder(dir)
effect std::skills::save {
  dir: string;
  name: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L544))

### std::skills::review

```ts
effect std::skills::review {
  dir: string;
  name: string;
  description: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L638))

## Constants

### MAX_TOOL_NAME_LEN

Maximum length of a generated tool name or a newly saved skill name.

```ts
/** Maximum length of a generated tool name or a newly saved skill name. */
export static const MAX_TOOL_NAME_LEN = 64
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L115))

## Functions

### skillsToolFromEntries

```ts
skillsToolFromEntries(
  dir: string,
  entries: SkillEntry[],
  name: string = "",
  brief: boolean = false,
)
```

Build a skills tool from entries scanned from the same directory.

Use cached scan results to build a skills tool without reading the directory
again. Choose `brief` for large catalogs to reduce the listing sent on each
model call. Each later read through the tool requires approval.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | The scanned directory, or the group's own `dir` for scanSkillsSubdirs results. |
| entries | `SkillEntry[]` |  |  |
| name | `string` | "" | Override the directory-derived tool name, with punctuation replaced by underscores and a 64-character limit. |
| brief | `boolean` | false | List each file as one `path - description` line instead of XML. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L210))

### skillsDir

```ts
skillsDir(
  dir: string,
  layout: "flat" | "standard" = "standard",
  name: string = "",
)
```

Build a tool that lets an LLM list and read skills from a directory.

Use this to give a model access to skills without loading every body into
its prompt. The tool description lists each skill's name, description, and
location. The model passes a listed location as `filename` to read it.

Standard skills use `<name>/SKILL.md` with `name` and `description`
frontmatter. A missing or empty name defaults to the directory name.
Skills with `disable-model-invocation: true` stay out of this listing.
Flat skills use loose `.md` or `.markdown` files with a frontmatter
`name` or `title`, falling back to the filename.

Set an explicit tool name for stable naming across machines, or when two
directory-derived names collide after sanitizing and shortening them.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  |  |
| layout | `"flat" \| "standard"` | "standard" | Use "standard" for `<name>/SKILL.md` or "flat" for loose Markdown files. |
| name | `string` | "" | Override the directory-derived tool name, with punctuation replaced by underscores and a 64-character limit. |

**Throws:** `std::skills::skillsDir`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L318))

### scanSkillsSubdirs

```ts
scanSkillsSubdirs(
  root: string,
  subdirs: string[],
): Result<Record<string, SkillGroup>> raises <std::skills::skillsDir>
```

Scan direct subdirectories for flat-layout skills and group them by name.

Use this when several agents keep flat-layout skills in separate directories
under one root. Build each agent's tool from its group's `dir` and `entries`.
Every requested subdirectory gets a group, including empty or missing ones.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| root | `string` |  | The nonempty directory holding the agents' skills directories. |
| subdirs | `string[]` |  | Bare directory names, excluding empty names, `.`, `..`, and path separators. |

**Returns:** `Result<Record<string, SkillGroup>>`

**Throws:** `std::skills::skillsDir`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L350))

### scanClaudeSkills

```ts
scanClaudeSkills(
  dir: string,
): Result<ClaudeSkillsScan> raises <std::skills::skillsDir>
```

Scan a Claude Code skills folder for model-readable skills and slash commands.

Use this when one Claude Code skills folder supplies both an LLM skills
listing and user slash commands. `disable-model-invocation: true` hides a
skill from `entries`. `user-invocable: false` hides it from `commands`.
Spaces in accepted names become dashes. Reserved or invalid names are skipped.

Command bodies include their base directory and replace `${CLAUDE_SKILL_DIR}`
with that path. Other execution settings, such as `allowed-tools`, are ignored.
The folder's scan approval covers both outputs, so reject
`std::skills::skillsDir` to prevent this scan's command loading.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | The folder containing `<name>/SKILL.md` files. |

**Returns:** `Result<ClaudeSkillsScan>`

**Throws:** `std::skills::skillsDir`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L493))

### writeSkill

```ts
writeSkill(
  dir: string,
  name: string,
  description: string,
  body: string,
): Result<SkillEntry> raises <std::skills::save, std::mkdir, std::write>
```

Save a new skill after approval without overwriting an existing file.
  Use designSkill if the user should review and revise a draft first.

Use this when you already have a finished skill. It creates `<name>.md` in
the flat layout, with name and description frontmatter followed by the body.
It refuses to overwrite an existing file.

The save request shows the complete file. Approval data does not revise it.
The directory creation and file write require their own approvals after the
save approval. Use `designSkill` to collect feedback before saving.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | The nonempty skills directory to write into. |
| name | `string` |  | An unused name of at most 64 characters, using lowercase letters and digits separated by single hyphens. |
| description | `string` |  | One line telling the reading agent when to use the skill. |
| body | `string` |  | The skill's Markdown instructions. |

**Returns:** `Result<SkillEntry>`

**Throws:** `std::skills::save`, `std::mkdir`, `std::write`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L599))

### designSkill

```ts
designSkill(
  dir: string,
  name: string,
  description: string,
  body: string,
  maxRounds: number = 3,
  model: string = "",
  provider: string = "",
): Result<SkillEntry> raises <std::skills::review, std::skills::save, std::mkdir, std::write>
```

Show a draft skill to the user, revise it on their feedback, and save it
  once they accept.

Give this tool to a model that can write the first draft from the conversation.
The user sees that draft before any revision call. A bare approval or `accept`
accepts it; other nonempty text asks the model to revise the description and body.
The name stays fixed.

Each revised draft gets another review, up to `maxRounds` reviews in total.
Acceptance calls `writeSkill`, which still asks for save and file-operation
approvals. Accepting the first draft makes no revision model call.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | The nonempty skills directory to write into. |
| name | `string` |  | An unused name of at most 64 characters, using lowercase letters and digits separated by single hyphens. |
| description | `string` |  | One line telling the reading agent when to use the skill. |
| body | `string` |  | The first draft of the skill's Markdown instructions. |
| maxRounds | `number` | 3 | Maximum number of reviews before returning a failure. |
| model | `string` | "" | Model to use for revisions, or "" for the configured model. |
| provider | `string` | "" | Provider for the model override, ignored when model is "". |

**Returns:** `Result<SkillEntry>`

**Throws:** `std::skills::review`, `std::skills::save`, `std::mkdir`, `std::write`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L746))

### docsEntries

```ts
docsEntries(section: DocsSection): SkillEntry[]
```

List the pages in one section of the packaged Agency documentation.

Scan once, then pass the entries to `docsToolFromEntries` to build both full
and brief listings without rereading the packaged documentation.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| section | `DocsSection` |  |

**Returns:** `SkillEntry[]`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L791))

### docsToolFromEntries

```ts
docsToolFromEntries(
  section: DocsSection,
  entries: SkillEntry[],
  brief: boolean = false,
)
```

Build a documentation tool from pages listed by docsEntries.

Reuse one scan to prepare full and brief docs tools for different context sizes.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| section | `DocsSection` |  | The section used to obtain the entries. |
| entries | `SkillEntry[]` |  |  |
| brief | `boolean` | false | List each page as one `path - description` line. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L800))

### docsSkill

```ts
docsSkill(section: DocsSection, brief: boolean = false)
```

Build a tool that lets an LLM read a section of the packaged Agency docs.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| section | `DocsSection` |  |  |
| brief | `boolean` | false | List each page as one `path - description` line. |

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L816))

### bundledDocsDir

```ts
bundledDocsDir(): string
```

Return the directory containing the packaged Agency documentation.

Use this directory to scope a handler or policy that approves packaged docs reads.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L826))

### agentSkill

```ts
agentSkill(agent: string)
```

Build a tool that lets an LLM list and read an agent's packaged skills.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| agent | `string` |  | The agent's path under the packaged skills directory. |

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L834))

### agentPrompt

```ts
agentPrompt(filename: string): Result<string>
```

Read a prompt file packaged with the stdlib agents.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | The prompt's path relative to the packaged prompts directory. |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L847))

### commandsDir

```ts
commandsDir(dir: string): SkillCommand[]
```

Load slash-command templates from Markdown files directly under a directory.
  Returns an empty list when the directory is missing or has no command files.

Load `.claude/commands` prompt templates for use with `expandSlash` before
calling an LLM. Each loose `.md` filename supplies the command name.
The optional `description` and `argument-hint` frontmatter fields default
to empty strings. Files without frontmatter also work.

Relative directories resolve against the working directory. Use a path under
`__dirname` for commands beside the Agency file, or `${cwd()}/.claude/commands`
for commands in the launch directory.

Only the template body, description, and argument hint are used. Fields such
as `allowed-tools` and `model` do not grant permissions or configure execution.
Use `scanClaudeSkills` for the invocation switches in Claude Code SKILL.md files.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `SkillCommand[]`

**Throws:** `std::skills::commandsDir`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L896))

### expandSlash

```ts
expandSlash(msg: string, commands: SkillCommand[]): string
```

Expand a slash command into its prompt template, substituting $ARGUMENTS.
  Return the original message when no command matches.

```ts
const prompt = expandSlash("/review src/main.ts", commands)
```

Use the expanded prompt as the user's LLM message. The first command with
a matching name supplies its body. `$ARGUMENTS` becomes the trimmed text
after the command name. If the body has no token, extra arguments appear
at the end as `ARGUMENTS: <text>`.

Leading and trailing whitespace do not affect command matching. Unknown
commands and messages without a slash pass through unchanged. Expansion
only substitutes `$ARGUMENTS`; it runs no shell commands and ignores
`$1`-style references.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| msg | `string` |  |  |
| commands | `SkillCommand[]` |  | Templates from commandsDir or scanClaudeSkills, with the first matching name taking precedence. |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L941))
