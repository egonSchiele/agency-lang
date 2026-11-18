---
name: "syntax"
description: "Highlight code and produce terminal diffs, unified patches, or tokens to draw yourself."
---

# syntax

Highlight code and compare versions of text. Use `diff` for terminal
  display or `patch` to produce a unified diff for `git apply`. A program
  that draws code itself, such as a GUI or a web page, uses
  `highlightTokens` and `diffTokens`: they return the same results as data,
  so the program picks its own colors.

  ```ts
  import { highlight } from "std::syntax"

  node main() {
    print(highlight("const x = 1", language: "typescript"))
  }
  ```

## Types

### Style

A text style modifier applied to a token's color.

```ts
/** A text style modifier applied to a token's color. */
export type Style = "bold" | "italic" | "underline" | "dim"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L37))

### TokenStyle

The style for one token class. `color` is a hex string (e.g. "#569CD6") or a
  termcolors named color (e.g. "red", "brightGreen"). `styles` optionally adds
  bold / italic / underline / dim.

```ts
/**
  The style for one token class. `color` is a hex string (e.g. "#569CD6") or a
  termcolors named color (e.g. "red", "brightGreen"). `styles` optionally adds
  bold / italic / underline / dim.
*/
export type TokenStyle = {
  color: string;
  styles?: Style[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L44))

### ColorScheme

A custom color scheme. Each field is a highlight.js token class. The
  non-identifier classes use camelCase names (e.g. `builtIn` -> `built_in`,
  `metaKeyword` -> `meta-keyword`). All fields are optional and merge over the
  "vscode-dark" scheme.

```ts
/**
  A custom color scheme. Each field is a highlight.js token class. The
  non-identifier classes use camelCase names (e.g. `builtIn` -> `built_in`,
  `metaKeyword` -> `meta-keyword`). All fields are optional and merge over the
  "vscode-dark" scheme.
*/
export type ColorScheme = {
  keyword?: TokenStyle;
  builtIn?: TokenStyle;
  type?: TokenStyle;
  literal?: TokenStyle;
  number?: TokenStyle;
  regexp?: TokenStyle;
  string?: TokenStyle;
  subst?: TokenStyle;
  symbol?: TokenStyle;
  class?: TokenStyle;
  function?: TokenStyle;
  title?: TokenStyle;
  params?: TokenStyle;
  comment?: TokenStyle;
  doctag?: TokenStyle;
  meta?: TokenStyle;
  section?: TokenStyle;
  tag?: TokenStyle;
  name?: TokenStyle;
  attr?: TokenStyle;
  attribute?: TokenStyle;
  variable?: TokenStyle;
  bullet?: TokenStyle;
  code?: TokenStyle;
  emphasis?: TokenStyle;
  strong?: TokenStyle;
  formula?: TokenStyle;
  link?: TokenStyle;
  quote?: TokenStyle;
  addition?: TokenStyle;
  deletion?: TokenStyle;
  default?: TokenStyle;
  metaKeyword?: TokenStyle;
  metaString?: TokenStyle;
  builtinName?: TokenStyle;
  selectorTag?: TokenStyle;
  selectorId?: TokenStyle;
  selectorClass?: TokenStyle;
  selectorAttr?: TokenStyle;
  selectorPseudo?: TokenStyle;
  templateTag?: TokenStyle;
  templateVariable?: TokenStyle
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L55))

### ThemeName

A built-in color scheme accepted by `highlight` and `diff`.

```ts
/**
  A built-in color scheme accepted by `highlight` and `diff`.
*/
export type ThemeName =
  | "vscode-dark"
  | "github-dark"
  | "monokai"
  | "dracula"
  | "nord"
  | "github"
  | "a11y-dark"
  | "a11y-light"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L108))

### CodeToken

One piece of highlighted code. `scope` is the kind of syntax it is, named
  like the fields of `ColorScheme` (for example "keyword", "string" or
  "builtIn"), or null for plain text.

```ts
/**
  One piece of highlighted code. `scope` is the kind of syntax it is, named
  like the fields of `ColorScheme` (for example "keyword", "string" or
  "builtIn"), or null for plain text.
*/
export type CodeToken = {
  text: string;
  scope?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L146))

### DiffToken

One piece of one line of a diff. `scope` is as in `CodeToken`. `changed` is
  true for a word that differs from the line this one replaced.

```ts
/**
  One piece of one line of a diff. `scope` is as in `CodeToken`. `changed` is
  true for a word that differs from the line this one replaced.
*/
export type DiffToken = {
  text: string;
  scope?: string;
  changed: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L219))

### DiffLine

One line of a diff. `kind` says whether it is unchanged ("context"),
  removed ("delete") or added ("insert"). A line has a number on each side
  it exists on, counting from 1.

