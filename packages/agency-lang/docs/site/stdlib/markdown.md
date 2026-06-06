---
name: "markdown"
---

# markdown

Parse Markdown text into a structured AST.

  ```ts
  import { parse } from "std::markdown"

  const result = parse("# Hello\n\nSome **bold** text.")
  if (result.success) {
    for (block in result.blocks) {
      print(block.type)
    }
  } else {
    print("parse error: ${result.error}")
  }
  ```

  Powered by tarsec's Markdown parser. The returned `blocks` array is a
  heterogeneous list of block-level nodes — `Paragraph`, `Heading`,
  `CodeBlock`, `List`, `Table`, `BlockQuote`, etc. — each tagged with a
  `type` field you can switch on.

  Inline nodes (those that appear inside paragraphs, headings, etc.) and
  Markdown's recursive structures (`InlineBold` containing more inline
  nodes, `BlockQuote` containing more blocks, frontmatter values that may
  contain other values) are typed with `any[]` / `any` because Agency
  does not yet support self-referential type aliases. The runtime shape
  still matches the documented types below.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L39))

### InlineSoftBreak

A soft line break (a single newline inside a paragraph).

```ts
/** A soft line break (a single newline inside a paragraph). */
export type InlineSoftBreak = {
  type: "inline-soft-break"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L45))

### InlineHardBreak

A hard line break (two trailing spaces or a backslash before a newline).

```ts
/** A hard line break (two trailing spaces or a backslash before a newline). */
export type InlineHardBreak = {
  type: "inline-hard-break"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L50))

### InlineBold

Bold text (`**...**` or `__...__`). `content` is an array of inline nodes.

```ts
/** Bold text (`**...**` or `__...__`). `content` is an array of inline nodes. */
export type InlineBold = {
  type: "inline-bold";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L55))

### InlineItalic

Italic text (`*...*` or `_..._`). `content` is an array of inline nodes.

```ts
/** Italic text (`*...*` or `_..._`). `content` is an array of inline nodes. */
export type InlineItalic = {
  type: "inline-italic";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L61))

### InlineBoldItalic

Combined bold + italic text (`***...***`). `content` is an array of inline nodes.

```ts
/** Combined bold + italic text (`***...***`). `content` is an array of inline nodes. */
export type InlineBoldItalic = {
  type: "inline-bold-italic";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L67))

### InlineStrike

Strikethrough text (`~~...~~`). `content` is an array of inline nodes.

```ts
/** Strikethrough text (`~~...~~`). `content` is an array of inline nodes. */
export type InlineStrike = {
  type: "inline-strike";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L73))

### InlineCode

Inline code span (backtick-delimited).

```ts
/** Inline code span (backtick-delimited). */
export type InlineCode = {
  type: "inline-code";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L79))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L85))

### Image

An inline image `![alt](url "title")`.

```ts
/** An inline image `![alt](url "title")`. */
export type Image = {
  type: "image";
  url: string;
  alt: string;
  title?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L93))

### InlineRefLink

A reference-style link `[text][id]`, resolved against link definitions.

```ts
/** A reference-style link `[text][id]`, resolved against link definitions. */
export type InlineRefLink = {
  type: "inline-ref-link";
  text: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L101))

### InlineRefImage

A reference-style image `![alt][id]`, resolved against link definitions.

```ts
/** A reference-style image `![alt][id]`, resolved against link definitions. */
export type InlineRefImage = {
  type: "inline-ref-image";
  alt: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L108))

### InlineFootnoteRef

A footnote reference `[^id]`. `content` is filled in by reference
    resolution when a matching footnote definition exists.

```ts
/** A footnote reference `[^id]`. `content` is filled in by reference
    resolution when a matching footnote definition exists. */
export type InlineFootnoteRef = {
  type: "inline-footnote-ref";
  id: string;
  content?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L116))

### InlineHTML

A raw inline HTML tag, passed through verbatim including its angle brackets.

```ts
/** A raw inline HTML tag, passed through verbatim including its angle brackets. */
export type InlineHTML = {
  type: "inline-html";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L123))

### Paragraph

A paragraph. `content` is an array of inline nodes.

```ts
/** A paragraph. `content` is an array of inline nodes. */
export type Paragraph = {
  type: "paragraph";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L131))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L137))

### CodeBlock

A fenced or indented code block. `language` is the info string for fenced
    blocks, or `null` for indented blocks and unlabelled fences.

```ts
/** A fenced or indented code block. `language` is the info string for fenced
    blocks, or `null` for indented blocks and unlabelled fences. */
export type CodeBlock = {
  type: "code-block";
  content: string;
  language: string | null
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L145))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L153))

### ListItem

A single item in a list. `content` is an array of block nodes — typically
    a single paragraph, but may include nested lists, code blocks, etc. Typed
    as `any[]` because Agency does not yet support mutual recursion with
    `List.items: ListItem[]`. `checked` is set for GFM task-list items:
    `true` for `[x]`/`[X]`, `false` for `[ ]`, absent for plain items.

