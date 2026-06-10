---
name: "layout"
---

# layout

## Module: std::layout

  Declarative text layout for terminal output. Build a tree of
  containers and leaves; call `render` to get an ANSI-styled
  multi-line string ready for `print`.

  Two construction styles, same result:

  - **Trailing block** (ergonomic for Agency authors):

    ```ts
    import { box, render } from "std::layout"

    const panel = box(title: "Hello", padding: 1) as b {
      b.text("Welcome!", bold: true)
      b.text("How are you?")
    }
    print(render(panel))
    ```

  - **Children array** (suitable for LLM tool calls / JSON
    construction):

    ```ts
    import { box, text, render } from "std::layout"

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

  Every container (`box`, `row`, `column`, `table`) accepts a `width`
  parameter:

  - `width: "full"` (root only) fills the terminal columns.
  - `width: 80` sets a target column count.
  - `width: "50%"` takes 50% of the parent's available width.

  Inside a `table`, each `ColumnSpec` accepts the same `width` field.
  A percentage column is sized as a share of the table's remaining
  inner width after borders, cell padding, interior dividers, fixed
  columns, and natural unsized columns.

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
  aliases). `std::layout` is for static text output — splash screens,
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L84))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L95))

### Alignment

```ts
export type Alignment = "start" | "center" | "end"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L106))

### BorderStyle

```ts
export type BorderStyle = "rounded" | "heavy" | "double" | "light"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L108))

### Width

```ts
export type Width = number | "full" | string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L110))

### Cell

* A table cell. Either a bare string (auto-coerced to a styled `text`
 * leaf at render time) or any pre-built LayoutNode (e.g.
 * `text("-50", fgColor: "red")`).

```ts
/**
 * A table cell. Either a bare string (auto-coerced to a styled `text`
 * leaf at render time) or any pre-built LayoutNode (e.g.
 * `text("-50", fgColor: "red")`).
 */
export type Cell = string | LayoutNode
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L117))

### CellRow

```ts
export type CellRow = Cell[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L122))

### ColumnSpec

* Per-column configuration for a `table`. All fields are optional;
 * omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width after fixed and natural unsized
 *   columns. `"full"` is not allowed at the column level.
 * @param fgColor - Default foreground color applied to every cell in
 *   this column that doesn't carry its own `fgColor`. Cell-level
 *   `fgColor` always wins.

```ts
/**
 * Per-column configuration for a `table`. All fields are optional;
 * omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width after fixed and natural unsized
 *   columns. `"full"` is not allowed at the column level.
 * @param fgColor - Default foreground color applied to every cell in
 *   this column that doesn't carry its own `fgColor`. Cell-level
 *   `fgColor` always wins.
 */
export type ColumnSpec = {
  align?: Alignment;
  minWidth?: number;
  width?: Width;
  fgColor?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L138))

### TableBuilder

* Methods available inside a `table`'s trailing `as t { ... }` block.
 * `columns` / `caption` set top-level table attrs; `header` / `row` /
 * `footer` append cell arrays to the corresponding section.

```ts
/**
 * Methods available inside a `table`'s trailing `as t { ... }` block.
 * `columns` / `caption` set top-level table attrs; `header` / `row` /
 * `footer` append cell arrays to the corresponding section.
 */
export type TableBuilder = {
  columns: any;
  caption: any;
  header: any;
  row: any;
  footer: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L150))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L180))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L218))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L235))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L255))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L285))

### _addText

```ts
_addText(kids: any[], content: string, fgColor: string, bgColor: string, bold: boolean, italic: boolean, dim: boolean, underline: boolean, align: Alignment): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| content | `string` |  |
| fgColor | `string` | "" |
| bgColor | `string` | "" |
| bold | `boolean` | false |
| italic | `boolean` | false |
| dim | `boolean` | false |
| underline | `boolean` | false |
| align | [Alignment](markdown.md#alignment) | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L311))

### _addRaw

```ts
_addRaw(kids: any[], content: string, align: Alignment): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| content | `string` |  |
| align | [Alignment](markdown.md#alignment) | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L336))

### _addSpace

```ts
_addSpace(kids: any[], count: number): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| count | `number` | 1 |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L346))

### _addHline

```ts
_addHline(kids: any[], char: string, length: number, fgColor: string, bold: boolean, dim: boolean): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| char | `string` | "─" |
| length | `number` | 0 |
| fgColor | `string` | "" |
| bold | `boolean` | false |
| dim | `boolean` | false |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L352))

### _addVline

```ts
_addVline(kids: any[], char: string, length: number, fgColor: string, bold: boolean, dim: boolean): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| char | `string` | "│" |
| length | `number` | 0 |
| fgColor | `string` | "" |
| bold | `boolean` | false |
| dim | `boolean` | false |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L365))

### _addRow

```ts
_addRow(kids: any[], gap: number, align: Alignment, width: Width, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L378))

### _addColumn

