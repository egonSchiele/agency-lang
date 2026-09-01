---
name: "skills"
description: "Give an LLM access to a directory of skills, and support Claude-Code-style slash commands."
---

# skills

Give an LLM access to a directory of skills, and support Claude-Code-style
  slash commands. `skillsDir` builds a tool that lets the model read skill
  files on demand. `commandsDir` and `expandSlash` load prompt-template
  commands and expand a user's `/command` into its body.

  ```ts
  import { skillsDir, commandsDir, expandSlash } from "std::skills"

  static const commands = commandsDir("${cwd()}/.claude/commands") with approve

  node main(msg: string) {
    const prompt = expandSlash(msg, commands)
    let reply: string = llm(prompt, { tools: [skillsDir("${cwd()}/skills")] })
  }
  ```

## Types

### SkillEntry

```ts
export type SkillEntry = {
  name: string;
  description: string;
  location: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L39))

### SkillReview

The value a handler passes to approve() for std::skills::reviewSkill.
  A bare approve() counts as accept.

```ts
/** The value a handler passes to approve() for std::skills::reviewSkill.
  A bare approve() counts as accept. */
export type SkillReview =
  | { verdict: "accept" }
  | { verdict: "revise"; feedback: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L345))

### WriteSkillOutcome

```ts
export type WriteSkillOutcome = { saved: SkillEntry } | { revise: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L349))

## Effects

### std::skills::skillsDir

* Build a tool that lets an LLM read skill files in `dir`. Supports two
 * layouts:
 *   - "standard" (default): each subdirectory of `dir` is one skill
 *     with a `SKILL.md` entrypoint. Frontmatter `name` / `description`
 *     are read; `name` defaults to the subdirectory name.
 *   - "flat": each `.md` / `.markdown` file directly under `dir` is one
 *     skill. Frontmatter `name` (or `title`) and `description` are read.
 *
 * The returned tool is `read` partially applied with `dir: dir`. Its
 * description lists every available skill so the LLM knows which
 * `location` to pass back as `filename`.

```ts
/**
 * Build a tool that lets an LLM read skill files in `dir`. Supports two
 * layouts:
 *   - "standard" (default): each subdirectory of `dir` is one skill
 *     with a `SKILL.md` entrypoint. Frontmatter `name` / `description`
 *     are read; `name` defaults to the subdirectory name.
 *   - "flat": each `.md` / `.markdown` file directly under `dir` is one
 *     skill. Frontmatter `name` (or `title`) and `description` are read.
 *
 * The returned tool is `read` partially applied with `dir: dir`. Its
 * description lists every available skill so the LLM knows which
 * `location` to pass back as `filename`.
 */
@alwaysUnder(dir)
effect std::skills::skillsDir {
  dir: string;
  layout: "flat" | "standard"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L194))

### std::skills::commandsDir

```ts
@alwaysUnder(dir)
effect std::skills::commandsDir {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L199))

### std::skills::reviewSkill

```ts
@alwaysUnder(dir)
effect std::skills::reviewSkill {
  dir: string;
  name: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L337))

## Constants

### MAX_TOOL_NAME_LEN

```ts
export static const MAX_TOOL_NAME_LEN = 64
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L103))

## Functions

### skillsToolFromEntries

```ts
skillsToolFromEntries(dir: string, entries: SkillEntry[], name: string = "")
```

Build the skills tool for `dir` from already-scanned entries. Pure: no
  reads, no interrupts. Callers that already hold a directory's entries
  (a catalog updated after a save) use this to rebuild the tool without
  rescanning.

  @param dir - The directory the tool will read skills from
  @param entries - The skills to list in the tool description
  @param name - Optional explicit tool name. Sanitized to alphanumerics/underscores and capped at 64 characters; defaults to a name derived from `dir`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| entries | `SkillEntry[]` |  |
| name | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L203))

### skillsDir

```ts
skillsDir(
  dir: string,
  layout: "flat" | "standard" = "standard",
  name: string = "",
)
```

Build a skills tool for an LLM over a directory of skills.

  @param dir - Directory containing the skills.
  @param layout - "standard" (default) for subdirectory-per-skill with SKILL.md, "flat" for a directory of loose Markdown files.
  @param name - Optional explicit tool name. Sanitized to alphanumerics/underscores and capped at 64 characters. Defaults to a name derived from `dir`; set this to override it — e.g. for a stable, readable name, or to disambiguate two tools whose derived names would collide.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| layout | `"flat" \| "standard"` | "standard" |
| name | `string` | "" |

**Throws:** `std::skills::skillsDir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L276))

### scanSkillsSubdirs

```ts
scanSkillsSubdirs(root: string, subdirs: string[]): Record<string, SkillEntry[]>
```

Scan named subdirectories of a root, each holding one agent's
  flat-layout skills. Raises one `std::skills::skillsDir` interrupt for
  the root; its approval covers the reads. Each subdirectory gets its
  own MAX_SKILL_FILES scan; one with no markdown files (or that does not
  exist) yields no entry. Taking the names as a parameter keeps the
  record's keys caller-chosen data, never something read off the disk.

  @param root - The directory holding the subdirectories
  @param subdirs - The subdirectory names to scan

