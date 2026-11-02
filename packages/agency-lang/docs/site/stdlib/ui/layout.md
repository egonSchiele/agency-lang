---
name: "layout"
description: "Build terminal layouts from boxes, rows, columns, and styled text."
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
  `"50%"` of the parent, or `"full"` for the parent width (the terminal at the root). Content wraps to
  fit its container; pass `wrap: false` to `raw` to preserve exact layout
  (ASCII art, pre-rendered tables). Unsized containers shrink to fit their
  content but cap at the available width, wrapping anything longer.

  For prompts that read a key or a line, use `std::ui/cli`.

## Types

### LayoutNode

Every layout node has the same shape. Containers carry their
content in `children`; leaves have `children: []`.

```ts
/**
Every layout node has the same shape. Containers carry their
content in `children`; leaves have `children: []`.
*/
export type LayoutNode = {
  type: string;
  attrs: any;
  children: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L32))

### LayoutBuilder

Methods inside a container's trailing `as name { ... }` block. Each
method constructs a leaf or container and pushes it onto the
surrounding container's `children` array.

```ts
/**
Methods inside a container's trailing `as name { ... }` block. Each
method constructs a leaf or container and pushes it onto the
surrounding container's `children` array.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L43))

### Alignment

```ts
export type Alignment = "start" | "center" | "end"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L54))

### BorderStyle

```ts
export type BorderStyle = "rounded" | "heavy" | "double" | "light" | "none"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L56))

### Width

A column count, a percentage such as "50%", or "full" for the parent width.

```ts
/** A column count, a percentage such as "50%", or "full" for the parent width. */
export type Width = number | "full" | string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L59))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| content | `string` |  |  |
| fgColor | `string` | "" | Foreground color, named ("red") or hex ("#cc7a4a") |
| bgColor | `string` | "" | Background color, named or hex |
| bold | `boolean` | false |  |
| italic | `boolean` | false |  |
| dim | `boolean` | false | Use reduced intensity |
| underline | `boolean` | false |  |
| align | [Alignment](#alignment) | "start" | For multi-line text, how shorter lines align to the longest |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L67))

### raw

```ts
raw(
  content: string,
  align: Alignment = "start",
  wrap: boolean = true,
): LayoutNode
```

Build a layout node from text with existing ANSI styling or newlines.

Use `wrap: false` for ASCII art or tables whose spacing must stay intact.
Wrapping preserves ANSI colors without bleeding into surrounding borders.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| content | `string` |  |  |
| align | [Alignment](#alignment) | "start" | How shorter lines align to the longest |
| wrap | `boolean` | true | Reflow to the container width; false preserves exact spacing |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L103))

### space

```ts
space(count: number = 1): LayoutNode
```

Blank space. Inside a row it adds columns; inside a column, rows.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| count | `number` | 1 | Number of cells of blank space |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L121))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| char | `string` | "─" | The character to repeat |
| length | `number` | 0 | Explicit length (0 lets the parent size it) |
| fgColor | `string` | "" | Color of the line |
| bold | `boolean` | false |  |
| dim | `boolean` | false | Use reduced intensity |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L136))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| char | `string` | "│" | The character to repeat |
| length | `number` | 0 | Explicit length (0 lets the parent size it) |
| fgColor | `string` | "" | Color of the line |
| bold | `boolean` | false |  |
| dim | `boolean` | false | Use reduced intensity |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L164))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| gap | `number` | 0 | Cells of blank space between children |
| align | [Alignment](#alignment) | "start" | Vertical alignment of shorter children |
| width | [Width](#width) | null | Columns, a percentage of the parent, or "full" for the parent width |
| children | `LayoutNode[]` | null | Pre-built child nodes |
| block | `(LayoutBuilder) => void` | null | Trailing builder block, appended after children |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L336))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| gap | `number` | 0 | Blank rows between children |
| align | [Alignment](#alignment) | "start" | Horizontal alignment of narrower children |
| width | [Width](#width) | null | Columns, a percentage of the parent, or "full" for the parent width |
| children | `LayoutNode[]` | null | Pre-built child nodes |
| block | `(LayoutBuilder) => void` | null | Trailing builder block, appended after children |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L375))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| title | `string` | "" | Text shown in the top border (empty for none) |
| titleColor | `string` | "" | Color of the title text |
| borderStyle | [BorderStyle](#borderstyle) | "rounded" | The border character style; "none" draws no frame (padding and title still apply, the title as a plain first line) |
| borderColor | `string` | "" | Color of the border |
| padding | `number` | 1 | Cells of padding between the border and content |
| width | [Width](#width) | null | Columns, a percentage of the parent, or "full" for the parent width |
| children | `LayoutNode[]` | null | Pre-built child nodes |
| block | `(LayoutBuilder) => void` | null | Trailing builder block, appended after children |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L414))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| node | [LayoutNode](#layoutnode) |  |  |
| color | `"auto" \| boolean` | "auto" | "auto" uses terminal color support; true always; false strips styling |
| cols | `number` | 0 | Width override in columns (0 auto-detects) |
| rows | `number` | 0 | Height override in rows (0 uses the default) |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/layout.agency#L465))
