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

export type Style = {
  flexDirection?: "row" | "column";
  flex?: number;
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  width?: number | string;
  height?: number | string;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  padding?: number | { top?: number; bottom?: number; left?: number; right?: number };
  margin?: number | { top?: number; bottom?: number; left?: number; right?: number };
  border?: boolean;
  borderColor?: string;
  label?: string;
  labelColor?: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  scrollable?: boolean;
  scrollOffset?: number;
  visible?: boolean;
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
