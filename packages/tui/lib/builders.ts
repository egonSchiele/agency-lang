import type { Element, StyleProps } from "./elements.js";

function isStyleProps(arg: any): arg is StyleProps {
  return arg !== null && typeof arg === "object" && !("type" in arg);
}

function splitStyleAndKey(props: StyleProps): { style: Element["style"]; key?: string } {
  const { key, ...style } = props;
  return { style: Object.keys(style).length > 0 ? style : undefined, key };
}

export function box(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  if (styleOrChild === undefined) {
    return { type: "box" };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    return { type: "box", style, key, children: children.length > 0 ? children : undefined };
  }
  return { type: "box", children: [styleOrChild, ...children] };
}

export function row(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  if (styleOrChild === undefined) {
    return { type: "box", style: { flexDirection: "row" } };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    return {
      type: "box",
      style: { ...style, flexDirection: "row" },
      key,
      children: children.length > 0 ? children : undefined,
    };
  }
  return { type: "box", style: { flexDirection: "row" }, children: [styleOrChild, ...children] };
}

export function column(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  if (styleOrChild === undefined) {
    return { type: "box", style: { flexDirection: "column" } };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    return {
      type: "box",
      style: { ...style, flexDirection: "column" },
      key,
      children: children.length > 0 ? children : undefined,
    };
  }
  return { type: "box", style: { flexDirection: "column" }, children: [styleOrChild, ...children] };
}

export function text(content: string): Element {
  return { type: "text", content };
}

export function list(style: StyleProps, items: string[], selectedIndex?: number): Element {
  const { style: resolvedStyle, key } = splitStyleAndKey(style);
  return { type: "list", style: resolvedStyle, key, items, selectedIndex };
}

export function textInput(style: StyleProps, value?: string): Element {
  const { style: resolvedStyle, key } = splitStyleAndKey(style);
  return { type: "textInput", style: resolvedStyle, key, value };
}
