---
name: "layout"
---

# layout

Build terminal output as a tree of boxes, rows, and columns, then render
  it to a styled string you can print. Handy for splash screens, summary
  panels, and side-by-side columns.

  ```ts
  import { box, render } from "std::ui/layout"

  const panel = box(title: "Hello", padding: 1) as b {
    b.text("Welcome!", bold: true)
    b.text("How are you?")
  }
  print(render(panel))
  ```

  Containers (`box`, `row`, `column`) take a `width`: a number of columns,
  `"50%"` of the parent, or `"full"` for the whole terminal. Content wraps to
  fit its container; pass `wrap: false` to `raw` to preserve exact layout
  (ASCII art, pre-rendered tables). Unsized containers shrink to fit their
  content but cap at the available width, wrapping anything longer.

  For live, redrawing UIs with input handling, use `std::ui` instead.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L31))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L42))

### Alignment

```ts
export type Alignment = "start" | "center" | "end"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L53))

### BorderStyle

```ts
export type BorderStyle = "rounded" | "heavy" | "double" | "light"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L55))

### Width

```ts
export type Width = number | "full" | string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L57))

## Functions

### text

```ts
text(
  content: string,
  fgColor: string = "",
  bgColor: string = "",
  bold: boolean = false,
  italic: boolean = false,
  dim: boolean = false,
  underline: boolean = false,
  align: Alignment = "start",
): LayoutNode
```

A styled run of text. Newlines split it into multiple lines.

  @param content - The text to display
  @param fgColor - Foreground color, named ("red") or hex ("#cc7a4a")
  @param bgColor - Background color
  @param bold - Use bold weight
  @param italic - Use italic style
  @param dim - Use reduced intensity
  @param underline - Underline the text
  @param align - For multi-line text, how shorter lines align to the longest

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
| align | [Alignment](#alignment) | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L65))

### raw

```ts
raw(
  content: string,
  align: Alignment = "start",
  wrap: boolean = true,
): LayoutNode
```

A pre-styled string (may carry its own ANSI or newlines). Wraps to the
  container width by default; pass wrap: false to render exactly as-is and
  never reflow (ASCII art, pre-rendered tables).

  @param content - Raw string content (may contain ANSI codes or newlines)
  @param align - For multi-line content, how shorter lines align to the longest
  @param wrap - Reflow to the container width (default true). false preserves the exact layout.

Wraps to its container by default; pass `wrap: false` to preserve exact
layout. Wrapping is ANSI-aware, so embedded color survives without bleeding
into surrounding borders.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |
| align | [Alignment](#alignment) | "start" |
| wrap | `boolean` | true |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L106))

### space

```ts
space(count: number = 1): LayoutNode
```

Blank space. Inside a row it adds columns; inside a column, rows.

  @param count - Number of cells of blank space

**Parameters:**

| Name | Type | Default |
|---|---|---|
| count | `number` | 1 |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L127))

### hline

```ts
hline(
  char: string = "─",
  length: number = 0,
  fgColor: string = "",
  bold: boolean = false,
  dim: boolean = false,
): LayoutNode
```

A horizontal rule. Inside a column, leave length at 0 to span the column's width.

  @param char - The character to repeat
  @param length - Explicit length (0 lets the parent size it)
  @param fgColor - Color of the line
  @param bold - Use bold weight
  @param dim - Use reduced intensity

**Parameters:**

| Name | Type | Default |
|---|---|---|
| char | `string` | "─" |
| length | `number` | 0 |
| fgColor | `string` | "" |
| bold | `boolean` | false |
| dim | `boolean` | false |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L142))

### vline

```ts
vline(
  char: string = "│",
  length: number = 0,
  fgColor: string = "",
  bold: boolean = false,
  dim: boolean = false,
): LayoutNode
```

A vertical rule. Inside a row, leave length at 0 to span the row's height.

  @param char - The character to repeat
  @param length - Explicit length (0 lets the parent size it)
  @param fgColor - Color of the line
  @param bold - Use bold weight
  @param dim - Use reduced intensity

**Parameters:**

| Name | Type | Default |
|---|---|---|
| char | `string` | "│" |
| length | `number` | 0 |
| fgColor | `string` | "" |
| bold | `boolean` | false |
| dim | `boolean` | false |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L171))

### row

```ts
row(
  gap: number = 0,
  align: Alignment = "start",
  width: Width = null,
  children: LayoutNode[] = null,
  block: (LayoutBuilder) -> void = null,
): LayoutNode
```

A horizontal container. Children render left to right.

  @param gap - Cells of blank space between children
  @param align - Vertical alignment of shorter children
  @param width - Width as a column count, "X%" of the parent, or "full" for the whole terminal (root only)
  @param children - Pre-built child nodes
  @param block - Trailing builder block, appended after children

**Parameters:**

| Name | Type | Default |
|---|---|---|
| gap | `number` | 0 |
| align | [Alignment](#alignment) | "start" |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L344))

### column

```ts
column(
  gap: number = 0,
  align: Alignment = "start",
  width: Width = null,
  children: LayoutNode[] = null,
  block: (LayoutBuilder) -> void = null,
): LayoutNode
```

A vertical container. Children render top to bottom.

  @param gap - Blank rows between children
  @param align - Horizontal alignment of narrower children
  @param width - Width as a column count, "X%" of the parent, or "full" for the whole terminal (root only)
  @param children - Pre-built child nodes
  @param block - Trailing builder block, appended after children

**Parameters:**

| Name | Type | Default |
|---|---|---|
| gap | `number` | 0 |
| align | [Alignment](#alignment) | "start" |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L383))

### box

```ts
box(
  title: string = "",
  titleColor: string = "",
  borderStyle: BorderStyle = "rounded",
  borderColor: string = "",
  padding: number = 1,
  width: Width = null,
  children: LayoutNode[] = null,
  block: (LayoutBuilder) -> void = null,
): LayoutNode
```

A bordered panel. Multiple children stack vertically inside it.

  @param title - Text shown in the top border (empty for none)
  @param titleColor - Color of the title text
  @param borderStyle - The border character style
  @param borderColor - Color of the border
  @param padding - Cells of padding between the border and content
  @param width - Width as a column count, "X%" of the parent, or "full" for the whole terminal (root only)
  @param children - Pre-built child nodes
  @param block - Trailing builder block, appended after children

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L422))

### render

```ts
render(
  node: LayoutNode,
  color: "auto" | boolean = "auto",
  cols: number = 0,
  rows: number = 0,
): string
```

Render a layout tree to a styled, multi-line string ready to print.

  @param node - The root layout node
  @param color - "auto" emits colors only to a terminal; true always; false strips styling
  @param cols - Width override in columns (0 auto-detects)
  @param rows - Height override in rows (0 uses the default)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | [LayoutNode](#layoutnode) |  |
| color | `"auto" \| boolean` | "auto" |
| cols | `number` | 0 |
| rows | `number` | 0 |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L470))
