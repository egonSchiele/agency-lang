# Elements and Builders

## Element Model

The library uses an **immediate-mode rendering model**. Each render cycle, the consumer builds a fresh element tree describing the entire screen. No mutable widget objects, no retained state — each render is a pure function.

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
- **box** — container with optional border, label, background. Can have children and/or direct text content.
- **text** — styled text content. Inline style tags like `{bold}` and `{red-fg}` are parsed by the style parser.
- **list** — selectable list of items. `selectedIndex` highlights one item. Auto-scrolls to keep selection visible.
- **textInput** — single-line text input with cursor.

### Style Type

See `lib/elements.ts` — the `Style` type has inline comments explaining each field, including what units numbers represent (terminal columns/rows).

### StyleProps

`StyleProps = Style & { key?: string }` — used by builder functions so you can pass `key` alongside style properties.

## Builder Functions (`lib/builders.ts`)

Raw element objects are verbose. Builders provide a concise API:

```typescript
box(style?, ...children)    // generic container
row(style?, ...children)    // box with flexDirection: "row"
column(style?, ...children) // box with flexDirection: "column"
text(content)               // text element
list(style, items, selectedIndex?)
textInput(style, value?)
```

### Overloaded Signatures

`box`, `row`, and `column` accept an optional `StyleProps` as the first argument. The `isStyleProps` guard distinguishes style objects from child elements by checking for the absence of a `type` field.

If the first argument has a `type` field, it's treated as a child element, not a style object.

### splitStyleAndKey

Separates `key` from the rest of the style props. If the remaining style object is empty (no properties), it's set to `undefined` to keep the element clean.

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

`Pick<Style, "border" | "borderColor" | "bg" | "label" | "labelColor">` — the subset of style that applies to frame-level decoration (not content or layout).
