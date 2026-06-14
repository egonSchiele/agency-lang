---
name: "syntax"
---

# syntax

## Types

### HighlightMode

```ts
export type HighlightMode = "shell" | "web"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L7))

## Functions

### highlight

```ts
highlight(code: string, language: string, mode: HighlightMode): string
```

A tool for syntax highlighting code snippets. Specify the programming language for accurate highlighting (e.g., "javascript", "python", "json"). Defaults to plain text if no language is provided.

  @param code - The code snippet to highlight
  @param language - The programming language of the code (optional, defaults to "plaintext")
  @param mode - The output format for the highlighted code: "shell" for terminal output

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |
| language | `string` | "plaintext" |
| mode | [HighlightMode](#highlightmode) | "shell" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L9))

### diff

```ts
diff(oldText: string, newText: string, context: number, lineNumbers: boolean, color: "auto" | boolean, oldLabel: string, newLabel: string, ignoreWhitespace: boolean, hunkHeaders: boolean, summary: boolean): string
```

Produce a human-readable diff of two strings and return it as a string.
  Shows the full text by default with changed words highlighted via `-`/`+`
  lines.

  @param oldText - The original text
  @param newText - The updated text
  @param context - Unchanged lines to keep around each change; -1 means show the full text
  @param lineNumbers - Prefix each line with its line number
  @param color - `"auto"` (default) emits ANSI colors only when stdout is a TTY; `true` always; `false` never. Coloring highlights deletions in red and insertions in green inline.
  @param oldLabel - When non-empty, render a `--- <oldLabel>` header
  @param newLabel - When non-empty, render a `+++ <newLabel>` header
  @param ignoreWhitespace - Treat whitespace-only changes as equal
  @param hunkHeaders - Emit `@@ -l,c +l,c @@` separators between change regions
  @param summary - Prefix the diff with an "N insertions, M deletions" line

**Parameters:**

| Name | Type | Default |
|---|---|---|
| oldText | `string` |  |
| newText | `string` |  |
| context | `number` | -1 |
| lineNumbers | `boolean` | false |
| color | `"auto" \| boolean` | "auto" |
| oldLabel | `string` | "" |
| newLabel | `string` | "" |
| ignoreWhitespace | `boolean` | false |
| hunkHeaders | `boolean` | false |
| summary | `boolean` | false |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L24))

### patch

```ts
patch(oldText: string, newText: string, filename: string, context: number, ignoreWhitespace: boolean, newFilename: string): string
```

Produce a standard unified diff that std::fs::applyPatch (or `git apply`)
  can apply, and return it as a string. Pass the file's path as `filename`;
  an empty `oldText` produces a file-creation patch and an empty `newText`
  a deletion patch.

  @param oldText - The original file contents
  @param newText - The updated file contents
  @param filename - The path used in the patch headers (the `a/` and `b/` sides)
  @param context - Context lines to include around each hunk
  @param ignoreWhitespace - Treat whitespace-only changes as equal
  @param newFilename - When non-empty, use this path for the new (`+++`) side, e.g. to record a rename

**Parameters:**

| Name | Type | Default |
|---|---|---|
| oldText | `string` |  |
| newText | `string` |  |
| filename | `string` |  |
| context | `number` | 3 |
| ignoreWhitespace | `boolean` | false |
| newFilename | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L55))
