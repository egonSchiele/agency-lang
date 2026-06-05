// std::layout — `box` container.
//
// A bordered panel. Single-child boxes use the child directly;
// multi-child (or empty) wrap in an implicit `column` so the children
// stack vertically inside the frame.

import { Block } from "./block.js";
import { BorderStyle, bordered } from "./border.js";
import { LayoutNode } from "./nodes.js";
import { renderNode } from "./render.js";

export function composeBox(node: LayoutNode): Block {
  // Single-child box uses that child directly; multi-child (or empty)
  // wraps in an implicit column. `composeColumn([])` already returns
  // `Block.empty()`, so no separate empty-children branch is needed.
  const inner: LayoutNode = node.children.length === 1
    ? node.children[0]
    : { type: "column", attrs: {}, children: node.children };
  return bordered(renderNode(inner), {
    title:       node.attrs.title       as string | undefined,
    titleColor:  node.attrs.titleColor  as string | undefined,
    borderStyle: node.attrs.borderStyle as BorderStyle | undefined,
    borderColor: node.attrs.borderColor as string | undefined,
    padding:     node.attrs.padding     as number | undefined,
  });
}
