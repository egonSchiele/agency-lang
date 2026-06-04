---
name: "syntax"
---

# syntax

## Types

### HighlightMode

```ts
export type HighlightMode = "shell" | "web"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/syntax.agency#L5))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/syntax.agency#L7))
