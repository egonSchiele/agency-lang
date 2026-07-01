---
name: "layout"
---

# layout

## Module: std::ui/layout

  Declarative text layout for terminal output. Build a tree of
  containers and leaves; call `render` to get an ANSI-styled
  multi-line string ready for `print`.

  Two construction styles, same result:

  - **Trailing block** (ergonomic for Agency authors):

    ```ts
    import { box, render } from "std::ui/layout"

    const panel = box(title: "Hello", padding: 1) as b {
      b.text("Welcome!", bold: true)
      b.text("How are you?")
    }
    print(render(panel))
    ```

  - **Children array** (suitable for LLM tool calls / JSON
    construction):

    ```ts
    import { box, text, render } from "std::ui/layout"

    const panel = box(
      title: "Hello",
      padding: 1,
      children: [
        text("Welcome!", bold: true),
        text("How are you?"),
      ],
    )
    print(render(panel))
    ```

  Both styles produce the same `LayoutNode` tree.

  ### Sizing and wrap

  Every container (`box`, `row`, `column`) accepts a `width`
  parameter:

  - `width: "full"` (root only) fills the terminal columns.
  - `width: 80` sets a target column count.
  - `width: "50%"` takes 50% of the parent's available width.

  Tables moved to their own module — see `std::ui/table`.

  Text inside a width-constrained container or column automatically
  wraps at word boundaries. Long single words are broken at the column
  width. `raw` content is never wrapped — use `text` if you want
  wrapping.

  Width is the only sized dimension. There is no height sizing and no
  truncation: content that overflows wraps, or (for `raw`) extends
  visibly past the container.

  ### See also

  `std::ui` exports `box`, `row`, `column` for interactive TUI
  widgets. The names overlap; import one or the other (or both with
  aliases). `std::ui/layout` is for static text output — splash screens,
  summary panels, side-by-side columns. `std::ui` is for live
  redrawing UIs with input handling.
**********

## Types

### LayoutNode

* Every layout node has the same shape. Containers carry their
 * content in `children`; leaves have `children: []`.

```ts
/**
 * Every layout node has the same shape. Containers carry their
 * content in `children`; leaves have `children: []`.
 */
export type LayoutNode = {
  type: string;
  attrs: any;
  children: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L81))

### LayoutBuilder

* Methods inside a container's trailing `as name { ... }` block. Each
 * method constructs a leaf or container and pushes it onto the
 * surrounding container's `children` array.

```ts
/**
 * Methods inside a container's trailing `as name { ... }` block. Each
 * method constructs a leaf or container and pushes it onto the
 * surrounding container's `children` array.
 */
export type LayoutBuilder = {
  text: any;
  raw: any;
  space: any;
  hline: any;
  vline: any;
  row: any;
  column: any;
  box: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L92))

### Alignment

```ts
export type Alignment = "start" | "center" | "end"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L103))

### BorderStyle

```ts
export type BorderStyle = "rounded" | "heavy" | "double" | "light"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L105))

### Width