```ts
/** A single item in a list. `content` is an array of block nodes — typically
    a single paragraph, but may include nested lists, code blocks, etc. Typed
    as `any[]` because Agency does not yet support mutual recursion with
    `List.items: ListItem[]`. `checked` is set for GFM task-list items:
    `true` for `[x]`/`[X]`, `false` for `[ ]`, absent for plain items. */
export type ListItem = {
  content: any[];
  checked?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L163))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L170))

### HorizontalRule

A horizontal rule (`---`, `***`, or `___`).

```ts
/** A horizontal rule (`---`, `***`, or `___`). */
export type HorizontalRule = {
  type: "horizontal-rule"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L178))

### Alignment

Per-column alignment for a Markdown table. `null` means no explicit
    alignment was specified.

```ts
/** Per-column alignment for a Markdown table. `null` means no explicit
    alignment was specified. */
export type Alignment = "left" | "right" | "center" | null
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L184))

### Table

A GFM-style pipe table.

```ts
/** A GFM-style pipe table. */
export type Table = {
  type: "table";
  headers: string[];
  alignments: Alignment[];
  rows: string[][]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L187))

### LinkDef

A link definition (`[id]: url "title"`). Reference resolution strips these
    from the output, but the type is exposed for completeness.

```ts
/** A link definition (`[id]: url "title"`). Reference resolution strips these
    from the output, but the type is exposed for completeness. */
export type LinkDef = {
  type: "link-definition";
  id: string;
  url: string;
  title?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L196))

### FootnoteDef

A footnote definition (`[^id]: ...`).

```ts
/** A footnote definition (`[^id]: ...`). */
export type FootnoteDef = {
  type: "footnote-definition";
  id: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L204))

### HTMLBlock

A raw HTML block, passed through verbatim.

```ts
/** A raw HTML block, passed through verbatim. */
export type HTMLBlock = {
  type: "html-block";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L211))

### Frontmatter

YAML-style frontmatter at the very top of the document. `data` is an
    object whose values are strings, numbers, booleans, nulls, or arrays of
    those (recursive).

```ts
/** YAML-style frontmatter at the very top of the document. `data` is an
    object whose values are strings, numbers, booleans, nulls, or arrays of
    those (recursive). */
export type Frontmatter = {
  type: "frontmatter";
  data: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L219))

### ParseResult

The result of a successful or failed `parse()` call. On success,
    `blocks` is the parsed document; on failure, `error` describes what
    went wrong and `rest` is the unconsumed input.

```ts
/** The result of a successful or failed `parse()` call. On success,
    `blocks` is the parsed document; on failure, `error` describes what
    went wrong and `rest` is the unconsumed input. */
export type ParseResult = {
  success: boolean;
  blocks: any[];
  error: string;
  rest: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L227))

## Functions

### parse

```ts
parse(input: string): ParseResult
```

Parse a Markdown string into a structured AST. Returns an object with
  `success` (true if parsing finished cleanly), `blocks` (an array of
  block-level nodes such as Paragraph, Heading, CodeBlock, List, Table,
  BlockQuote, HorizontalRule, HTMLBlock, FootnoteDef, Frontmatter), an
  `error` message (empty on success), and `rest` (unconsumed input).

  Each block is tagged with a `type` discriminator that you can switch on.
  Inline nodes inside blocks (like InlineBold or InlineLink) are also
  tagged with `type`.

  @param input - The Markdown source text to parse

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** [ParseResult](#parseresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L234))

### frontmatter

```ts
frontmatter(input: string): Result
```

Extract just the YAML-style frontmatter block from a Markdown string.
  Returns `success(data)` where `data` is a `Record<string, any>` of the
  parsed frontmatter fields, or `failure(...)` if the document has no
  frontmatter or the parse failed.

  Useful for chaining with the pipe operator, e.g.
  `read(filename, dir) |> frontmatter`.

  @param input - The Markdown source text to parse

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L251))

### walk

```ts
walk(blocks: any[], block: (any) => any): any[]
```

Walk a Markdown AST top-down, calling `block` on every block and inline
  node. The block receives the node as an object and returns a (possibly
  new) node — children of the returned node are then walked recursively.
  Returns the transformed array of block nodes. The input AST is not
  mutated.

  Typically used with the trailing-block syntax:

  ```ts
  const result = parse(input)
  const transformed = walk(result.blocks) as node {
  if (node.type == "code-block") {
  return { ...node, content: highlight(node.content, node.language) }
  }
  return node
  }
  ```

  @param blocks - The array of block nodes returned by `parse(...).blocks`
  @param block - Callback invoked with each node; returns the replacement node

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |
| block | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L275))

### renderForCli

```ts
renderForCli(blocks: any[]): string
```

Render a Markdown AST (array of block nodes) to an ANSI-styled string
  suitable for direct printing in a terminal. Links use OSC 8 escapes so
  capable terminals render them as clickable hyperlinks.

  Code-block bodies are emitted verbatim, so pre-process them with `walk`
  if you want syntax highlighting inside the fences (this is what
  `highlight(code, "markdown")` does internally).

  @param blocks - The array of block nodes to render

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L301))
