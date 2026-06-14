---
name: "chart"
---

# chart

## Module: std::chart

  Horizontal bar charts for terminal output. A `barChart(...)` returns a
  layout node; render it with `render` from `std::layout`, so a chart
  nests inside `box` / `row` / `column`.

  Two construction styles, same result:

  - **Data form (LLM-callable, JSON-friendly):** pass `keys` and `data`
    arrays. `data[i].values` aligns to `keys` by index.

    ```ts
    import { barChart } from "std::chart"
    import { render } from "std::layout"

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

  - **Block form (Agency-author ergonomics):**

    ```ts
    const c = barChart(title: "Revenue", mode: "stacked") as ch {
      ch.key("web", color: "blue")
      ch.key("app", color: "green")
      ch.bar("Q1", 120, 80)
      ch.bar("Q2", 98, 90)
    }
    ```

  Keys get a distinct color and fill symbol automatically when omitted,
  so charts stay readable even when color is disabled. Negative values
  draw left of a zero baseline; stacked bars must be uniform-sign.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/chart.agency#L48))

### Bar

One category. `values` aligns to `keys` by index.

```ts
/** One category. `values` aligns to `keys` by index. */
export type Bar = {
  label: string;
  values: number[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/chart.agency#L55))

### BarMode

```ts
export type BarMode = "stacked" | "grouped"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/chart.agency#L60))

### ChartBuilder

Methods inside a `barChart` trailing `as c { ... }` block.

```ts
/** Methods inside a `barChart` trailing `as c { ... }` block. */
export type ChartBuilder = {
  key: any;
  bar: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/chart.agency#L63))

## Functions

### barChart

```ts
barChart(title: string, mode: BarMode, keys: BarKey[], data: Bar[], showValues: boolean, legend: boolean, max: number, barChar: string, width: Width, block: (ChartBuilder) => void): LayoutNode
```

Render a horizontal bar chart as a layout node. When calling this as
  an LLM tool, use the data form: pass `keys` (one per series) and
  `data` (one entry per category, whose `values` array lines up with
  `keys` by index). Render the result with `render` from `std::layout`.

  @param title - Heading shown above the chart
  @param mode - "grouped" draws one bar per key; "stacked" stacks the keys into one bar
  @param keys - Series definitions. Each key may set a color (a termcolors name like "blue" or a hex string like "#cc7a4a") and a fill symbol; both auto-assign when omitted
  @param data - Categories to plot. Each has a `label` and a positional `values` array aligned to `keys`
  @param showValues - Show the numeric value beside each bar
  @param legend - Show a legend listing the named keys
  @param max - Fix the axis maximum (a positive number; values beyond it saturate at a full bar). 0 derives it from the data
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/chart.agency#L92))
