// std::layout — shared width-resolution helpers + handler type used by
// every node type's `size` half. Extracted from render.ts so per-concern
// handler files can import them without depending on the whole dispatcher.
//
// The import of `resolveNode` from render.ts forms a benign cycle: it is
// only ever called inside `resolveContainer`'s function body, so module
// loading completes before any call happens (same pattern the renderers
// already use for `renderNode`).
import { Block } from "./block.js";
import { LayoutNode, parseWidth } from "./nodes.js";
import { resolveNode } from "./render.js";

export type SizingContext = {
  // The width an unsized node should adopt. Undefined when the parent
  // does not impose a width on its children (e.g. row children).
  defaultWidth: number | undefined;
  // The width that percentages and "full" compute against. Undefined
  // when no enclosing ancestor has a resolved width.
  percentBasis: number | undefined;
};

// One node type's two behaviors, paired. `size` is phase 1 (resolve
// widths top-down); `render` is phase 2 (paint to a Block).
export type NodeHandler = {
  size: (node: LayoutNode, ctx: SizingContext) => LayoutNode;
  render: (node: LayoutNode) => Block;
};

// Resolve a node's `width` attribute against the parent's context.
// Returns the concrete cell count the node should occupy, or undefined
// if it is content-driven.
export function resolveOwnWidth(node: LayoutNode, ctx: SizingContext): number | undefined {
  const width = parseWidth(node.attrs.width);
  if (width === null) return ctx.defaultWidth;
  if (width.kind === "cells") return width.value;
  const pct = width.kind === "full" ? 100 : width.value;
  if (ctx.percentBasis === undefined) {
    throw new Error(
      `std::layout: width "${node.attrs.width}" on this ${node.type} ` +
      `requires a sized ancestor (set an explicit width on the parent ` +
      `or one of its ancestors).`,
    );
  }
  return Math.floor((ctx.percentBasis * pct) / 100);
}

// Build a resolved container node: annotate it with its own width and
// recurse on every child using `childCtx`.
export function resolveContainer(
  node: LayoutNode,
  ownWidth: number | undefined,
  childCtx: SizingContext,
): LayoutNode {
  const children = node.children.map((child) => resolveNode(child, childCtx));
  const annotated = ownWidth === undefined ? node : setAttr(node, "resolvedWidth", ownWidth);
  return { ...annotated, children };
}

export function innerWidthAfterChrome(own: number | undefined, chrome: number): number | undefined {
  if (own === undefined) return undefined;
  return Math.max(0, own - chrome);
}

export function nonNegativeInteger(raw: unknown): number {
  const value = typeof raw === "number" ? raw : 0;
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

export function setAttr(node: LayoutNode, key: string, value: unknown): LayoutNode {
  return { ...node, attrs: { ...node.attrs, [key]: value } };
}
