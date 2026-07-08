---
name: "table"
---

# table

Draws tables for terminal output. `table(...)` returns a layout node whose
  columns line up across header, body, and footer. Render it with `render`
  from `std::ui/layout`, so a table nests inside `box` / `row` / `column`.
  Pass the rows directly (data form, JSON-friendly and LLM-callable) or build
  them up in a trailing block.

  ```ts
  import { table } from "std::ui/table"
  import { render } from "std::ui/layout"

  const t = table(
    title: "Employees",
    header: ["ID", "Name", "Balance"],
    body: [
      ["1", "Dave",  "100"],
      ["2", "Alice", "-50"],
    ],
    footer: [["", "Total", "50"]],
  )
  print(render(t))
  ```

  The block form builds the same table imperatively:

  ```ts
  const t = table(title: "Employees") as t {
    t.header("ID", "Name", "Balance")
    t.row("1", "Dave", "100")
    t.footer("", "Total", "50")
  }
  ```

## Types

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L42))

### CellRow

```ts
export type CellRow = Cell[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L47))

### ColumnSpec

* Per-column configuration for a `table`. All fields are optional.
 * Omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width. `"full"` counts as `"100%"`.
 * @param fgColor - Default foreground color for every cell in this
 *   column that doesn't carry its own `fgColor`.

```ts
/**
 * Per-column configuration for a `table`. All fields are optional.
 * Omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width. `"full"` counts as `"100%"`.
 * @param fgColor - Default foreground color for every cell in this
 *   column that doesn't carry its own `fgColor`.
 */
export type ColumnSpec = {
  align?: Alignment;
  minWidth?: number;
  width?: Width;
  fgColor?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L61))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L73))

## Functions

### table

```ts
table(title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, caption: string, cellPadding: number, width: Width, columns: ColumnSpec[], header: Cell[], body: CellRow[], footer: CellRow[], headerDivider: boolean, footerDivider: boolean, rowDividers: boolean, columnDividers: boolean, block: (TableBuilder) => void): LayoutNode
```

Build a bordered table as a layout node. Pass the data form: `header`,
  `body`, and `footer` as arrays of cells, where every row has the same
  number of cells. Render the returned node to display it.

  @param title - Title shown in the top border
  @param titleColor - Color of the title text
  @param borderStyle - Frame style
  @param borderColor - Color of the border characters
  @param caption - Caption shown beneath the table
  @param cellPadding - Horizontal padding inside each cell, in cells
  @param width - Table width in cells, or "full" / "N%"
  @param columns - Per-column configuration (alignment, width, color)
  @param header - Header cells
  @param body - Body rows, each an array of cells
  @param footer - Footer rows, each an array of cells
  @param headerDivider - Draw a divider line beneath the header
  @param footerDivider - Draw a divider line above the footer
  @param rowDividers - Draw a divider between every body row
  @param columnDividers - Draw vertical dividers between columns

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` | "" |
| titleColor | `string` | "" |
| borderStyle | [BorderStyle](layout.md#borderstyle) | "rounded" |
| borderColor | `string` | "" |
| caption | `string` | "" |
| cellPadding | `number` | 1 |
| width | [Width](layout.md#width) | null |
| columns | `ColumnSpec[]` | null |
| header | `Cell[]` | null |
| body | `CellRow[]` | null |
| footer | `CellRow[]` | null |
| headerDivider | `boolean` | true |
| footerDivider | `boolean` | true |
| rowDividers | `boolean` | false |
| columnDividers | `boolean` | true |
| block | `(TableBuilder) => void` | null |

**Returns:** [LayoutNode](layout.md#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L116))
