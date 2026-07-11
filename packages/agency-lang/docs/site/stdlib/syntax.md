---
name: "syntax"
---

# syntax

Syntax-highlight code, detect its language, and render colored diffs
and patches for the terminal or the web.

  ```ts
  import { highlight } from "std::syntax"

  node main() {
    print(highlight("const x = 1", language: "typescript"))
  }
  ```

## Types

### HighlightMode

```ts
export type HighlightMode = "shell" | "web"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L21))

### Style

A text style modifier applied to a token's color.

```ts
/** A text style modifier applied to a token's color. */
export type Style = "bold" | "italic" | "underline" | "dim"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L36))

### TokenStyle

* The style for one token class. `color` is a hex string (e.g. "#569CD6") or a
 * termcolors named color (e.g. "red", "brightGreen"). `styles` optionally adds
 * bold / italic / underline / dim.

```ts
/**
 * The style for one token class. `color` is a hex string (e.g. "#569CD6") or a
 * termcolors named color (e.g. "red", "brightGreen"). `styles` optionally adds
 * bold / italic / underline / dim.
 */
export type TokenStyle = {
  color: string;
  styles?: Style[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L43))

### ColorScheme

* A custom color scheme. Each field is a highlight.js token class. The
 * non-identifier classes use camelCase names (e.g. `builtIn` -> `built_in`,
 * `metaKeyword` -> `meta-keyword`). All fields are optional and merge over the
 * "vscode-dark" scheme.

```ts
/**
 * A custom color scheme. Each field is a highlight.js token class. The
 * non-identifier classes use camelCase names (e.g. `builtIn` -> `built_in`,
 * `metaKeyword` -> `meta-keyword`). All fields are optional and merge over the
 * "vscode-dark" scheme.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L54))

## Constants

### colorSchemes

```ts
export static const colorSchemes: string[] = _builtinThemeNames
```

**Type:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L100))

## Functions

### detectLanguage

```ts
detectLanguage(code: string): string
```

Guess the programming language of a code snippet. Returns a highlight.js
  language name (e.g. "typescript", "python", "json"), or "plaintext" when it
  can't tell. Detection is heuristic and less reliable on short or ambiguous
  snippets.

  @param code - The code snippet to detect the language of

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
  mode: HighlightMode = "shell",
  theme: string | ColorScheme = "vscode-dark",
): string
```

Syntax-highlight a code snippet and return the highlighted string.

  @param code - The code snippet to highlight
  @param language - The programming language of the code (e.g. "javascript", "python", "json"). Use "auto" to auto-detect it (heuristic; less reliable on short snippets). Defaults to "plaintext".
  @param mode - Output format: "shell" for terminal output, "web" for web output
  @param theme - A named color scheme ("vscode-dark", "github-dark", "monokai", "dracula", "nord", "github", "a11y-dark", "a11y-light") or a custom ColorScheme object. An unknown scheme name or an invalid color returns a failure.

* A custom `theme` maps token classes to colors, merged over "vscode-dark":
 *
 *     highlight(code, "ts", theme: {
 *       keyword: { color: "#C586C0", styles: ["bold"] },
 *       comment: { color: "#6A9955", styles: ["italic"] },
 *       string:  { color: "green" }
 *     })
 *
 * When `language` is "markdown", fenced code blocks use the default palette
 * regardless of `theme`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |
| language | `string` | "plaintext" |
| mode | [HighlightMode](#highlightmode) | "shell" |
| theme | `string \| ColorScheme` | "vscode-dark" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L114))

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
  theme: string | ColorScheme = "vscode-dark",
): string
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
  @param language - When non-empty (e.g. "agency", "ts", "python") and color is on, render changed lines with a dim red/green background and syntax-highlighted code instead of inline `-`/`+` coloring. Use "auto" to auto-detect the language once from the full text (heuristic).
  @param theme - When `language` is set, the syntax-highlighting color scheme: a named scheme (e.g. "dracula") or a custom ColorScheme object. An unknown scheme or invalid color returns a failure.

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
| theme | `string \| ColorScheme` | "vscode-dark" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L131))

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

Produce a standard unified diff and return it as a string, in a format that
  `git apply` can apply. Pass the file's path as `filename`; an empty `oldText`
  produces a file-creation patch and an empty `newText` a deletion patch.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/syntax.agency#L179))
