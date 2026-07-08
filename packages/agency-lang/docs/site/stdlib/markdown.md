---
name: "markdown"
---

# markdown

Parse Markdown text into a structured AST you can walk. The returned `blocks`
  array holds block-level nodes like `Paragraph`, `Heading`, `CodeBlock`, `List`,
  `Table`, and `BlockQuote`. Each is tagged with a `type` field to switch on.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L34))

### InlineSoftBreak

A soft line break (a single newline inside a paragraph).

```ts
/** A soft line break (a single newline inside a paragraph). */
export type InlineSoftBreak = {
  type: "inline-soft-break"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L40))

### InlineHardBreak

A hard line break (two trailing spaces or a backslash before a newline).

```ts
/** A hard line break (two trailing spaces or a backslash before a newline). */
export type InlineHardBreak = {
  type: "inline-hard-break"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L45))

### InlineBold

Bold text (`**...**` or `__...__`). `content` is an array of inline nodes.

```ts
/** Bold text (`**...**` or `__...__`). `content` is an array of inline nodes. */
export type InlineBold = {
  type: "inline-bold";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L50))

### InlineItalic

Italic text (`*...*` or `_..._`). `content` is an array of inline nodes.

```ts
/** Italic text (`*...*` or `_..._`). `content` is an array of inline nodes. */
export type InlineItalic = {
  type: "inline-italic";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L56))

### InlineBoldItalic

Combined bold + italic text (`***...***`). `content` is an array of inline nodes.

```ts
/** Combined bold + italic text (`***...***`). `content` is an array of inline nodes. */
export type InlineBoldItalic = {
  type: "inline-bold-italic";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L62))

### InlineStrike

Strikethrough text (`~~...~~`). `content` is an array of inline nodes.

```ts
/** Strikethrough text (`~~...~~`). `content` is an array of inline nodes. */
export type InlineStrike = {
  type: "inline-strike";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L68))

### InlineCode

Inline code span (backtick-delimited).

```ts
/** Inline code span (backtick-delimited). */
export type InlineCode = {
  type: "inline-code";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L74))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L80))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L88))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L96))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L103))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L111))

### InlineHTML

A raw inline HTML tag, passed through verbatim including its angle brackets.

```ts
/** A raw inline HTML tag, passed through verbatim including its angle brackets. */
export type InlineHTML = {
  type: "inline-html";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L118))

### Paragraph

A paragraph. `content` is an array of inline nodes.

```ts
/** A paragraph. `content` is an array of inline nodes. */
export type Paragraph = {
  type: "paragraph";
  content: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L126))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L132))

### CodeBlock

A fenced or indented code block. `language` is the info string for fenced
    blocks, or `null` for indented blocks and unlabelled fences.

```ts
/** A fenced or indented code block. `language` is the info string for fenced
    blocks, or `null` for indented blocks and unlabelled fences. */
export type CodeBlock = {
  type: "code-block";
  content: string;
  language?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L140))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L148))

### ListItem

A single item in a list. `content` is an array of block nodes, typically
    a single paragraph but may include nested lists, code blocks, etc. Typed
    as `any[]` because Agency does not yet support mutual recursion with
    `List.items: ListItem[]`. `checked` is set for GFM task-list items:
    `true` for `[x]`/`[X]`, `false` for `[ ]`, absent for plain items.

```ts
/** A single item in a list. `content` is an array of block nodes, typically
    a single paragraph but may include nested lists, code blocks, etc. Typed
    as `any[]` because Agency does not yet support mutual recursion with
    `List.items: ListItem[]`. `checked` is set for GFM task-list items:
    `true` for `[x]`/`[X]`, `false` for `[ ]`, absent for plain items. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L182))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L191))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L199))

### HTMLBlock

A raw HTML block, passed through verbatim.

```ts
/** A raw HTML block, passed through verbatim. */
export type HTMLBlock = {
  type: "html-block";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L206))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L214))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L222))

## Functions

### parse

```ts
parse(input: string): ParseResult
```

Parse a Markdown string into a structured AST. On success, `blocks` holds
  the block-level nodes and `success` is true. On failure, `error` describes
  the problem and `rest` is the unconsumed input. Every block and inline node
  carries a `type` discriminator you can switch on.

  @param input - The Markdown source text to parse

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** [ParseResult](#parseresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L229))

### frontmatter

```ts
frontmatter(input: string): Result
```

Extract the YAML-style frontmatter block from a Markdown string. Returns
  `success(data)` with the parsed frontmatter fields as an object, or
  `failure(...)` if the document has no frontmatter or parsing failed.

  @param input - The Markdown source text to parse

Composes well with the pipe operator, e.g. `read(filename, dir) |> frontmatter`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L242))

### walk

```ts
walk(blocks: any[], block: (any) => any): any[]
```

Walk a Markdown AST top-down, calling `block` on every block and inline
  node and replacing each with the node it returns. Children of the returned
  node are walked recursively. Returns the transformed array of block nodes
  without mutating the input.

  @param blocks - The array of block nodes to transform
  @param block - Callback invoked with each node; returns the replacement node

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

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |
| block | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L273))

### renderForCli

```ts
renderForCli(blocks: any[]): string
```

Render a Markdown AST to an ANSI-styled string for printing in a terminal.
  Links use OSC 8 escapes so capable terminals render them as clickable
  hyperlinks.

  @param blocks - The array of block nodes to render

Code-block bodies are emitted verbatim. Pre-process them with `walk` to add
    syntax highlighting inside the fences.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| blocks | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/markdown.agency#L288))
