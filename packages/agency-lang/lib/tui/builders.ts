import type { Element, Style, StyleProps } from "./elements.js";

function isStyleProps(arg: StyleProps | Element): arg is StyleProps {
  return arg !== null && typeof arg === "object" && !("type" in arg);
}

function splitStyleAndKey(props: StyleProps): { style: Element["style"]; key?: string } {
  const { key, ...style } = props;
  return { style: Object.keys(style).length > 0 ? style : undefined, key };
}

function makeBox(
  extraStyle: Partial<Style>,
  styleOrChild: StyleProps | Element | undefined,
  rest: Element[],
): Element {
  const baseStyle = Object.keys(extraStyle).length > 0 ? extraStyle : undefined;

  if (styleOrChild === undefined) {
    return { type: "box", style: baseStyle };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    const mergedStyle = style || baseStyle ? { ...style, ...extraStyle } : undefined;
    return {
      type: "box",
      style: mergedStyle,
      key,
      children: rest.length > 0 ? rest : undefined,
    };
  }
  return { type: "box", style: baseStyle, children: [styleOrChild, ...rest] };
}

export function box(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  return makeBox({}, styleOrChild, children);
}

export function row(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  return makeBox({ flexDirection: "row" }, styleOrChild, children);
}

export function column(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  return makeBox({ flexDirection: "column" }, styleOrChild, children);
}

export function text(content: string): Element {
  return { type: "text", content };
}

// Single-line text row. Sets `height: 1` so the element doesn't
// stretch via the default `flex: 1` when placed inside a column,
// which is the source of the "every row triple-spaces itself"
// surprise. Caller-provided style is merged on top so `line("hi",
// { height: 2 })` still works.
export function line(content: string, style?: Style): Element {
  return { type: "text", content, style: { height: 1, ...style } };
}

// Convenience: a column of `line()`s. `justifyContent: "flex-start"`
// stops the layout engine from distributing leftover space between
// the children if their combined height is less than the viewport.
export function lines(strings: string[], style?: Style): Element {
  return column(
    { justifyContent: "flex-start", ...style },
    ...strings.map((s) => line(s)),
  );
}

export function list(style: StyleProps, items: string[], selectedIndex?: number): Element {
  const { style: resolvedStyle, key } = splitStyleAndKey(style);
  return { type: "list", style: resolvedStyle, key, items, selectedIndex };
}

export function textInput(style: StyleProps, value?: string): Element {
  const { style: resolvedStyle, key } = splitStyleAndKey(style);
  return { type: "textInput", style: resolvedStyle, key, value };
}
