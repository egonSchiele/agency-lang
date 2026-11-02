---
name: "markdown"
description: "Parse and transform Markdown, then render it for a terminal or as HTML."
---

# markdown

```ts
  import { parse, renderForCli } from "std::markdown"

  const result = parse("# Hello\n\nSome **bold** text.")
  if (result.success && result.rest == "") {
    print(renderForCli(result.blocks))
  } else {
    print("Could not parse the whole document.")
  }
  ```

  Use `parse` to inspect a document's structure or `walk` to transform it
  before rendering. Block and inline nodes have a `type` field, such as
  `"paragraph"`, `"heading"`, or `"inline-text"`. The types below describe
  the nested nodes held in fields typed as `any[]`.

## Types

### InlineText

A plain run of text.

```ts
/** A plain run of text. */
export type InlineText = {
  type: "inline-text";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L31))

### InlineSoftBreak

A soft line break (a single newline inside a paragraph).

```ts
/** A soft line break (a single newline inside a paragraph). */
export type InlineSoftBreak = {
  type: "inline-soft-break"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L37))

### InlineHardBreak

A hard line break (two trailing spaces or a backslash before a newline).

```ts
/** A hard line break (two trailing spaces or a backslash before a newline). */
export type InlineHardBreak = {
  type: "inline-hard-break"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L42))

### InlineBold

Bold text (`**...**` or `__...__`). `content` is an array of inline nodes.

```ts
/** Bold text (`**...**` or `__...__`). `content` is an array of inline nodes. */
export type InlineBold = {
  type: "inline-bold";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L47))

### InlineItalic

Italic text (`*...*` or `_..._`). `content` is an array of inline nodes.

```ts
/** Italic text (`*...*` or `_..._`). `content` is an array of inline nodes. */
export type InlineItalic = {
  type: "inline-italic";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L53))

### InlineBoldItalic

Bold and italic text (`***...***`). `content` is an array of inline nodes.

```ts
/** Bold and italic text (`***...***`). `content` is an array of inline nodes. */
export type InlineBoldItalic = {
  type: "inline-bold-italic";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L59))

### InlineStrike

Strikethrough text (`~~...~~`). `content` is an array of inline nodes.

```ts
/** Strikethrough text (`~~...~~`). `content` is an array of inline nodes. */
export type InlineStrike = {
  type: "inline-strike";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L65))

### InlineCode

Inline code span (backtick-delimited).

```ts
/** Inline code span (backtick-delimited). */
export type InlineCode = {
  type: "inline-code";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L71))

### InlineLink

An inline link `[text](url "title")`. `content` is the linked inline nodes.

```ts
/** An inline link `[text](url "title")`. `content` is the linked inline nodes. */
export type InlineLink = {
  type: "inline-link";
  content: any[];
  url: string;
  title?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L77))

### Image

An image `![alt](url "title")`, used inline or as a block.

```ts
/** An image `![alt](url "title")`, used inline or as a block. */
export type Image = {
  type: "image";
  url: string;
  alt: string;
  title?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L85))

### InlineRefLink

A reference-style link `[text][id]` before reference resolution.
    `parse` replaces it with an `InlineLink` when a definition matches,
    or `InlineText` when none matches.

```ts
/** A reference-style link `[text][id]` before reference resolution.
    `parse` replaces it with an `InlineLink` when a definition matches,
    or `InlineText` when none matches. */
export type InlineRefLink = {
  type: "inline-ref-link";
  text: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L95))

### InlineRefImage

A reference-style image `![alt][id]` before reference resolution.
    `parse` replaces it with an `Image` when a definition matches,
    or `InlineText` when none matches.

```ts
/** A reference-style image `![alt][id]` before reference resolution.
    `parse` replaces it with an `Image` when a definition matches,
    or `InlineText` when none matches. */
export type InlineRefImage = {
  type: "inline-ref-image";
  alt: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L104))

### InlineFootnoteRef

A footnote reference `[^id]`. `content` holds text from a matching
    definition when reference resolution finds one.

