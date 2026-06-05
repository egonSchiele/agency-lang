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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L61))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L72))

### Alignment

```ts
export type Alignment = "start" | "center" | "end"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L83))

### BorderStyle

```ts
export type BorderStyle = "rounded" | "heavy" | "double" | "light"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L85))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L92))

### CellRow

```ts
export type CellRow = Cell[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L97))

### ColumnSpec

* Per-column configuration for a `table`. All fields are optional;
 * omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
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
 * @param fgColor - Default foreground color applied to every cell in
 *   this column that doesn't carry its own `fgColor`. Cell-level
 *   `fgColor` always wins.
 */
export type ColumnSpec = {
  align?: Alignment;
  minWidth?: number;
  fgColor?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L109))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L120))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L150))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L188))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L205))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L225))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L255))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L281))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L306))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L316))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L322))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L335))

### _addRow

```ts
_addRow(kids: any[], gap: number, align: Alignment, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L348))

### _addColumn

```ts
_addColumn(kids: any[], gap: number, align: Alignment, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L360))

### _addBox

```ts
_addBox(kids: any[], title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, padding: number, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
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
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L372))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): LayoutBuilder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** [LayoutBuilder](#layoutbuilder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L395))

### row

```ts
row(gap: number, align: Alignment, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

* A horizontal container. Children render left-to-right.
 *
 * @param gap - Cells of blank space between siblings
 * @param align - Cross-axis (vertical) alignment of shorter children
 * @param children - Pre-built children (LLM / JSON construction)
 * @param block - Trailing builder block; appended after `children`

**Parameters:**

| Name | Type | Default |
|---|---|---|
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L422))

### column

```ts
column(gap: number, align: Alignment, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

* A vertical container. Children render top-to-bottom.
 *
 * @param gap - Blank rows between siblings
 * @param align - Cross-axis (horizontal) alignment of narrower children
 * @param children - Pre-built children
 * @param block - Trailing builder block

**Parameters:**

| Name | Type | Default |
|---|---|---|
| gap | `number` | 0 |
| align | [Alignment](markdown.md#alignment) | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L455))

### box

```ts
box(title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, padding: number, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

* A bordered panel. When given more than one child (or built via a
 * block with multiple builder calls), the children are stacked in an
 * implicit `column`.
 *
 * @param title - Text embedded in the top border (no truncation; box
 *   grows to fit). Empty string for no title.
 * @param titleColor - Color of the title text
 * @param borderStyle - One of `"rounded"`, `"heavy"`, `"double"`, `"light"`
 * @param borderColor - Color of the border characters
 * @param padding - Cells of padding between border and content
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
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L494))

### render

```ts
render(node: LayoutNode, color: "auto" | boolean): string
```

* Render a layout tree to a string.
 *
 * @param node - Root of the layout tree
 * @param color - `"auto"` (default) emits ANSI sequences only when stdout
 *   is a TTY. `true` always emits them. `false` strips all styling for
 *   plain ASCII output (logs, non-TTY consumers).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | [LayoutNode](#layoutnode) |  |
| color | `"auto" \| boolean` | "auto" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L533))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L546))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L551))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L556))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L561))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L566))

### _makeTableBuilder

```ts
_makeTableBuilder(state: any): TableBuilder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `any` |  |

**Returns:** [TableBuilder](#tablebuilder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L571))

### table

```ts
table(title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, caption: string, cellPadding: number, columns: ColumnSpec[], header: Cell[], body: CellRow[], footer: CellRow[], headerDivider: boolean, footerDivider: boolean, rowDividers: boolean, columnDividers: boolean, block: (TableBuilder) => void): LayoutNode
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
 * @param title - Text embedded in the top border; box grows to fit
 * @param titleColor - Color of the title text
 * @param borderStyle - One of `"rounded"`, `"heavy"`, `"double"`, `"light"`
 * @param borderColor - Color of the border characters
 * @param caption - Dim, centered single line drawn BELOW the bottom border
 * @param cellPadding - Spaces of horizontal padding inside each cell (default 1)
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/layout.agency#L642))
