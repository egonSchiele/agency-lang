# Elements and Builders

## Element Model

The library uses an **immediate-mode rendering model**. Each render cycle, the consumer builds a fresh element tree describing the entire screen. There are no mutable widget objects and no retained state, so each render is a pure function.

### Element Type

```typescript
type Element = {
  type: "box" | "text" | "list" | "textInput";
  style?: Style;
  content?: string;       // text content (supports inline style tags)
  children?: Element[];
  items?: string[];       // for list
  selectedIndex?: number; // for list
  value?: string;         // for textInput
  key?: string;           // identity for lookup via findByKey()
};
```

Four element types:
- **box**: a container with optional border, label, background. Can have children and/or direct text content.
- **text**: styled text content. Inline style tags like `{bold}` and `{red-fg}` are parsed by the style parser.
- **list**: a selectable list of items. `selectedIndex` highlights one item. Auto-scrolls to keep selection visible.
- **textInput**: a single-line text input with a cursor.

### Style Type

See `lib/tui/elements.ts`. The `Style` type has inline comments explaining each field, including what units numbers represent. Numbers are terminal columns and rows, and strings are percentages such as `"50%"`.

Color fields take a `Color`, which is either a named color from `lib/tui/colors.ts` or an arbitrary string. The string branch exists so the HTML adapter can pass hex values like `"#abc"`.

### StyleProps

`StyleProps = Style & { key?: string }`. Builder functions take this type so you can pass `key` alongside style properties.

## Builder Functions (`lib/tui/builders.ts`)

Raw element objects are verbose. Builders provide a concise API:

```typescript
box(style?, ...children)    // generic container
row(style?, ...children)    // box with flexDirection: "row"
column(style?, ...children) // box with flexDirection: "column"
text(content)               // text element
line(content, style?)       // text element with height: 1
lines(strings, style?)      // column of line() elements
list(style, items, selectedIndex?)
textInput(style, value?)
```

`text` stretches to fill its parent, because an element without an explicit size defaults to `flex: 1`. `line` sets `height: 1` so a single-line row stays one row tall. Caller style is merged on top, so `line("hi", { height: 2 })` still works. `lines` builds a column of `line()`s and sets `justifyContent: "flex-start"` so the layout engine does not spread the children apart.

### Overloaded Signatures

`box`, `row`, and `column` accept an optional `StyleProps` as the first argument. The `isStyleProps` guard distinguishes style objects from child elements by checking for the absence of a `type` field.

If the first argument has a `type` field, it's treated as a child element, not a style object.

### splitStyleAndKey

Separates `key` from the rest of the style props. If nothing is left in the style object, the builder sets it to `undefined` to keep the element clean.

## PositionedElement

After layout, elements get absolute coordinates:

```typescript
type PositionedElement = Element & {
  resolvedX: number;
  resolvedY: number;
  resolvedWidth: number;
  resolvedHeight: number;
  children?: PositionedElement[];
};
```

## FrameStyle

`Pick<Style, "border" | "borderColor" | "bg" | "label" | "labelColor">` is the subset of style that applies to frame-level decoration, rather than to content or layout.