```ts
/** A footnote reference `[^id]`. `content` holds text from a matching
    definition when reference resolution finds one. */
export type InlineFootnoteRef = {
  type: "inline-footnote-ref";
  id: string;
  content?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L112))

### InlineHTML

A raw inline HTML tag, including its angle brackets.

```ts
/** A raw inline HTML tag, including its angle brackets. */
export type InlineHTML = {
  type: "inline-html";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L119))

### Paragraph

A paragraph. `content` is an array of inline nodes.

```ts
/** A paragraph. `content` is an array of inline nodes. */
export type Paragraph = {
  type: "paragraph";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L127))

### Heading

An ATX or setext heading. `level` is 1–6. `content` is inline nodes.

```ts
/** An ATX or setext heading. `level` is 1–6. `content` is inline nodes. */
export type Heading = {
  type: "heading";
  level: number;
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L133))

### CodeBlock

A fenced or indented code block. `language` is the tag after the opening
    backticks, or `null` for indented blocks and unlabelled fences.
    Tags accept letters, digits, and `_+#.-`.

```ts
/** A fenced or indented code block. `language` is the tag after the opening
    backticks, or `null` for indented blocks and unlabelled fences.
    Tags accept letters, digits, and `_+#.-`. */
export type CodeBlock = {
  type: "code-block";
  content: string;
  language?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L142))

### BlockQuote

A `>`-prefixed block quote. `content` is an array of inline nodes and/or
    nested block quotes.

```ts
/** A `>`-prefixed block quote. `content` is an array of inline nodes and/or
    nested block quotes. */
export type BlockQuote = {
  type: "block-quote";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L150))

### ListItem

A list item with block nodes in `content`, including paragraphs and
    nested lists. For task lists, `checked` is `true` for `[x]` or `[X]`
    and `false` for `[ ]`. Plain items omit `checked`.

```ts
/** A list item with block nodes in `content`, including paragraphs and
    nested lists. For task lists, `checked` is `true` for `[x]` or `[X]`
    and `false` for `[ ]`. Plain items omit `checked`. */
export type ListItem = {
  content: any[];
  checked?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L158))

### List

An ordered or unordered list. `start` is the starting number for ordered
    lists (ignored for unordered lists).

```ts
/** An ordered or unordered list. `start` is the starting number for ordered
    lists (ignored for unordered lists). */
export type List = {
  type: "list";
  ordered: boolean;
  start: number;
  items: ListItem[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L165))

### HorizontalRule

A horizontal rule (`---`, `***`, or `___`).

```ts
/** A horizontal rule (`---`, `***`, or `___`). */
export type HorizontalRule = {
  type: "horizontal-rule"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L173))

### Alignment

Per-column alignment for a Markdown table. `null` means no explicit
    alignment was specified.

```ts
/** Per-column alignment for a Markdown table. `null` means no explicit
    alignment was specified. */
export type Alignment = "left" | "right" | "center" | null
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L179))

### Table

A GFM-style pipe table. Headers and cells keep their Markdown as strings.

```ts
/** A GFM-style pipe table. Headers and cells keep their Markdown as strings. */
export type Table = {
  type: "table";
  headers: string[];
  alignments: Alignment[];
  rows: string[][]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L182))

### LinkDef

A link definition (`[id]: url "title"`). `parse` uses definitions to
    resolve references, then removes them from the returned nodes.

```ts
/** A link definition (`[id]: url "title"`). `parse` uses definitions to
    resolve references, then removes them from the returned nodes. */
export type LinkDef = {
  type: "link-definition";
  id: string;
  url: string;
  title?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L191))

### FootnoteDef

A single-line footnote definition (`[^id]: text`). Reference resolution
    copies its text to matching references, then removes the definition.

```ts
/** A single-line footnote definition (`[^id]: text`). Reference resolution
    copies its text to matching references, then removes the definition. */
export type FootnoteDef = {
  type: "footnote-definition";
  id: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L200))

### HTMLBlock

A raw HTML block containing its source text.

