import type { ColorName } from "./colors.js";

export type Element = {
  type: "box" | "text" | "list" | "textInput";
  style?: Style;
  content?: string;
  children?: Element[];
  items?: string[];
  selectedIndex?: number;
  value?: string;
  key?: string;
};

/**
 * Color fields accept either a `ColorName` from the named palette or
 * an arbitrary string (used for hex values like `"#abc"` in the HTML
 * adapter). The `string & {}` intersection preserves autocomplete on
 * the named branch while keeping the string escape hatch.
 */
export type Color = ColorName | (string & {});

export type Style = {
  // Layout
  flexDirection?: "row" | "column";  // default: "column"
  flex?: number;                     // flex grow factor; elements without explicit size default to flex: 1
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";  // main-axis alignment
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";            // cross-axis alignment; default: "stretch"

  // Sizing — numbers are terminal columns/rows, strings are percentages (e.g. "50%")
  width?: number | string;
  height?: number | string;
  minWidth?: number;   // minimum columns
  minHeight?: number;  // minimum rows
  maxWidth?: number;   // maximum columns
  maxHeight?: number;  // maximum rows

  // Spacing — number applies uniformly to all sides; object allows per-side values (in columns/rows)
  padding?: number | { top?: number; bottom?: number; left?: number; right?: number };
  margin?: number | { top?: number; bottom?: number; left?: number; right?: number };

  // Box decoration
  border?: boolean;        // draw a single-line box border (reduces inner area by 1 on each side)
  borderColor?: Color;     // named color (e.g. "cyan", "bright-red") or hex string
  label?: string;          // text rendered into the top border
  labelColor?: Color;      // named color for the label, or hex string

  // Content styling
  fg?: Color;              // foreground color
  bg?: Color;              // background color
  bold?: boolean;

  // Scrolling
  scrollable?: boolean;    // enable scroll viewport
  scrollOffset?: number;   // 0-indexed line offset for the viewport

  visible?: boolean;       // default: true; invisible elements take no space in layout
};

export type StyleProps = Style & { key?: string };

export type Cell = {
  char: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
};

export type FrameStyle = Pick<Style, "border" | "borderColor" | "bg" | "label" | "labelColor">;

export type PositionedElement = Element & {
  resolvedX: number;
  resolvedY: number;
  resolvedWidth: number;
  resolvedHeight: number;
  children?: PositionedElement[];
};
