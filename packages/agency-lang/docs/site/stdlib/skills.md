---
name: "skills"
---

# skills

## Types

### SkillEntry

```ts
type SkillEntry = {
  name: string;
  description: string;
  location: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/skills.agency#L5))

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
