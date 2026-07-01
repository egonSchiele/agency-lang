---
name: "table"
---

# table

## Module: std::ui/table

  Tabular layout for terminal output. Columns line up across header /
  body / footer; the outer frame uses the same `BorderStyle` enum as
  `std::ui/layout`'s `box`. Two construction styles, same result:

  - **Data form (LLM-callable, JSON-friendly):** pass `header`, `body`,
    `footer` as nested arrays of strings or `LayoutNode`s.

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

  - **Block form (Agency-author ergonomics):**

    ```ts
    const t = table(title: "Employees") as t {
      t.header("ID", "Name", "Balance")
      t.row("1", "Dave", "100")
      t.footer("", "Total", "50")
    }
    ```

  Render a table with `render`, imported from `std::ui/layout`:
  `import { render } from "std::ui/layout"`.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L48))

### CellRow

```ts
export type CellRow = Cell[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L53))

### ColumnSpec

* Per-column configuration for a `table`. All fields are optional;
 * omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width; `"full"` is treated as `"100%"`.
 * @param fgColor - Default foreground color for every cell in this
 *   column that doesn't carry its own `fgColor`.

```ts
/**
 * Per-column configuration for a `table`. All fields are optional;
 * omitted columns default to start-aligned with no minimum width.
 *
 * @param align - Horizontal alignment of every cell in this column
 * @param minWidth - Lower bound on column width; widens narrow columns
 * @param width - Optional per-column constraint. A number caps the
 *   column's content width in cells. `"X%"` takes a percentage of the
 *   table's remaining inner width; `"full"` is treated as `"100%"`.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L67))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L79))

## Functions

### table

```ts
table(title: string, titleColor: string, borderStyle: BorderStyle, borderColor: string, caption: string, cellPadding: number, width: Width, columns: ColumnSpec[], header: Cell[], body: CellRow[], footer: CellRow[], headerDivider: boolean, footerDivider: boolean, rowDividers: boolean, columnDividers: boolean, block: (TableBuilder) => void): LayoutNode
```

Render data as a bordered table layout node. When calling this as an
  LLM tool, use the data form: pass `header`, `body`, and `footer` as
  arrays of cells (every row must have the same number of cells).
  Render the result with `render`.

  @param title - Title shown in the top border
  @param caption - Caption shown beneath the table
  @param columns - Per-column configuration (alignment, width, color)
  @param header - Header cells
  @param body - Body rows, each an array of cells
  @param footer - Footer rows, each an array of cells
  @param borderStyle - Frame style: "rounded", "heavy", "double", or "light"
  @param cellPadding - Horizontal padding inside each cell, in cells
  @param width - Table width in cells, or "full" / "N%"

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/table.agency#L122))
