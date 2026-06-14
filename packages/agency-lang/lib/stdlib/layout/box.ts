// std::layout — `box` container.
//
// A bordered panel. Single-child boxes use the child directly;
// multi-child (or empty) wrap in an implicit `column` so the children
// stack vertically inside the frame.

import { Block } from "./block.js";
import { BORDER_CELLS, BorderStyle, bordered } from "./border.js";
import { LayoutNode } from "./nodes.js";
import { growToWidth, renderNode } from "./render.js";
import {
  NodeHandler,
  SizingContext,
  innerWidthAfterChrome,
  nonNegativeInteger,
  resolveContainer,
  resolveOwnWidth,
} from "./sizing.js";

export function composeBox(node: LayoutNode): Block {
  // Single-child box uses that child directly; multi-child (or empty)
  // wraps in an implicit column. `composeColumn([])` already returns
  // `Block.empty()`, so no separate empty-children branch is needed.
  const inner: LayoutNode = node.children.length === 1
    ? node.children[0]
    : { type: "column", attrs: {}, children: node.children };
  const resolved = node.attrs.resolvedWidth as number | undefined;
  const framed = bordered(renderNode(inner), {
    title:       node.attrs.title       as string | undefined,
    titleColor:  node.attrs.titleColor  as string | undefined,
    borderStyle: node.attrs.borderStyle as BorderStyle | undefined,
    borderColor: node.attrs.borderColor as string | undefined,
    padding:     node.attrs.padding     as number | undefined,
    targetWidth: resolved,
  });
  return resolved !== undefined ? growToWidth(framed, resolved) : framed;
}

function sizeBox(node: LayoutNode, ctx: SizingContext): LayoutNode {
  const own = resolveOwnWidth(node, ctx);
  const padding = nonNegativeInteger(node.attrs.padding);
  const inner = innerWidthAfterChrome(own, BORDER_CELLS + 2 * padding);
  // Box children either occupy the inner width directly (single child)
  // or are wrapped in an implicit column, which itself fills the inner
  // width. Either way, children fill.
  return resolveContainer(node, own, { defaultWidth: inner, percentBasis: inner });
}

export const box: NodeHandler = { size: sizeBox, render: composeBox };
