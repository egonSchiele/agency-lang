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
import { LayoutNode, NodeType, hline, raw, space, text, vline } from "./nodes.js";
import { box } from "./box.js";
import { column, row } from "./axis.js";
import { table } from "./table.js";
import { NodeHandler, SizingContext } from "./sizing.js";

export type Viewport = { cols: number; rows: number };

const DEFAULT_VIEWPORT: Viewport = { cols: 80, rows: 24 };

// Look up a node type's handler, throwing a clear error for unknown
// types. Shared by both passes so the sizing and render passes report
// an unknown node type identically.
function handlerFor(type: NodeType): NodeHandler {
  const handler = HANDLERS[type];
  if (!handler) {
    throw new Error(`std::layout: unknown node type "${type}"`);
  }
  return handler;
}

export function renderNode(node: LayoutNode): Block {
  return handlerFor(node.type).render(node);
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

// Single dispatch table: each node type's size + render paired, sourced
// from the per-concern files that own them.
export const HANDLERS: Record<NodeType, NodeHandler> = {
  box, row, column, table,
  text, raw, space, hline, vline,
};

// Derived views kept so the test surface (`_internal`) and any external
// readers that referenced these keep working.
export const RENDERERS: Record<NodeType, (n: LayoutNode) => Block> = Object.fromEntries(
  Object.entries(HANDLERS).map(([k, h]) => [k, h.render]),
) as Record<NodeType, (n: LayoutNode) => Block>;

export const SIZERS: Record<NodeType, NodeHandler["size"]> = Object.fromEntries(
  Object.entries(HANDLERS).map(([k, h]) => [k, h.size]),
) as Record<NodeType, NodeHandler["size"]>;

export function resolveSizes(node: LayoutNode, viewport: Viewport): LayoutNode {
  // The viewport is the implicit "parent" of the root: it provides the
  // percent basis (so `width: "full"` / `width: "100%"` at the root mean
  // "fill the terminal columns") but does not impose a default width
  // (so unsized roots stay content-driven).
  return resolveNode(node, { defaultWidth: undefined, percentBasis: viewport.cols });
}

export function resolveNode(node: LayoutNode, ctx: SizingContext): LayoutNode {
  return handlerFor(node.type).size(node, ctx);
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
