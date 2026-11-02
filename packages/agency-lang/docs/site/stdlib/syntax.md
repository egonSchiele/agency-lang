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

### HighlightMode

Accepted values for the currently unused `highlight` mode parameter.

```ts
/** Accepted values for the currently unused `highlight` mode parameter. */
export type HighlightMode = "shell" | "web"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L24))

### Style

A text style modifier applied to a token's color.

```ts
/** A text style modifier applied to a token's color. */
export type Style = "bold" | "italic" | "underline" | "dim"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L35))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L42))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L53))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L104))

## Constants

### colorSchemes

```ts
export static const colorSchemes: string[] = _builtinThemeNames
```

**Type:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L99))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L26))

### highlight

```ts
highlight(
  code: string,
  language: string = "plaintext",
  mode: HighlightMode = "shell",
  theme: ThemeName = "vscode-dark",
): string
```

Add ANSI syntax highlighting to code for terminal display.

  @param language - A highlight.js language name, or "auto" to guess.
  @param mode - Currently ignored; output uses terminal styling.

Returns ANSI terminal styling. The `mode` parameter currently has no effect.
  When `language` is "markdown", fenced code blocks use the default palette
  regardless of `theme`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |
| language | `string` | "plaintext" |
| mode | [HighlightMode](#highlightmode) | "shell" |
| theme | [ThemeName](#themename) | "vscode-dark" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L119))

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

  @param context - Unchanged lines around each change, or -1 for the full text.
  @param color - "auto" colors terminal output; true always colors; false disables color.
  @param oldLabel - Optional label for the original text header.
  @param newLabel - Optional label for the updated text header.
  @param ignoreWhitespace - Treat whitespace-only changes as equal.
  @param hunkHeaders - Include location headers between change regions.
  @param summary - Include insertion and deletion counts.
  @param language - Highlight changed lines using this language, or "auto" to guess.
  @param theme - Color scheme for syntax-highlighted changes.

Use for displaying changes to a person. With `language` and color enabled,
changed lines use syntax highlighting on red or green backgrounds. Background
padding is limited to the terminal width. Use `patch` for output to apply with Git.

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
| language | `string` | "" |
| theme | [ThemeName](#themename) | "vscode-dark" |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L140))

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

  @param filename - Path to use in the patch headers.
  @param context - Unchanged lines around each change.
  @param ignoreWhitespace - Treat whitespace-only changes as equal.
  @param newFilename - Optional new path for a rename.

An empty `oldText` creates a file-creation patch. An empty `newText` creates
a deletion patch. This function returns patch text without changing files.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L187))
