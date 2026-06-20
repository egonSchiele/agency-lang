---
name: "skills"
---

# skills

## Types

## Functions

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

**Throws:** `std::skills::skillsDir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L137))

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

**Throws:** `std::skills::commandsDir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L241))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L298))
