---
name: "chart"
description: "Build horizontal bar charts for terminal layouts."
---

# chart

Draws horizontal bar charts for terminal output. `barChart(...)` returns a
  layout node. Render it with `render` from `std::ui/layout`, so a chart
  nests inside `box` / `row` / `column`. Pass the series and categories
  directly or build them up in a
  trailing block. Each series gets a distinct color and fill symbol when you
  omit them, so charts stay readable even with color disabled. Negative
  values draw left of a zero baseline. Stacked bars must be uniform-sign.

  ```ts
  import { barChart } from "std::ui/chart"
  import { render } from "std::ui/layout"

  const c = barChart(
    title: "Revenue by quarter",
    mode: "stacked",
    keys: [{ name: "web", color: "blue" }, { name: "app", color: "green" }],
    data: [
      { label: "Q1", values: [120, 80] },
      { label: "Q2", values: [98, 90] },
    ],
  )
  print(render(c))
  ```

  The block form builds the same chart imperatively:

  ```ts
  const c = barChart(title: "Revenue", mode: "stacked") as ch {
    ch.key("web", color: "blue")
    ch.key("app", color: "green")
    ch.bar("Q1", 120, 80)
    ch.bar("Q2", 98, 90)
  }
  ```

## Types

### BarKey

A series. `color`/`symbol` auto-assign if omitted.

```ts
/** A series. `color`/`symbol` auto-assign if omitted. */
export type BarKey = {
  name: string;
  color?: string;
  symbol?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/chart.agency#L42))

### Bar

One category. `values` aligns to `keys` by index.

```ts
/** One category. `values` aligns to `keys` by index. */
export type Bar = {
  label: string;
  values: number[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/chart.agency#L49))

### BarMode

```ts
export type BarMode = "stacked" | "grouped"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/chart.agency#L54))

### ChartBuilder

Methods inside a `barChart` trailing `as c { ... }` block.

```ts
/** Methods inside a `barChart` trailing `as c { ... }` block. */
export type ChartBuilder = {
  key: any;
  bar: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/chart.agency#L57))

## Functions

### barChart

```ts
barChart(
  title: string = "",
  mode: BarMode = "grouped",
  keys: BarKey[] = null,
  data: Bar[] = null,
  showValues: boolean = true,
  legend: boolean = true,
  max: number = 0,
  barChar: string = "█",
  width: Width = null,
  block: (ChartBuilder) -> void = null,
): LayoutNode
```

Build a horizontal bar chart to display with std::ui/layout render.
  Stacked values within each category must all have the same sign.

  @param mode - Grouped draws a bar per series; stacked combines them per category
  @param keys - Series definitions; omitted colors and symbols are assigned automatically
  @param data - Categories with values aligned to keys by index
  @param showValues - Show the numeric value beside each bar
  @param legend - Show the series names and symbols
  @param max - Positive axis maximum; longer bars saturate at it, and 0 derives the maximum from data
  @param barChar - Default fill symbol for the first or only series
  @param width - Columns, a percentage of the parent, or "full"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` | "" |
| mode | [BarMode](#barmode) | "grouped" |
| keys | `BarKey[]` | null |
| data | `Bar[]` | null |
| showValues | `boolean` | true |
| legend | `boolean` | true |
| max | `number` | 0 |
| barChar | `string` | "█" |
| width | [Width](layout.md#width) | null |
| block | `(ChartBuilder) => void` | null |

**Returns:** [LayoutNode](layout.md#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/chart.agency#L86))
