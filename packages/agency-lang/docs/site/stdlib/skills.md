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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L4))

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
 * `skillsDir` scans `dir` for `.md` / `.markdown` files, parses each
 * file's frontmatter (looking for `title` and `description`), and
 * returns `read` partially applied with `dir: dir` and a tool
 * description that lists each skill's filename, title, and description.
 *
 * The LLM only needs to supply a `filename` argument; the description
 * tells it which filenames are available and what each one contains.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L20))
