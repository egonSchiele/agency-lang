// std::layout — node-type dispatcher + top-level render entry.
//
// `renderNode` is the single recursion point: every container helper
// (axis / box / table) calls back into it to render children, so the
// type-to-renderer mapping lives in exactly one place.
//
// The imports from `axis.ts` / `box.ts` / `table.ts` form a cycle
// with this file (those modules also import `renderNode` from here),
// but the cycle is benign — every use of `renderNode` is inside a
// function body, so module loading completes before any call happens.

import { stripAnsi } from "./ansi.js";
import { Block, pad } from "./block.js";
import { composeColumn, composeRow } from "./axis.js";
import { composeBox } from "./box.js";
import { BORDER_CELLS } from "./border.js";
import { _resolveTableWidths, composeTable } from "./table.js";
import { LEAF_RENDERERS, LayoutNode, NodeType } from "./nodes.js";
import {
  NodeHandler,
  SizingContext,
  innerWidthAfterChrome,
  nonNegativeInteger,
  resolveContainer,
  resolveOwnWidth,
  setAttr,
} from "./sizing.js";

export type Viewport = { cols: number; rows: number };

const DEFAULT_VIEWPORT: Viewport = { cols: 80, rows: 24 };

export const RENDERERS: Record<NodeType, (n: LayoutNode) => Block> = {
  ...LEAF_RENDERERS,
  row:    composeRow,
  column: composeColumn,
  box:    composeBox,
  table:  composeTable,
};

export function renderNode(node: LayoutNode): Block {
  const handler = HANDLERS[node.type];
  if (!handler) {
    throw new Error(`std::layout: unknown node type "${node.type}"`);
  }
  return handler.render(node);
}

export function _viewport(): Viewport {
  return {
    cols: process.stdout.columns ?? DEFAULT_VIEWPORT.cols,
    rows: process.stdout.rows ?? DEFAULT_VIEWPORT.rows,
  };
}

export function growToWidth(block: Block, targetWidth: number): Block {
  if (block.width >= targetWidth) return block;
  return pad(block, targetWidth, block.height, "start", "start");
}

// ---------------------------------------------------------------------------
// Size resolution
// ---------------------------------------------------------------------------
//
// The algorithm is a single top-down walk:
//
//   resolveSizes(node, viewport)
//     = resolveNode(node, { defaultWidth, percentBasis })
//     = SIZERS[node.type](node, ctx)
//
// Each sizer:
//   1. Computes its own `resolvedWidth` from `attrs.width` + the parent's
//      context (`resolveOwnWidth`).
//   2. Derives the context to pass to its children — what default width
//      an unsized child should fill to, and what basis a percentage child
//      computes against.
//   3. Recurses into children via `resolveNode`.
//
// `defaultWidth` is undefined for row children (so unsized siblings stay
// content-driven) but equal to the inner width for box / column children
// (so unsized children fill the parent). `percentBasis` is always the
// container's inner width so percentages always mean "X% of the parent
// I am inside of".
//
// "full" is treated as a synonym for "100%" everywhere — at the root the
// percent basis is the viewport, so `width: "full"` and `width: "100%"`
// both fill the terminal columns; nested they fill the parent's inner
// space.
//
// Resolved values are written onto `attrs.resolvedWidth` (and on `text`
// leaves, `attrs.wrapWidth`). Renderers in box.ts / axis.ts / table.ts
// read these annotations.

type Sizer = (node: LayoutNode, ctx: SizingContext) => LayoutNode;

const SIZERS: Record<NodeType, Sizer> = {
  box:    sizeBox,
  row:    sizeRow,
  column: sizeColumn,
  table:  sizeTable,
  text:   sizeText,
  raw:    passthrough,
  space:  passthrough,
  hline:  passthrough,
  vline:  passthrough,
};

// Single dispatch table pairing each node type's size + render. Declared
// after SIZERS / RENDERERS because it reads both at module-eval time.
export const HANDLERS: Record<NodeType, NodeHandler> = Object.fromEntries(
  (Object.keys(RENDERERS) as NodeType[]).map((t) => [
    t,
    { size: SIZERS[t], render: RENDERERS[t] },
  ]),
) as Record<NodeType, NodeHandler>;

