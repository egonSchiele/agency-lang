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
import { _resolveTableWidths, composeTable } from "./table.js";
import { LEAF_RENDERERS, LayoutNode, NodeType, parseWidth } from "./nodes.js";

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
  const renderer = RENDERERS[node.type];
  if (!renderer) {
    throw new Error(`std::layout: unknown node type "${node.type}"`);
  }
  return renderer(node);
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

export function resolveSizes(node: LayoutNode, viewport: Viewport): LayoutNode {
  const rootWidth = resolveRootWidth(node, viewport);
  return resolveNode(node, rootWidth);
}

export function resolveNode(node: LayoutNode, resolvedWidth: number | undefined): LayoutNode {
  if (node.type === "table") {
    return _resolveTableWidths(node, resolvedWidth);
  }
  if (node.children.length === 0) {
    return annotate(node, resolvedWidth, undefined);
  }

  const available = resolvedWidth !== undefined
    ? Math.max(0, resolvedWidth - chromeWidth(node))
    : undefined;
  const resolvedChildren = node.children.map((child) =>
    resolveChild(node, child, available),
  );

  return {
    ...node,
    attrs: annotateAttrs(node.attrs, resolvedWidth, undefined),
    children: resolvedChildren,
  };
}

function resolveRootWidth(node: LayoutNode, viewport: Viewport): number | undefined {
  const width = parseWidth(node.attrs.width);
  if (width === null) return undefined;
  if (width.kind === "cells") return width.value;
  if (width.kind === "full") return viewport.cols;
  throw new Error(
    `std::layout: width "${node.attrs.width}" on root has no parent ` +
    `to take a percentage of. Use "full" or a number.`,
  );
}

function resolveChild(parent: LayoutNode, child: LayoutNode, available: number | undefined): LayoutNode {
  const childWidth = resolveChildWidth(parent, child, available);
  const implicitWidth = parent.type === "row" ? undefined : available;
  if (child.type === "text") return annotate(child, undefined, childWidth ?? implicitWidth);
  if (child.type === "raw") return child;
  if (isContainer(child)) return resolveNode(child, childWidth ?? implicitWidth);
  return resolveNode(child, childWidth);
}

function resolveChildWidth(
  parent: LayoutNode,
  child: LayoutNode,
  available: number | undefined,
): number | undefined {
  const width = parseWidth(child.attrs.width);
  if (width === null) return undefined;
  if (width.kind === "cells") return width.value;
  if (width.kind === "full") {
    throw new Error(
      `std::layout: width "full" is only valid at the root. ` +
      `Use "100%" if you mean "fill the parent".`,
    );
  }
  if (available === undefined) {
    throw new Error(
      `std::layout: child uses width "${child.attrs.width}" but the ` +
      `parent ${parent.type} has no resolved width to take a percentage of. ` +
      `Set a width on the parent or one of its ancestors.`,
    );
  }
  return Math.floor((available * width.value) / 100);
}

function isContainer(node: LayoutNode): boolean {
  return node.type === "box" || node.type === "row" || node.type === "column" || node.type === "table";
}

function chromeWidth(node: LayoutNode): number {
  if (node.type === "box") {
    const padding = nonNegativeInteger((node.attrs.padding as number | undefined) ?? 0);
    return 2 + 2 * padding;
  }
  if (node.type === "row") {
    const gap = nonNegativeInteger((node.attrs.gap as number | undefined) ?? 0);
    return Math.max(0, node.children.length - 1) * gap;
  }
  return 0;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function annotate(
  node: LayoutNode,
  resolvedWidth: number | undefined,
  wrapWidth: number | undefined,
): LayoutNode {
  return { ...node, attrs: annotateAttrs(node.attrs, resolvedWidth, wrapWidth) };
}

function annotateAttrs(
  attrs: Record<string, unknown>,
  resolvedWidth: number | undefined,
  wrapWidth: number | undefined,
): Record<string, unknown> {
  return {
    ...attrs,
    ...(resolvedWidth !== undefined ? { resolvedWidth } : {}),
    ...(wrapWidth !== undefined ? { wrapWidth } : {}),
  };
}

export function render(node: LayoutNode, opts?: { viewport?: Viewport }): string {
  const resolved = resolveSizes(node, opts?.viewport ?? _viewport());
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

export function _render(node: LayoutNode, color: "auto" | boolean, cols?: number, rows?: number): string {
  const useColor = color === "auto" ? _autoUseColor() : color === true;
  const viewport = cols !== undefined && cols > 0
    ? { cols, rows: rows !== undefined && rows > 0 ? rows : DEFAULT_VIEWPORT.rows }
    : undefined;
  const out = render(node, { viewport });
  return useColor ? out : stripAnsi(out);
}
