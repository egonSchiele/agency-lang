---
name: "table"
description: "Build tables for terminal output."
---

# table

Build tables with aligned headers, rows, and footers. Pass the cells as
  arrays, then call `render` from `std::ui/layout` to display the table.
  You can also place a table inside a `box`, `row`, or `column` layout.

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

  Use a trailing block to add rows as you build the table:

  ```ts
  const t = table(title: "Employees") as builder {
    builder.header("ID", "Name", "Balance")
    builder.row("1", "Dave", "100")
    builder.row("2", "Alice", "-50")
    builder.footer("", "Total", "50")
  }
  ```

## Types

### Cell

A table cell. Use a string for plain text or a layout node for styled
  content, such as `text("-50", fgColor: "red")` from `std::ui/layout`.

```ts
/**
  A table cell. Use a string for plain text or a layout node for styled
  content, such as `text("-50", fgColor: "red")` from `std::ui/layout`.
*/
export type Cell = string | LayoutNode
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L41))

### CellRow

One row of cells in a table's body or footer.

```ts
/** One row of cells in a table's body or footer. */
export type CellRow = Cell[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L46))

### ColumnSpec

Configure each column's alignment, width, and text color. Columns without
  a specification use start alignment and size themselves to their content.

  - `align`: horizontal alignment within the column.
  - `minWidth`: minimum content width in terminal cells, excluding padding.
  - `width`: content width in terminal cells, or a percentage of the space
    left after borders, padding, separators, and columns sized by a number
    or their content. `"full"` means `"100%"`. Percentage columns need a
    width set on the table or inherited from a sized box or column layout.
  - `fgColor`: default color for plain strings and uncolored `text` cells.

  Text wraps to the column width. Content that cannot wrap can widen the
  column beyond its requested width.

```ts
/**
  Configure each column's alignment, width, and text color. Columns without
  a specification use start alignment and size themselves to their content.

  - `align`: horizontal alignment within the column.
  - `minWidth`: minimum content width in terminal cells, excluding padding.
  - `width`: content width in terminal cells, or a percentage of the space
    left after borders, padding, separators, and columns sized by a number
    or their content. `"full"` means `"100%"`. Percentage columns need a
    width set on the table or inherited from a sized box or column layout.
  - `fgColor`: default color for plain strings and uncolored `text` cells.

  Text wraps to the column width. Content that cannot wrap can widen the
  column beyond its requested width.
*/
export type ColumnSpec = {
  align?: Alignment;
  minWidth?: number;
  width?: Width;
  fgColor?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L63))

### TableBuilder

Methods available inside a `table` trailing block:

  - `columns(specs)`: replace the column specifications.
  - `caption(text)`: replace the caption.
  - `header(...cells)`: replace the header row.
  - `row(...cells)`: append a body row.
  - `footer(...cells)`: append a footer row.

  These methods also work with data passed in the `table` arguments.

```ts
/**
  Methods available inside a `table` trailing block:

  - `columns(specs)`: replace the column specifications.
  - `caption(text)`: replace the caption.
  - `header(...cells)`: replace the header row.
  - `row(...cells)`: append a body row.
  - `footer(...cells)`: append a footer row.

  These methods also work with data passed in the `table` arguments.
*/
export type TableBuilder = {
  columns: any;
  caption: any;
  header: any;
  row: any;
  footer: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L81))

## Functions

### table

```ts
table(
  title: string = "",
  titleColor: string = "",
  borderStyle: BorderStyle = "rounded",
  borderColor: string = "",
  caption: string = "",
  cellPadding: number = 1,
  width: Width = null,
  columns: ColumnSpec[] = null,
  header: Cell[] = null,
  body: CellRow[] = null,
  footer: CellRow[] = null,
  headerDivider: boolean = true,
  footerDivider: boolean = true,
  rowDividers: boolean = false,
  columnDividers: boolean = true,
  columnGap: number = 0,
  block: (TableBuilder) -> void = null,
): LayoutNode
```

Build a terminal table. Every row must have the same number of cells.
  Call `render` from `std::ui/layout` to display it.

Use the array arguments for existing data, or a trailing block to build
  rows in a loop. The block can replace the header, columns, and caption,
  and append to the supplied body and footer rows.

  With no `width`, the table sizes itself to its content and wraps its
  widest columns to fit the terminal or enclosing layout. With no terminal,
  the available width defaults to 80 cells. Columns with an explicit width
  keep that width. Raw cells do not wrap, so a table containing them can
  exceed the available width.

  Set `borderStyle: "none"` for a table without an outer frame. The divider
  flags still apply. To leave blank space between columns, set
  `columnDividers: false` and choose a `columnGap`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| title | `string` | "" | Title above the rows, placed in the top border when it fits |
| titleColor | `string` | "" |  |
| borderStyle | [BorderStyle](layout.md#borderstyle) | "rounded" | Outer frame style; "none" leaves the divider flags in effect |
| borderColor | `string` | "" |  |
| caption | `string` | "" | Caption shown beneath the table |
| cellPadding | `number` | 1 | Blank terminal cells on each side of a cell's content |
| width | [Width](layout.md#width) | null | Total width in terminal cells, "full", or "N%" of the available width |
| columns | `ColumnSpec[]` | null | One specification per column; percentage widths need a table width set or inherited |
| header | `Cell[]` | null |  |
| body | `CellRow[]` | null |  |
| footer | `CellRow[]` | null |  |
| headerDivider | `boolean` | true |  |
| footerDivider | `boolean` | true |  |
| rowDividers | `boolean` | false | Draw a divider between body rows |
| columnDividers | `boolean` | true |  |
| columnGap | `number` | 0 | Blank terminal cells between columns when columnDividers is false |
| block | `(TableBuilder) => void` | null |  |

**Returns:** [LayoutNode](layout.md#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L139))