**Parameters:**

| Name | Type | Default |
|---|---|---|
| root | `string` |  |
| subdirs | `string[]` |  |

**Returns:** `Record<string, SkillEntry[]>`

**Throws:** `std::skills::skillsDir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L296))

### writeSkill

```ts
writeSkill(
  dir: string,
  name: string,
  description: string,
  body: string,
): Result<WriteSkillOutcome>
```

Save a skill file into a skills directory, after the user reviews it.
  Composes the flat-layout markdown (frontmatter with name and
  description, then the body), raises a `std::skills::reviewSkill`
  interrupt showing the complete file, and only writes on acceptance. A
  "revise" review returns the feedback instead of writing, so the caller
  can redraft. A rejected interrupt fails the call.

  @param dir - The skills directory to write into
  @param name - The skill's name; also its filename. Lowercase letters, digits, and hyphens.
  @param description - One line telling the reading agent when to use the skill
  @param body - The skill's markdown body

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| name | `string` |  |
| description | `string` |  |
| body | `string` |  |

**Returns:** `Result<WriteSkillOutcome>`

**Throws:** `std::skills::reviewSkill`, `std::mkdir`, `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L379))

### docsSkill

```ts
docsSkill(
  section: 
  | "guide"
  | "cli"
  | "diagnostics"
  | "stdlib"
  | "agent",
)
```

Build a docs tool for an LLM over the packaged Agency documentation.

  @param section - Which documentation set to serve

**Parameters:**

| Name | Type | Default |
|---|---|---|
| section | `\| "guide" \| "cli" \| "diagnostics" \| "stdlib" \| "agent"` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L441))

### bundledDocsDir

```ts
bundledDocsDir(): string
```

The directory holding the Agency docs that ship inside the package. A
  handler can approve reads under it and still reject everything else.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L462))

### agentSkill

```ts
agentSkill(agent: string)
```

Build a skills tool over the skills shipped for one agent. The returned
  tool lists every skill in its description and lets the model read any one
  on demand.

  @param agent - Which agent's skills to serve, as a path under the shipped skills directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| agent | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L470))

### commandsDir

```ts
commandsDir(dir: string): any[]
```

Discover .md files under `dir` and parse each as a slash-command
  template. Returns [] if `dir` is missing or empty.

  @param dir - Directory containing command markdown files.

* Discover Claude-Code-format slash commands under `dir`. Each `.md`
 * file becomes one command record `{ name, description, argHint, body }`.
 *
 * Pair with `expandSlash(msg, commands)` in your agent's per-turn
 * handler:
 *
 * ```ts
 * static const commands = commandsDir("${cwd()}/.claude/commands") with approve
 * def _runTurn(msg: string) {
 *   const prompt = expandSlash(msg, commands)
 *   const reply = llm(prompt, { tools })
 * }
 * ```
 *
 * `commandsDir` reads only the `description` and `argument-hint`
 * frontmatter fields. It silently ignores all other CC fields
 * (`allowed-tools`, `model`, `effort`, `context: fork`,
 * `disable-model-invocation`, `user-invocable`, `hooks`, `paths`,
 * `shell`, ...). `commandsDir` is a pure prompt-template loader, not an
 * executor.
 *
 * Files with no frontmatter still dispatch. `description` and
 * `argHint` default to `""` (never null/undefined). Missing or empty
 * `dir` returns `[]`.
 *
 * Relative `dir` resolves against the current working directory;
 * pass `__dirname` for a directory relative to the current Agency file.
 * For project-level commands (e.g. `.claude/commands` at the project
 * root), pass an absolute path: `"${cwd()}/.claude/commands"`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `any[]`

**Throws:** `std::skills::commandsDir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L558))

### expandSlash

```ts
expandSlash(msg: string, commands: any[]): string
```

Expand a /command in `msg` into its command body. Returns the rendered
  body with $ARGUMENTS substituted, or `msg` unchanged if no command matches.

  @param msg - The raw input line (may have leading/trailing whitespace or newlines).
  @param commands - Array of command records to match against.

* Expand a user-typed slash command against a `commandsDir` result.
 *
 * - If `msg` (after trimming) matches `/<name>` with optional
 *   whitespace + args, returns the rendered command body with
 *   `$ARGUMENTS` substituted.
 * - If the body has no `$ARGUMENTS` token and args were passed,
 *   appends `\n\nARGUMENTS: <raw>` so the LLM still sees the input
 *   (matches Claude Code).
 * - Otherwise returns `msg` unchanged — unknown `/foo` inputs fall
 *   through to the LLM as plain text, again matching CC.
 *
 * Args are split off at the first whitespace (space, tab, or
 * newline) after `/<name>`. `expandSlash` tolerates leading and
 * trailing whitespace on `msg`, so piped invocations (`echo /foo |
 * agency agent`, yielding `"/foo\n"`) dispatch correctly.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |
| commands | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L613))
