---
name: "chart"
description: "Draws horizontal bar charts for terminal output; barChart(...) returns a layout node you render with std::ui/layout."
---

# chart

Draws horizontal bar charts for terminal output. `barChart(...)` returns a
  layout node. Render it with `render` from `std::ui/layout`, so a chart
  nests inside `box` / `row` / `column`. Pass the series and categories
  directly (data form, JSON-friendly and LLM-callable) or build them up in a
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

Build a horizontal bar chart as a layout node. Pass the data form:
  `keys` (one per series) and `data` (one entry per category, whose
  `values` array lines up with `keys` by index). Render the returned
  node to display it.

  @param title - Heading shown above the chart
  @param mode - "grouped" draws one bar per key; "stacked" stacks the keys into one bar
  @param keys - Series definitions. Each key may set a color (a color name like "blue" or a hex string like "#cc7a4a") and a fill symbol. Both auto-assign when omitted
  @param data - Categories to plot. Each has a `label` and a positional `values` array aligned to `keys`
  @param showValues - Show the numeric value beside each bar
  @param legend - Show a legend listing the named keys
  @param max - Fix the axis maximum to a positive number; values beyond it saturate at a full bar. 0 derives it from the data
  @param barChar - Default fill cell for the first / single series
  @param width - Chart width in cells, or "full" / "N%"

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
