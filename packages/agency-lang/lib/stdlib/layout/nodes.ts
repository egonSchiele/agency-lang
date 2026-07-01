// std::ui/layout — node tree types + leaf renderers.
//
// Every value the Agency side passes to `render()` is a `LayoutNode`.
// Containers (row / column / box / table) live in their own files and
// recurse via `renderNode`; the leaves (text / raw / space / hline /
// vline) live here.

import { Style, wrapText } from "./ansi.js";
import { Align, Block, pad, styled } from "./block.js";
import { NodeHandler, SizingContext, resolveOwnWidth, setAttr } from "./sizing.js";

export type NodeType =
  | "box" | "row" | "column"
  | "text" | "raw" | "space" | "hline" | "vline"
  | "table" | "barchart";

export type LayoutNode = {
  type: NodeType;
  attrs: Record<string, unknown>;
  children: LayoutNode[];
};

// `Cell` is the shape every entry of `header` / `body` / `footer`
// arrives as on a `table` node: either a bare string (which we coerce
// to a `text` leaf at render time) or a fully built `LayoutNode`. The
// type only exists at the type level; runtime decoding happens in
// `_coerceCell` (table.ts) at the table-handler boundary.
export type Cell = string | LayoutNode;

// The on-the-wire `width` value users write in Agency code: a positive
// number of cells, the literal `"full"`, or a `"<n>%"` string. Validated
// at runtime by `parseWidth`.
export type WidthInput = number | "full" | string;

export type ColumnSpec = {
  align?:    Align;
  minWidth?: number;
  width?:    WidthInput;
  fgColor?:  string;
};

// Result of `parseWidth`: a closed sum type that downstream sizers
// pattern-match on. `"full"` is preserved as its own kind for clarity
// at debug time, but the resolver treats it as a synonym for `100%`.
export type Width =
  | { kind: "cells";   value: number }
  | { kind: "full" }
  | { kind: "percent"; value: number };

export function parseWidth(raw: unknown): Width | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { kind: "cells", value: Math.max(0, Math.floor(raw)) };
  }
  if (raw === "full") return { kind: "full" };
  if (typeof raw === "string") {
    const match = raw.match(/^(\d+(?:\.\d+)?)%$/);
    if (match) return { kind: "percent", value: parseFloat(match[1]) };
  }
  throw new Error(
    `std::ui/layout: invalid width ${JSON.stringify(raw)}. ` +
    `Expected a number, "full", or "<n>%" (e.g. "50%").`,
  );
}

export function styleOf(attrs: Record<string, unknown>): Style {
  const s: Style = {};
  if (typeof attrs.fgColor === "string"  && attrs.fgColor)  s.fgColor  = attrs.fgColor;
  if (typeof attrs.bgColor === "string"  && attrs.bgColor)  s.bgColor  = attrs.bgColor;
  if (attrs.bold      === true) s.bold      = true;
  if (attrs.italic    === true) s.italic    = true;
  if (attrs.dim       === true) s.dim       = true;
  if (attrs.underline === true) s.underline = true;
  return s;
}

// Build the text/raw block for a leaf with `content` (possibly
// multi-line). `align` controls how short lines sit relative to the
// longest line of the block. For single-line content this is a no-op
// (width = own width). The block is always returned as a tidy
// rectangle (every line padded to the same width) so downstream
// `beside` / `above` composition is well-behaved.
export function alignedTextBlock(content: string, align: Align): Block {
  const block = Block.of(content);
  return pad(block, block.width, block.height, align, "start");
}

// Coerce a leaf node's `content` attr to a string before rendering.
// `text`/`raw` are typed `content: string`, but Agency code passes
// `any` through dynamic data (e.g. interrupt payloads), so a number,
// boolean, or object can reach here at runtime. Coercing — rather than
// calling `.split` on whatever arrives — keeps `render` from throwing
// `content.split is not a function` and turning the whole frame into a
// Failure. `null`/`undefined` render as empty, matching the old `?? ""`.
function asString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return String(content);
}

// Renderers for the leaf node types only. Containers (row / column /
// box / table) are assembled into the full RENDERERS table in
// `render.ts`.
export const LEAF_RENDERERS: Record<
  "text" | "raw" | "space" | "hline" | "vline",
  (n: LayoutNode) => Block
> = {
  text: (n) => {
    const content   = asString(n.attrs.content);
    const align     = (n.attrs.align as Align) ?? "start";
    const wrapWidth = n.attrs.wrapWidth as number | undefined;
    const lines = wrapWidth !== undefined ? wrapText(content, wrapWidth) : content.split("\n");
    const block = Block.of(lines);
    return styled(pad(block, block.width, block.height, align, "start"), styleOf(n.attrs));
  },
  raw: (n) => {
    const content = asString(n.attrs.content);
    const align   = (n.attrs.align as Align) ?? "start";
    return alignedTextBlock(content, align);
  },
  space: (_n) => {
    throw new Error(
      "std::ui/layout: `space` must be resolved by its parent row/column. " +
      "Found one outside a container at render time.",
    );
  },
  hline: (n) => {
    const length = n.attrs.length as number | undefined;
    if (length == null || length === 0) {
      throw new Error(
        "std::ui/layout: bare `hline()` (no `length`) must be resolved by " +
        "its parent column. Found one outside a container at render time.",
      );
    }
    const char = (n.attrs.char as string) ?? "─";
    return styled(Block.of(char.repeat(length)), styleOf(n.attrs));
  },
  vline: (n) => {
    const length = n.attrs.length as number | undefined;
    if (length == null || length === 0) {
      throw new Error(
        "std::ui/layout: bare `vline()` (no `length`) must be resolved by " +
        "its parent row. Found one outside a container at render time.",
      );
    }
    const char = (n.attrs.char as string) ?? "│";
    return styled(Block.of(Array(length).fill(char)), styleOf(n.attrs));
  },
};

function sizeText(node: LayoutNode, ctx: SizingContext): LayoutNode {
  // Text doesn't track a resolvedWidth; instead it gets a wrapWidth so
  // its content wraps to the inline space the parent allocated.
  const own = resolveOwnWidth(node, ctx);
  if (own === undefined) return node;
  return setAttr(node, "wrapWidth", own);
}

function passthrough(node: LayoutNode, _ctx: SizingContext): LayoutNode {
  return node;
}

export const text:  NodeHandler = { size: sizeText,    render: LEAF_RENDERERS.text };
export const raw:   NodeHandler = { size: passthrough, render: LEAF_RENDERERS.raw };
export const space: NodeHandler = { size: passthrough, render: LEAF_RENDERERS.space };
export const hline: NodeHandler = { size: passthrough, render: LEAF_RENDERERS.hline };
export const vline: NodeHandler = { size: passthrough, render: LEAF_RENDERERS.vline };
