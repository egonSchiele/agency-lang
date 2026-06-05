---
name: "skills"
---

# skills

## Types

### Command

```ts
export type Command = {
  name: string;
  description: string;
  argHint: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L27))

### CommandSet

```ts
export type CommandSet = {
  entries: Command[];
  dispatch: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L38))

### SkillEntry

```ts
type SkillEntry = {
  name: string;
  description: string;
  location: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L302))

## Functions

### splitFrontmatter

```ts
splitFrontmatter(content: string): { fm: string; body: string }
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

**Returns:** `{ fm: string; body: string }`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L52))

### tokenizeArgs

```ts
tokenizeArgs(input: string): string[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L82))

### substituteArgs

```ts
substituteArgs(body: string, rawArgs: string, tokens: string[]): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| body | `string` |  |
| rawArgs | `string` |  |
| tokens | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L126))

### commandNameFromPath

```ts
commandNameFromPath(relPath: string): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| relPath | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L150))

### loadCommand

```ts
loadCommand(relPath: string, dir: string): Result<Command>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| relPath | `string` |  |
| dir | `string` |  |

**Returns:** `Result<Command>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L173))

### dispatchOne

```ts
dispatchOne(input: string, cmd: Command): Result<string>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |
| cmd | [Command](#command) |  |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L207))

### collectCommands

```ts
collectCommands(dir: string): Command[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Command[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L220))

### dispatchCmds

```ts
dispatchCmds(cmds: Command[], input: string): Result<string>
```

* Discover slash commands under `dir` (CC-compatible layout) and
 * return a `CommandSet`. `dispatch(input)` returns
 * `success(renderedBody)` when `input` matches `/<name>` (with
 * optional args) and `failure("no-match")` otherwise.
 *
 * File layout (matches Claude Code):
 *   - `<dir>/foo.md` → `/foo`
 *   - `<dir>/<ns>/<bar>.md` → `/<ns>:<bar>` (one level of nesting only)
 *   - Both `.md` and `.markdown` extensions are recognized
 *
 * Frontmatter fields honored:
 *   - `description` — surfaced as `Command.description`
 *   - `argument-hint` — surfaced as `Command.argHint`
 *
 * Everything else CC supports (`allowed-tools`, `model`, `effort`,
 * `context: fork`, `disable-model-invocation`, `user-invocable`,
 * `hooks`, `paths`, `shell`, ...) is silently ignored in v1. The
 * command still runs with the agent's defaults.
 *
 * Body preprocessing:
 *   - `$ARGUMENTS` → the raw arg string (quotes preserved)
 *   - `$ARGUMENTS[N]` and `$N` → the Nth (1-indexed) tokenized arg
 *   - Tokenizer: whitespace splits + `"..."` grouping. No single
 *     quotes, no escapes, no env expansion. Matches CC.
 *   - If the body has no `$ARGUMENTS` ref and args were passed, the
 *     raw arg string is appended as `\n\nARGUMENTS: <raw>`.
 *
 * Notes:
 *   - `!`cmd`` shell injection, `@<path>` file refs, and
 *     `allowed-tools` pre-approval are out of scope for v1.
 *   - Files with parse failures are skipped silently (same posture
 *     as `skillsDir`).
 *   - Missing or empty `dir` → `entries: []`, `dispatch` always
 *     returns `failure("no-match")`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cmds | `Command[]` |  |
| input | `string` |  |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L279))

### commandsDir

```ts
commandsDir(dir: string): CommandSet
```

Discover CC-format slash commands in `dir` and return a CommandSet.

  @param dir - Directory containing command markdown files.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** [CommandSet](#commandset)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L289))

### xmlEscape

```ts
xmlEscape(s: string): string
```

Escape `&`, `<`, `>`, `"`, `'` so the result is safe to embed inside
  XML text or attribute values. Used before splicing frontmatter or
  filenames into the `<available_skills>` block — without this, a
  description containing `&` or a closing tag would produce malformed
  markup and could inject extra tags into the prompt.

  @param s - The string to escape.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L308))

### renderEntry

```ts
renderEntry(entry: SkillEntry): string
```

Render one SkillEntry as a `<skill>` XML block. All string fields are
  XML-escaped because they originate from user-authored frontmatter or
  filenames, and an unescaped `<` or `&` would corrupt the surrounding
  `<available_skills>` markup.

  @param entry - The skill entry to render.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| entry | [SkillEntry](#skillentry) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L327))

### flatEntry

```ts
flatEntry(filename: string, parsedFrontmatter: any): SkillEntry
```

Build a SkillEntry for one file in the legacy flat-markdown layout.
  Prefers frontmatter `name`, then `title` (so VitePress-style docs
  still work), then the filename. `description` defaults to "".

  @param filename - The skill file path, relative to the skills root.
  @param parsedFrontmatter - The parsed YAML frontmatter object from the file.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| parsedFrontmatter | `any` |  |

**Returns:** [SkillEntry](#skillentry)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L346))

### standardEntry

```ts
standardEntry(skillPath: string, parsedFrontmatter: any): SkillEntry
```

Build a SkillEntry for one skill in the standard SKILL.md layout.
  The skill name defaults to the skill's directory name when not in
  frontmatter.

  @param skillPath - [skill-dir]/SKILL.md relative to the skills root.
  @param parsedFrontmatter - The parsed YAML frontmatter object from SKILL.md.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| skillPath | `string` |  |
| parsedFrontmatter | `any` |  |

**Returns:** [SkillEntry](#skillentry)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L362))

### skillsDir

```ts
skillsDir(dir: string, layout: "flat" | "standard")
```

Build a skills tool for an LLM over a directory of skills.

  @param dir - Directory containing the skills.
  @param layout - "standard" (default) for subdirectory-per-skill with SKILL.md, "flat" for a directory of loose Markdown files.

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

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| layout | `"flat" \| "standard"` | "standard" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L392))
