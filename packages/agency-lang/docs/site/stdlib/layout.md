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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L56))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L67))

## Functions

### text

```ts
text(content: string, fgColor: string, bgColor: string, bold: boolean, italic: boolean, dim: boolean, underline: boolean, align: "start" | "center" | "end"): LayoutNode
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
 * @param align - Horizontal alignment within the rendered Block

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
| align | `"start" \| "center" \| "end"` | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L97))

### raw

```ts
raw(content: string, align: "start" | "center" | "end"): LayoutNode
```

* A pre-styled string. The content is rendered as-is and is **not**
 * wrapped in any outer styling — if the embedded string carries its
 * own ANSI sequences, nesting it inside a styled `text` or a styled
 * `box` will not re-apply styling after the inner sequences reset.
 * Use this for ASCII art, comic panels, or strings whose styling is
 * already baked in.
 *
 * @param content - Raw string content (may contain ANSI / newlines)
 * @param align - Horizontal alignment within the rendered Block

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |
| align | `"start" \| "center" \| "end"` | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L134))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L151))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L165))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L195))

### _addText

```ts
_addText(kids: any[], content: string, fgColor: string, bgColor: string, bold: boolean, italic: boolean, dim: boolean, underline: boolean, align: "start" | "center" | "end"): LayoutNode
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
| align | `"start" \| "center" \| "end"` | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L221))

### _addRaw

```ts
_addRaw(kids: any[], content: string, align: "start" | "center" | "end"): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| content | `string` |  |
| align | `"start" \| "center" \| "end"` | "start" |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L246))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L256))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L262))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L277))

### _addRow

```ts
_addRow(kids: any[], gap: number, align: "start" | "center" | "end", children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| gap | `number` | 0 |
| align | `"start" \| "center" \| "end"` | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L292))

### _addColumn

```ts
_addColumn(kids: any[], gap: number, align: "start" | "center" | "end", children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| gap | `number` | 0 |
| align | `"start" \| "center" \| "end"` | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L304))

### _addBox

```ts
_addBox(kids: any[], title: string, titleColor: string, borderStyle: "rounded" | "heavy" | "double" | "light", borderColor: string, padding: number, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| title | `string` | "" |
| titleColor | `string` | "" |
| borderStyle | `"rounded" \| "heavy" \| "double" \| "light"` | "rounded" |
| borderColor | `string` | "" |
| padding | `number` | 0 |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L316))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): LayoutBuilder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** [LayoutBuilder](#layoutbuilder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L339))

### row

```ts
row(gap: number, align: "start" | "center" | "end", children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
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
| align | `"start" \| "center" \| "end"` | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L366))

### column

```ts
column(gap: number, align: "start" | "center" | "end", children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
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
| align | `"start" \| "center" \| "end"` | "start" |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L396))

### box

```ts
box(title: string, titleColor: string, borderStyle: "rounded" | "heavy" | "double" | "light", borderColor: string, padding: number, children: LayoutNode[], block: (LayoutBuilder) => void): LayoutNode
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
| borderStyle | `"rounded" \| "heavy" \| "double" \| "light"` | "rounded" |
| borderColor | `string` | "" |
| padding | `number` | 1 |
| children | `LayoutNode[]` | null |
| block | `(LayoutBuilder) => void` | null |

**Returns:** [LayoutNode](#layoutnode)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L432))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/layout.agency#L471))