```ts
/** A raw HTML block containing its source text. */
export type HTMLBlock = {
  type: "html-block";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L207))

### Frontmatter

YAML-style frontmatter at the start of a document. Field values are
    strings, numbers, booleans, null, or inline lists of these values.
    See `frontmatter` for the supported syntax.

```ts
/** YAML-style frontmatter at the start of a document. Field values are
    strings, numbers, booleans, null, or inline lists of these values.
    See `frontmatter` for the supported syntax. */
export type Frontmatter = {
  type: "frontmatter";
  data: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L215))

### ParseResult

The outcome of parsing Markdown. `blocks` holds the parsed nodes and
    `rest` holds any unconsumed input, even when `success` is true.
    On failure, `blocks` is empty and `error` describes the problem.

```ts
/** The outcome of parsing Markdown. `blocks` holds the parsed nodes and
    `rest` holds any unconsumed input, even when `success` is true.
    On failure, `blocks` is empty and `error` describes the problem. */
export type ParseResult = {
  success: boolean;
  blocks: any[];
  error: string;
  rest: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L223))

## Functions

### parse

```ts
parse(input: string): ParseResult
```

Parse Markdown into block and inline nodes for inspection or rendering.
  Check `success` and that `rest` is empty before treating `blocks` as a
  complete document.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** [ParseResult](#parseresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L230))

### frontmatter

```ts
frontmatter(input: string): Result
```

Extract frontmatter fields from the start of Markdown. Supports a flat
  YAML-style record with scalar values and inline lists. Returns a failure
  if frontmatter is missing or parsing fails.

Frontmatter must start at the first character and use `---` fences.
    Supported fields use `key: value` lines with scalar values or inline
    lists such as `[one, two]`. Keys accept letters, digits, `_`, and `-`.
    Nested objects, indented lists, and multiline values are unsupported.
    A frontmatter block with unsupported syntax may be treated as document
    content and reported as missing.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L245))

### walk

```ts
walk(blocks: any[], block: (any) -> any): any[]
```

Transform Markdown block and inline nodes from parent to child. Return
  replacement nodes instead of mutating callback arguments.

  @param blocks - Use the `blocks` from `parse` or the result of a previous `walk`.
  @param block - Return the replacement node whose children should be visited next.

```ts
  import { parse, walk } from "std::markdown"

  const result = parse("A **bold** greeting.")
  if (result.success && result.rest == "") {
    const transformed = walk(result.blocks) as part {
      if (part.type == "inline-text") {
        return { ...part, content: part.content.toUpperCase() }
      }
      return part
    }
  }
  ```

  Children of each replacement node are visited next. List-item wrappers
  are skipped, but their block children are visited. Table cells are plain
  strings, so the callback receives the table rather than individual cells.
  Return new objects to preserve the input, since the callback receives
  the original nodes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |
| block | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L284))

### renderForCli

```ts
renderForCli(blocks: any[]): string
```

Render Markdown nodes as an ANSI-styled string for a terminal.

  @param blocks - Use the `blocks` from `parse` or the result of `walk`.

Use `walk` to add ANSI syntax highlighting to code-block bodies before
    rendering. The renderer preserves those escape sequences.
    Links use OSC 8 escapes for clickable hyperlinks in terminals that support them.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L298))

### renderForHtml

```ts
renderForHtml(blocks: any[]): string
```

Render Markdown nodes as HTML with escaped text and filtered URLs.
  Raw HTML in the source is omitted.

  @param blocks - Use the `blocks` from `parse` or the result of `walk`.

```ts
  import { parse, renderForHtml } from "std::markdown"

  const result = parse("## Findings\n\n- one\n- two")
  if (result.success && result.rest == "") {
    const html = renderForHtml(result.blocks)
    // <h2>Findings</h2>
    // <ul><li>one</li><li>two</li></ul>
  }
  ```

  Use this renderer for HTML destinations, including model-written Markdown.
  Allowed URLs use `http`, `https`, `mailto`, `tel`, or relative paths.
  Protocol-relative URLs are rejected. Rejected links keep their text,
  and rejected images keep their alt text. Frontmatter is omitted.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L324))