export function resolveSizes(node: LayoutNode, viewport: Viewport): LayoutNode {
  // The viewport is the implicit "parent" of the root: it provides the
  // percent basis (so `width: "full"` / `width: "100%"` at the root mean
  // "fill the terminal columns") but does not impose a default width
  // (so unsized roots stay content-driven).
  return resolveNode(node, { defaultWidth: undefined, percentBasis: viewport.cols });
}

export function resolveNode(node: LayoutNode, ctx: SizingContext): LayoutNode {
  return HANDLERS[node.type].size(node, ctx);
}

// Resolve a node's `width` attribute against the parent's context.
// Returns the concrete cell count the node should occupy, or undefined
// if it is content-driven.
function sizeBox(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const padding = nonNegativeInteger(node.attrs.padding);
  const inner = innerWidthAfterChrome(own, BORDER_CELLS + 2 * padding);
  // Box children either occupy the inner width directly (single child)
  // or are wrapped in an implicit column, which itself fills the inner
  // width. Either way, children fill.
  return resolveContainer(node, own, { defaultWidth: inner, percentBasis: inner });
}

function sizeColumn(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  // Columns stack vertically; horizontal width is shared with every child.
  return resolveContainer(node, own, { defaultWidth: own, percentBasis: own });
}

function sizeRow(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const gap = nonNegativeInteger(node.attrs.gap);
  const gapTotal = Math.max(0, node.children.length - 1) * gap;
  const inner = innerWidthAfterChrome(own, gapTotal);
  // Row children stay natural width unless they declare their own
  // width; percentages compute against the row's inner space.
  return resolveContainer(node, own, { defaultWidth: undefined, percentBasis: inner });
}

function sizeText(node: LayoutNode, ctx: SizingContext): LayoutNode {
  // Text doesn't track a resolvedWidth; instead it gets a wrapWidth so
  // its content wraps to the inline space the parent allocated.
  const own = resolveOwnWidth(node, ctx);
  if (own === undefined) return node;
  return setAttr(node, "wrapWidth", own);
}

function sizeTable(node: LayoutNode, ctx: SizingContext): LayoutNode {
  // Tables have a custom column-width distribution; delegate to the
  // table module after resolving the table's own outer width.
  return _resolveTableWidths(node, resolveOwnWidth(node, ctx));
}

function passthrough(node: LayoutNode, _ctx: SizingContext): LayoutNode {
  return node;
}

export function render(node: LayoutNode, viewport?: Viewport): string {
  const resolved = resolveSizes(node, viewport ?? _viewport());
  return renderNode(resolved).toString();
}

// "auto" color resolution follows the de-facto ecosystem convention:
//   * `NO_COLOR` set (any value)         → disable, no matter what.
//   * `FORCE_COLOR` set to a truthy value → enable, no matter what.
//   * otherwise                           → enable iff stdout is a TTY.
//
// `process.stdout.isTTY` alone is unreliable when Agency runs through
// nested spawns (`pnpm run agency …` spawns the CLI which spawns the
// compiled script); some intermediate hops can drop the TTY flag even
// when the user is at an interactive terminal. The env-var fallbacks
// give the user explicit overrides.
function _autoUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") {
    return true;
  }
  return process.stdout.isTTY === true;
}

function buildViewport(cols?: number, rows?: number): Viewport | undefined {
  if (cols === undefined || cols <= 0) return undefined;
  const validRows = rows !== undefined && rows > 0 ? rows : DEFAULT_VIEWPORT.rows;
  return { cols, rows: validRows };
}

export function _render(node: LayoutNode, color: "auto" | boolean, cols?: number, rows?: number): string {
  const useColor = color === "auto" ? _autoUseColor() : color === true;
  const out = render(node, buildViewport(cols, rows));
  return useColor ? out : stripAnsi(out);
}
