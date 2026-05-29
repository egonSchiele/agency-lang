# skills

## Functions

### readSkills

```ts
readSkills(dir: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L8))

### xmlEscape

```ts
xmlEscape(s: string): string
```

Escape `&`, `<`, `>`, `"`, `'` so the result is safe to embed inside
  XML text or attribute values. Used before splicing frontmatter or
  filenames into the `<available_skills>` block — without this, a
  description containing `&` or a closing tag would produce malformed
  markup and could inject extra tags into the prompt.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L13))

### describeSkill

```ts
describeSkill(filename: string, fm: Result): string
```

Render one `<skill>` XML block for the skills tool description given
  a filename and the frontmatter Result returned from `frontmatter(...)`.
  Falls back gracefully when the file has no frontmatter or is missing
  one of title/description. All interpolated values are XML-escaped so
  metacharacters in user-authored titles / descriptions / filenames
  cannot break the surrounding markup.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| fm | `Result` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L30))

### skillsDir

```ts
skillsDir(dir: string)
```

Build a skills tool for an LLM. Scans `dir` for Markdown files
  (`.md` and `.markdown`), reads each one's frontmatter title and
  description, and returns the `read` function partially applied with
  `dir: dir`. The returned tool's description lists every available
  skill so the LLM knows which filename to pass.

  @param dir - Directory containing skill Markdown files

* Build a tool that lets an LLM read any Markdown skill file in `dir`.
 *
 * `skillsDir` globs `dir` for `.md` / `.markdown` files, reads each
 * one's frontmatter, and returns `read` partially applied with
 * `dir: dir` and a tool description that lists each skill's filename,
 * title, and description.
 *
 * The LLM only needs to supply a `filename` argument; the description
 * tells it which filenames are available and what each one contains.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L68))
