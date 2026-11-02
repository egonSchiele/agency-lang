---
name: "syntax"
description: "Highlight code and produce terminal diffs or unified patches."
---

# syntax

Highlight code and compare versions of text. Use `diff` for terminal
  display or `patch` to produce a unified diff for `git apply`.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L32))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L39))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L50))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L103))

## Constants

### colorSchemes

The names of all built-in color schemes (valid string values for `theme`).

```ts
/** The names of all built-in color schemes (valid string values for `theme`). */
export static const colorSchemes: string[] = _builtinThemeNames
```

**Type:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L96))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L23))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L118))

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

Use for displaying changes to a person. With `language` and color enabled,
changed lines use syntax highlighting on red or green backgrounds. Background
padding is limited to the terminal width. Use `patch` for output to apply with Git.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L137))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L184))