```ts
/**
  One line of a diff. `kind` says whether it is unchanged ("context"),
  removed ("delete") or added ("insert"). A line has a number on each side
  it exists on, counting from 1.
*/
export type DiffLine = {
  kind: "context" | "delete" | "insert";
  oldNumber?: number;
  newNumber?: number;
  tokens: DiffToken[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L230))

### DiffHunk

A run of changed lines and the unchanged lines around them, with where the
  run starts and how many lines it covers on each side.

```ts
/**
  A run of changed lines and the unchanged lines around them, with where the
  run starts and how many lines it covers on each side.
*/
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L241))

## Constants

### colorSchemes

The names of all built-in color schemes (valid string values for `theme`).

```ts
/** The names of all built-in color schemes (valid string values for `theme`). */
export static const colorSchemes: string[] = _builtinThemeNames
```

**Type:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L101))

## Functions

### detectLanguage

```ts
detectLanguage(code: string): string
```

Guess a code snippet's language, or return "plaintext" when unknown.
  Detection is less reliable on short or ambiguous snippets.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L28))

### highlight

```ts
highlight(
  code: string,
  language: string = "plaintext",
  theme: ThemeName = "vscode-dark",
): string
```

Add ANSI syntax highlighting to code for terminal display.

Returns ANSI terminal styling.
  When `language` is "markdown", fenced code blocks use the default palette
  regardless of `theme`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| code | `string` |  |  |
| language | `string` | "plaintext" | A highlight.js language name, or "auto" to guess. |
| theme | [ThemeName](#themename) | "vscode-dark" |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L123))

### highlightTokens

```ts
highlightTokens(code: string, language: string = "plaintext"): CodeToken[]
```

Split code into tokens, each tagged with the kind of syntax it is.

Returns the code as tokens instead of terminal text, for a program that
  draws code itself. Joining every token's `text` gives back `code`. A
  language highlight.js does not know gives one plain token.

  ```ts
  for (token in highlightTokens("const x = 1", language: "typescript")) {
    print("${token.scope}: ${token.text}")
  }
  ```

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| code | `string` |  |  |
| language | `string` | "plaintext" | A highlight.js language name, or "auto" to guess. |

**Returns:** `CodeToken[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L162))

### diff

```ts
diff(
  oldText: string,
  newText: string,
  context: number = -1,
  lineNumbers: boolean = false,
  color: "auto" | boolean = "auto",
  oldLabel: string = "",
  newLabel: string = "",
  ignoreWhitespace: boolean = false,
  hunkHeaders: boolean = false,
  summary: boolean = false,
  language: string = "",
  theme: ThemeName = "vscode-dark",
): string
```

Compare two texts for terminal display, highlighting changed words.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| oldText | `string` |  |  |
| newText | `string` |  |  |
| context | `number` | -1 | Unchanged lines around each change, or -1 for the full text. |
| lineNumbers | `boolean` | false |  |
| color | `"auto" \| boolean` | "auto" | "auto" colors terminal output; true always colors; false disables color. |
| oldLabel | `string` | "" | Optional label for the original text header. |
| newLabel | `string` | "" | Optional label for the updated text header. |
| ignoreWhitespace | `boolean` | false | Treat whitespace-only changes as equal. |
| hunkHeaders | `boolean` | false | Include location headers between change regions. |
| summary | `boolean` | false | Include insertion and deletion counts. |
| language | `string` | "" | Highlight changed lines using this language, or "auto" to guess. |
| theme | [ThemeName](#themename) | "vscode-dark" | Color scheme for syntax-highlighted changes. |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L172))

### diffTokens

```ts
diffTokens(
  oldText: string,
  newText: string,
  context: number = -1,
  ignoreWhitespace: boolean = false,
  language: string = "",
): DiffHunk[]
```

Compare two texts and return the changes as lines of tokens.

Returns the same comparison as `diff`, as data instead of terminal text, for
  a program that draws diffs itself. Each side is highlighted as a whole, so a
  comment that spans several lines is a comment on every one of them. A
  removed line followed by the line that replaced it has the changed words
  marked on both, as `diff` colors them.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| oldText | `string` |  |  |
| newText | `string` |  |  |
| context | `number` | -1 | Unchanged lines around each change, or -1 for the full text. |
| ignoreWhitespace | `boolean` | false | Treat whitespace-only changes as equal. |
| language | `string` | "" | Tag tokens with their syntax for this language, or "auto" to guess. |

**Returns:** `DiffHunk[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L256))

### patch

```ts
patch(
  oldText: string,
  newText: string,
  filename: string,
  context: number = 3,
  ignoreWhitespace: boolean = false,
  newFilename: string = "",
): string
```

Produce a unified diff suitable for git apply.

An empty `oldText` creates a file-creation patch. An empty `newText` creates
a deletion patch. This function returns patch text without changing files.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| oldText | `string` |  |  |
| newText | `string` |  |  |
| filename | `string` |  | Path to use in the patch headers. |
| context | `number` | 3 | Unchanged lines around each change. |
| ignoreWhitespace | `boolean` | false | Treat whitespace-only changes as equal. |
| newFilename | `string` | "" | Optional new path for a rename. |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L277))
