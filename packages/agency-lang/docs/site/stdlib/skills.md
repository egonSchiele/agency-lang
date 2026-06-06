---
name: "skills"
---

# skills

## Types

## Functions

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L11))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L30))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L49))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L65))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L95))

### stripFm

```ts
stripFm(raw: string): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| raw | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L144))

### commandsDir

```ts
commandsDir(dir: string): any[]
```

Discover .md files under `dir` and parse each as a slash-command
  template. Returns [] if `dir` is missing or empty.

  @param dir - Directory containing command markdown files. Pass an
    absolute path (e.g. cwd()/.claude/commands) to anchor at the
    project root rather than the calling module's directory.

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
 *   route(..., prompt)
 * }
 * ```
 *
 * Only the `description` and `argument-hint` frontmatter fields are
 * read; all other CC fields (`allowed-tools`, `model`, `effort`,
 * `context: fork`, `disable-model-invocation`, `user-invocable`,
 * `hooks`, `paths`, `shell`, ...) are silently ignored. `commandsDir`
 * is a pure prompt-template loader, not an executor.
 *
 * Files with no frontmatter still dispatch — `description` and
 * `argHint` default to `""` (never null/undefined). Missing or empty
 * `dir` returns `[]`.
 *
 * Relative `dir` resolves against the calling module's directory.
 * For project-level commands (e.g. `.claude/commands` at the project
 * root), pass an absolute path: `"${cwd()}/.claude/commands"`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L191))

### expandSlash

```ts
expandSlash(msg: string, commands: any[]): string
```

Expand a /command in `msg` using a `commandsDir(...)` result.
  Returns the rendered command body, or `msg` unchanged if no
  command matches.

  @param msg - The raw input line (may have leading/trailing whitespace or newlines).
  @param commands - Array returned by `commandsDir(...)`.

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
 * newline) after `/<name>`. Leading and trailing whitespace on `msg`
 * are tolerated so piped invocations (`echo /foo | agency agent`,
 * yielding `"/foo\n"`) dispatch correctly.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |
| commands | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L244))
