---
name: "skills"
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
effect std::skills::skillsDir {
  dir: string;
  layout: "flat" | "standard"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L184))

### std::skills::commandsDir

```ts
effect std::skills::commandsDir {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L185))

## Functions

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L223))

### docsSkill

```ts
docsSkill(section: "guide" | "cli" | "diagnostics")
```

Build a docs tool for an LLM over the packaged Agency documentation.
  "guide" serves the language guide (syntax, types, control flow);
  "cli" serves the CLI reference; "diagnostics" serves the type-checker
  diagnostic codes (AG####) with explanations and fixes. The returned tool
  lists every page in its description and lets the model read any one on
  demand.

  @param section - Which documentation set to serve: "guide", "cli", or "diagnostics".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| section | `"guide" \| "cli" \| "diagnostics"` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L239))

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
 * Relative `dir` resolves against the calling module's directory.
 * For project-level commands (e.g. `.claude/commands` at the project
 * root), pass an absolute path: `"${cwd()}/.claude/commands"`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `any[]`

**Throws:** `std::skills::commandsDir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L325))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L382))