```ts
_addColumn(kids: any[], gap: number, align: Alignment, width: Width, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L391))

### _addBox

```ts
_addBox(kids: any[], title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, padding: number, width: Width, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| title | `string` | "" |
| titleColor | `string` | "" |
| borderStyle | [BorderStyle](#borderstyle) | "rounded" |
| borderColor | `string` | "" |
| padding | `number` | 1 |
| width | [Width](#width) | null |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L404))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): LayoutBuilder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** [LayoutBuilder](#layoutbuilder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L429))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L459))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L500))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L548))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L595))

### _setTableColumns

```ts
_setTableColumns(state: any, specs: ColumnSpec[]): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |
| specs | `ColumnSpec[]` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L610))

### _setTableCaption

```ts
_setTableCaption(state: any, text: string): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |
| text | `string` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L615))

### _setTableHeader

```ts
_setTableHeader(state: any, ...cells: Cell[]): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |
| cells | `Cell[]` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L620))

### _addTableRow

```ts
_addTableRow(state: any, ...cells: Cell[]): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |
| cells | `Cell[]` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L625))

### _addTableFooter

```ts
_addTableFooter(state: any, ...cells: Cell[]): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |
| cells | `Cell[]` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L630))

### _makeTableBuilder

```ts
_makeTableBuilder(state: any): TableBuilder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |

**Returns:** [TableBuilder](#tablebuilder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L635))

### table

```ts
table(title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, caption: string, cellPadding: number, width: Width, columns: ColumnSpec[], header: Cell[], body: CellRow[], footer: CellRow[], headerDivider: boolean, footerDivider: boolean, rowDividers: boolean, columnDividers: boolean, block: (TableBuilder) => void): LayoutNode
```

* Tabular layout. Columns line up across header / body / footer; the
 * outer box uses the same `BorderStyle` enum as `box`. Two construction
 * styles, same result:
 *
 * - **Data form (LLM-callable, JSON-friendly):** pass `header`, `body`,
 *   `footer` as nested arrays of strings or `LayoutNode`s.
 *
 *   ```ts
 *   table(
 *     title: "Employees",
 *     header: ["ID", "Name", "Balance"],
 *     body: [
 *       ["1", "Dave",  "100"],
 *       ["2", "Alice", text("-50", fgColor: "red")],
 *     ],
 *     footer: [["", "Total", "50"]],
 *   )
 *   ```
 *
 * - **Block form (Agency-author ergonomics):**
 *
 *   ```ts
 *   table(title: "Employees") as t {
 *     t.header("ID", "Name", "Balance")
 *     for (item in items) {
 *       t.row(item.id, item.name, "${item.balance}")
 *     }
 *     t.footer("", "Total", "50")
 *   }
 *   ```
 *
 * At least one of `header`, `body`, `footer` must be present (or set
 * via the block). Column count must match across every present section
 * and against `columns.length` if `columns` is set; mismatches throw a
 * render-time error naming the offending row. Cells that are bare
 * strings are auto-coerced to `text(s)`.
 *
 * `text`-typed header cells default to bold. To opt out, set any
 * other style modifier on the leaf — `italic`, `dim`, `underline`,
 * `fgColor`, `bgColor`, or explicit `bold: true`. Note: explicit
 * `bold: false` does NOT opt out (Agency's `text()` constructor
 * emits it by default, so treating it as "set" would mean no
 * `text()` header cell ever got the auto-bold).
 *
 * @param title - Text embedded in the top border. Without an explicit
 *   width, the table grows to fit; with width set, over-long titles wrap
 *   inside the frame.
 * @param titleColor - Color of the title text
 * @param borderStyle - One of `"rounded"`, `"heavy"`, `"double"`, `"light"`
 * @param borderColor - Color of the border characters
 * @param caption - Dim, centered single line drawn BELOW the bottom border
 * @param cellPadding - Spaces of horizontal padding inside each cell (default 1)
 * @param width - Optional width constraint. `"full"` (root only)
 *   fills the terminal columns. `"X%"` takes a percentage of the
 *   parent's available width. A number sets a target column count.
 * @param columns - Per-column align / minWidth (length must equal column count)
 * @param header - Optional header row of cells
 * @param body - Optional body rows
 * @param footer - Optional footer rows (e.g. totals)
 * @param headerDivider - Draw `─` between header and body (default true)
 * @param footerDivider - Draw `─` between body and footer (default true)
 * @param rowDividers - Draw `─` between every body row (default false)
 * @param columnDividers - Draw `│` between cells in every row (default true)
 * @param block - Trailing builder block; appends to any args also passed

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` | "" |
| titleColor | `string` | "" |
| borderStyle | [BorderStyle](#borderstyle) | "rounded" |
| borderColor | `string` | "" |
| caption | `string` | "" |
| cellPadding | `number` | 1 |
| width | [Width](#width) | null |
| columns | `ColumnSpec[]` | null |
| header | `Cell[]` | null |
| body | `CellRow[]` | null |
| footer | `CellRow[]` | null |
| headerDivider | `boolean` | true |
| footerDivider | `boolean` | true |
| rowDividers | `boolean` | false |
| columnDividers | `boolean` | true |
| block | `(TableBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L711))