```ts
export type Width = number | "full" | string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L107))

## Functions

### text

```ts
text(content: string, fgColor: string, bgColor: string, bold: boolean, italic: boolean, dim: boolean, underline: boolean, align: Alignment): LayoutNode
```

* A styled run of text. `content` may contain `\n`; each line becomes
 * a row of the rendered Block.
 *
 * @param content - The text to display
 * @param fgColor - Foreground color (named like "red", "orange" or hex like "#cc7a4a")
 * @param bgColor - Background color
 * @param bold - Bold weight
 * @param italic - Italic style
 * @param dim - Reduced intensity
 * @param underline - Underline decoration
 * @param align - For multi-line content, how shorter lines sit
 *   relative to the longest line. No effect on single-line text.
 *   Parent containers control the leaf's position among siblings;
 *   this controls the internal layout of the leaf's own lines.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |
| fgColor | `string` | "" |
| bgColor | `string` | "" |
| bold | `boolean` | false |
| italic | `boolean` | false |
| dim | `boolean` | false |
| underline | `boolean` | false |
| align | [Alignment](markdown.md#alignment) | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L131))

### raw

```ts
raw(content: string, align: Alignment): LayoutNode
```

* A pre-styled string. The content is rendered as-is and is **not**
 * wrapped in any outer styling — if the embedded string carries its
 * own ANSI sequences, nesting it inside a styled `text` or a styled
 * `box` will not re-apply styling after the inner sequences reset.
 * Use this for ASCII art, comic panels, or strings whose styling is
 * already baked in.
 *
 * @param content - Raw string content (may contain ANSI / newlines)
 * @param align - For multi-line content, how shorter lines sit
 *   relative to the longest line. No effect on single-line raw.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |
| align | [Alignment](markdown.md#alignment) | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L169))

### space

```ts
space(count: number): LayoutNode
```

* Blank space. Inside a `row`, inserts `count` columns; inside a
 * `column`, inserts `count` rows. Additive with the parent's `gap`.
 *
 * @param count - Number of cells of blank space

**Parameters:**

| Name | Type | Default |
|---|---|---|
| count | `number` | 1 |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L186))

### hline

```ts
hline(char: string, length: number, fgColor: string, bold: boolean, dim: boolean): LayoutNode
```

* A horizontal rule. Inside a `column`, omit `length` and the line
 * automatically spans the column's width.
 *
 * @param char - The character to repeat (defaults to `─`)
 * @param length - Explicit length; leave as 0 for parent-resolved
 * @param fgColor - Color of the line
 * @param bold - Bold weight
 * @param dim - Reduced intensity

**Parameters:**

| Name | Type | Default |
|---|---|---|
| char | `string` | "─" |
| length | `number` | 0 |
| fgColor | `string` | "" |
| bold | `boolean` | false |
| dim | `boolean` | false |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L206))

### vline

```ts
vline(char: string, length: number, fgColor: string, bold: boolean, dim: boolean): LayoutNode
```

* A vertical rule. Inside a `row`, omit `length` and the line
 * automatically spans the row's height.
 *
 * @param char - The character to repeat (defaults to `│`)
 * @param length - Explicit length; leave as 0 for parent-resolved
 * @param fgColor - Color of the line
 * @param bold - Bold weight
 * @param dim - Reduced intensity

**Parameters:**

| Name | Type | Default |
|---|---|---|
| char | `string` | "│" |
| length | `number` | 0 |
| fgColor | `string` | "" |
| bold | `boolean` | false |
| dim | `boolean` | false |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L236))

### row

```ts
row(gap: number, align: Alignment, width: Width, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

* A horizontal container. Children render left-to-right.
 *
 * @param gap - Cells of blank space between siblings
 * @param align - Cross-axis (vertical) alignment of shorter children
 * @param width - Optional width constraint. `"full"` (root only)
 *   fills the terminal columns. `"X%"` takes a percentage of the
 *   parent's available width. A number sets a target column count.
 * @param children - Pre-built children (LLM / JSON construction)
 * @param block - Trailing builder block; appended after `children`

**Parameters:**

| Name | Type | Default |
|---|---|---|
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L410))

### column

```ts
column(gap: number, align: Alignment, width: Width, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

* A vertical container. Children render top-to-bottom.
 *
 * @param gap - Blank rows between siblings
 * @param align - Cross-axis (horizontal) alignment of narrower children
 * @param width - Optional width constraint. `"full"` (root only)
 *   fills the terminal columns. `"X%"` takes a percentage of the
 *   parent's available width. A number sets a target column count.
 * @param children - Pre-built children
 * @param block - Trailing builder block

**Parameters:**

| Name | Type | Default |
|---|---|---|
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L451))

### box

```ts
box(title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, padding: number, width: Width, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

* A bordered panel. When given more than one child (or built via a
 * block with multiple builder calls), the children are stacked in an
 * implicit `column`.
 *
 * @param title - Text embedded in the top border. Without an explicit
 *   width, the box grows to fit; with width set, over-long titles wrap
 *   inside the frame. Empty string for no title.
 * @param titleColor - Color of the title text
 * @param borderStyle - One of `"rounded"`, `"heavy"`, `"double"`, `"light"`
 * @param borderColor - Color of the border characters
 * @param padding - Cells of padding between border and content
 * @param width - Optional width constraint. `"full"` (root only)
 *   fills the terminal columns. `"X%"` takes a percentage of the
 *   parent's available width. A number sets a target column count.
 * @param children - Pre-built children
 * @param block - Trailing builder block

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` | "" |
| titleColor | `string` | "" |
| borderStyle | [BorderStyle](#borderstyle) | "rounded" |
| borderColor | `string` | "" |
| padding | `number` | 1 |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L499))

### render

```ts
render(node: LayoutNode, color: "auto" | boolean, cols: number, rows: number): string
```

* Render a layout tree to a string.
 *
 * @param node - Root of the layout tree
 * @param color - `"auto"` (default) emits ANSI sequences only when stdout
 *   is a TTY. `true` always emits them. `false` strips all styling for
 *   plain ASCII output (logs, non-TTY consumers).
 * @param cols - Optional viewport columns override. `0` auto-detects.
 * @param rows - Optional viewport rows override. Reserved for future
 *   height-aware layout; `0` uses the default.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | [LayoutNode](#layoutnode) |  |
| color | `"auto" \| boolean` | "auto" |
| cols | `number` | 0 |
| rows | `number` | 0 |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L546))
