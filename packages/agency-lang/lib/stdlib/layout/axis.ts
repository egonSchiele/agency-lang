// std::layout — axis composition (row + column).
//
// `row` and `column` are symmetric: each lays its children out along
// a "main axis" (left-to-right / top-to-bottom) and aligns short
// children in the "cross axis" (vertical / horizontal). The
// differences are captured in `AXIS_OPS`; the actual compose /
// render logic is shared.

import { Align, Block, above, beside, pad } from "./block.js";
import { LayoutNode } from "./nodes.js";
import { renderNode } from "./render.js";

type Axis = "row" | "column";

// Per-axis bundle of "how does this axis differ from the other one":
//   * which leaf node type stretches (vline in row, hline in column)
//   * how to measure cross-axis size from a block
//   * how to align a block in the cross axis
//   * the join operator to concatenate aligned blocks
//   * how to render a `space(n)` leaf to a Block on this axis
type AxisOps = {
  stretchyType: "vline" | "hline";
  crossSize:    (b: Block) => number;
  alignCross:   (b: Block, cross: number, align: Align) => Block;
  join:         (a: Block, b: Block) => Block;
  spaceBlock:   (count: number) => Block;
};

const AXIS_OPS: Record<Axis, AxisOps> = {
  row: {
    stretchyType: "vline",
    crossSize:    (b) => b.height,
    alignCross:   (b, h, align) => pad(b, b.width, h, "start", align),
    join:         beside,
    spaceBlock:   (count) => Block.of(" ".repeat(count)),
  },
  column: {
    stretchyType: "hline",
    crossSize:    (b) => b.width,
    alignCross:   (b, w, align) => pad(b, w, b.height, align, "start"),
    join:         above,
    spaceBlock:   (count) => Block.of(Array(count).fill("")),
  },
};

function maxOf<T>(items: T[], pick: (item: T) => number, floor: number): number {
  return items.reduce((acc, item) => Math.max(acc, pick(item)), floor);
}

function isStretchyLine(child: LayoutNode, axis: Axis): boolean {
  if (child.type !== AXIS_OPS[axis].stretchyType) return false;
  const explicitLength = child.attrs.length;
  return explicitLength == null || explicitLength === 0;
}

function isDynamic(child: LayoutNode, axis: Axis): boolean {
  return child.type === "space" || isStretchyLine(child, axis);
}

function renderDynamicChild(
  child: LayoutNode,
  axis: Axis,
  crossSize: number,
): Block {
  if (isStretchyLine(child, axis)) {
    return renderNode({ ...child, attrs: { ...child.attrs, length: crossSize } });
  }
  // `space(count)`: `count` columns wide inside a row, `count` empty
  // rows inside a column.
  const count = (child.attrs.count as number) ?? 1;
  return AXIS_OPS[axis].spaceBlock(count);
}

// Render every child of an axis container exactly once, resolving
// stretchy lines and `space` nodes against the cross-axis size of the
// concrete siblings.
function renderChildrenAlongAxis(children: LayoutNode[], axis: Axis): Block[] {
  // First pass: render every concrete child; leave `null` placeholders
  // for the dynamic ones (we need their indices to keep source order).
  const concreteBlocks: (Block | null)[] = children.map((child) =>
    isDynamic(child, axis) ? null : renderNode(child),
  );

  // Measure cross-axis size from the concrete blocks only. Floor at 1
  // so an all-dynamic row (e.g. `row { r.vline() }`) still renders.
  const measured = concreteBlocks.filter((b): b is Block => b !== null);
  const crossSize = maxOf(measured, AXIS_OPS[axis].crossSize, 1);

  // Second pass: fill in the dynamic blocks using the measured size.
  return children.map((child, index) => {
    const pre = concreteBlocks[index];
    if (pre !== null) return pre;
    return renderDynamicChild(child, axis, crossSize);
  });
}

// Interleave a gap block between consecutive children (skipped when
// `gapBlock` is null). Used by `composeAxis` to add `row`/`column` `gap`.
function joinWithGap(
  blocks: Block[],
  gapBlock: Block | null,
  join: (a: Block, b: Block) => Block,
): Block {
  return blocks.reduce<Block>((accumulated, block, index) => {
    if (index === 0) return block;
    const withGap = gapBlock ? join(accumulated, gapBlock) : accumulated;
    return join(withGap, block);
  }, Block.empty());
}

function composeAxis(node: LayoutNode, axis: Axis): Block {
  if (node.children.length === 0) return Block.empty();

  const gapCells   = (node.attrs.gap   as number) ?? 0;
  const childAlign = (node.attrs.align as Align)  ?? "start";
  const ops        = AXIS_OPS[axis];

  const rendered  = renderChildrenAlongAxis(node.children, axis);
  const crossSize = maxOf(rendered, ops.crossSize, 0);
  const aligned   = rendered.map((b) => ops.alignCross(b, crossSize, childAlign));

  const gapBlock = gapCells > 0 ? ops.spaceBlock(gapCells) : null;
  return joinWithGap(aligned, gapBlock, ops.join);
}

export function composeRow(node: LayoutNode):    Block { return composeAxis(node, "row"); }
export function composeColumn(node: LayoutNode): Block { return composeAxis(node, "column"); }
