import type { Element, PositionedElement } from "./elements.js";
import { innerArea, resolveEdges, type Edges } from "./utils.js";

// Strict percentage form: digits, optional fractional part, single trailing %.
const PERCENTAGE_RE = /^(\d+(?:\.\d+)?)%$/;

function resolveDimension(
  value: number | string | undefined,
  available: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const m = PERCENTAGE_RE.exec(value);
    if (m) return Math.floor(available * (parseFloat(m[1]) / 100));
  }
  throw new Error(
    `Invalid dimension value: ${JSON.stringify(value)}. Expected a number or a percentage string like "50%".`,
  );
}

function clampDimension(value: number, min?: number, max?: number): number {
  const raised = Math.max(value, min ?? value);
  return Math.min(raised, max ?? raised);
}

/**
 * Entry point: lay out the root element. Both axes are resolved by the
 * element itself against the available terminal dimensions.
 */
export function layout(element: Element, availableWidth: number, availableHeight: number): PositionedElement {
  return layoutRoot(element, 0, 0, availableWidth, availableHeight);
}

/**
 * Lay out the root element. The root has no parent, so it resolves both
 * axes itself against the available space.
 */
function layoutRoot(
  element: Element,
  x: number,
  y: number,
  availableWidth: number,
  availableHeight: number,
): PositionedElement {
  const style = element.style ?? {};

  const width = clampDimension(
    resolveDimension(style.width, availableWidth) ?? availableWidth,
    style.minWidth,
    style.maxWidth,
  );
  const height = clampDimension(
    resolveDimension(style.height, availableHeight) ?? availableHeight,
    style.minHeight,
    style.maxHeight,
  );

  const margin = resolveEdges(style.margin);
  const { children: _, ...rest } = element;

  const result: PositionedElement = {
    ...rest,
    resolvedX: x + margin.left,
    resolvedY: y + margin.top,
    resolvedWidth: width,
    resolvedHeight: height,
  };

  result.children = layoutChildren(element, result);
  return result;
}

/**
 * Lay out a child element. The parent has already resolved the main-axis
 * size. The child resolves only its cross-axis size.
 */
type AlignItems = "flex-start" | "center" | "flex-end" | "stretch";

function layoutChild(
  element: Element,
  x: number,
  y: number,
  mainAxisSize: number,
  crossAxisAvailable: number,
  mainAxis: "width" | "height",
  alignItems: AlignItems,
): PositionedElement {
  const style = element.style ?? {};
  const margin = resolveEdges(style.margin);

  const crossAxis = mainAxis === "width" ? "height" : "width";

  // Cross-axis size: use child's own size if specified, otherwise fill the
  // available cross space. (alignItems controls offset, not size.)
  const crossProp = style[crossAxis];
  const crossMin = crossAxis === "width" ? style.minWidth : style.minHeight;
  const crossMax = crossAxis === "width" ? style.maxWidth : style.maxHeight;
  const crossDim = clampDimension(
    resolveDimension(crossProp, crossAxisAvailable) ?? crossAxisAvailable,
    crossMin,
    crossMax,
  );

  // Cross-axis offset based on alignItems
  let crossOffset = 0;
  if (alignItems === "center") {
    crossOffset = Math.floor((crossAxisAvailable - crossDim) / 2);
  } else if (alignItems === "flex-end") {
    crossOffset = crossAxisAvailable - crossDim;
  }

  const isRow = mainAxis === "width";
  const adjustedX = x + (isRow ? 0 : crossOffset);
  const adjustedY = y + (isRow ? crossOffset : 0);

  const width = mainAxis === "width" ? mainAxisSize : crossDim;
  const height = mainAxis === "height" ? mainAxisSize : crossDim;
  const { children: _, ...rest } = element;

  const result: PositionedElement = {
    ...rest,
    resolvedX: adjustedX + margin.left,
    resolvedY: adjustedY + margin.top,
    resolvedWidth: width,
    resolvedHeight: height,
  };

  result.children = layoutChildren(element, result);
  return result;
}

/**
 * Lay out the children of a positioned parent element. This is the core
 * flexbox-lite algorithm, shared by both layoutRoot and layoutChild.
 */
function layoutChildren(
  element: Element,
  parent: PositionedElement,
): PositionedElement[] | undefined {
  const style = element.style ?? {};

  const visibleChildren = (element.children ?? []).filter(
    (c) => c.style?.visible !== false,
  );

  if (visibleChildren.length === 0) return undefined;

  // Inner area after border and padding
  const { x: innerX, y: innerY, width: innerWidth, height: innerHeight } = innerArea(
    style,
    parent.resolvedX,
    parent.resolvedY,
    parent.resolvedWidth,
    parent.resolvedHeight,
  );

  const direction = style.flexDirection ?? "column";
  const isRow = direction === "row";
  const mainAxis: "width" | "height" = isRow ? "width" : "height";

  const mainSize = isRow ? innerWidth : innerHeight;
  const crossSize = isRow ? innerHeight : innerWidth;

  // --- Pass 1: compute each child's main-axis size ---
  // Fixed and percentage children are resolved against the parent's inner
  // dimension. Flex children are deferred (null) for pass 2.
  let usedMain = 0;
  let totalFlex = 0;
  const childMainSizes: (number | null)[] = [];
  const childMargins: Edges[] = [];

  for (const child of visibleChildren) {
    const cs = child.style ?? {};
    const childMargin = resolveEdges(cs.margin);
    childMargins.push(childMargin);
    const mainMarginSum = isRow
      ? childMargin.left + childMargin.right
      : childMargin.top + childMargin.bottom;

    const mainProp = isRow ? cs.width : cs.height;
    const hasFlex = cs.flex !== undefined && cs.flex > 0;
    const hasExplicitMainSize = mainProp !== undefined;

    if (hasFlex || !hasExplicitMainSize) {
      const flexValue = cs.flex ?? 1;
      totalFlex += flexValue;
      childMainSizes.push(null);
      usedMain += mainMarginSum;
    } else {
      const resolved = resolveDimension(mainProp, mainSize) ?? 0;
      childMainSizes.push(resolved);
      usedMain += resolved + mainMarginSum;
    }
  }

  // --- Pass 2: distribute remaining space to flex/unsized children ---
  const remainingMain = Math.max(0, mainSize - usedMain);
  for (let i = 0; i < visibleChildren.length; i++) {
    if (childMainSizes[i] === null) {
      const flexValue = visibleChildren[i].style?.flex ?? 1;
      childMainSizes[i] = Math.floor(remainingMain * (flexValue / totalFlex));
    }
  }

  // --- Pass 3: position children and recurse ---
  // Compute total used main-axis space (after flex distribution)
  let totalUsedMain = 0;
  for (let i = 0; i < visibleChildren.length; i++) {
    const m = childMargins[i];
    const marginSum = isRow ? m.left + m.right : m.top + m.bottom;
    totalUsedMain += childMainSizes[i]! + marginSum;
  }
  const freeMain = Math.max(0, mainSize - totalUsedMain);

  const justify = style.justifyContent ?? "flex-start";
  let mainOffset = 0;
  let gap = 0;
  if (justify === "flex-end") {
    mainOffset = freeMain;
  } else if (justify === "center") {
    mainOffset = Math.floor(freeMain / 2);
  } else if (justify === "space-between" && visibleChildren.length > 1) {
    gap = Math.floor(freeMain / (visibleChildren.length - 1));
  }

  const alignItems: AlignItems = style.alignItems ?? "stretch";
  const positionedChildren: PositionedElement[] = [];

  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i];
    const childMainSize = childMainSizes[i]!;
    const childMargin = childMargins[i];

    let childX: number;
    let childY: number;

    if (isRow) {
      childX = innerX + mainOffset;
      childY = innerY;
      mainOffset += childMainSize + childMargin.left + childMargin.right + gap;
    } else {
      childX = innerX;
      childY = innerY + mainOffset;
      mainOffset += childMainSize + childMargin.top + childMargin.bottom + gap;
    }

    const positioned = layoutChild(
      child, childX, childY,
      childMainSize, crossSize,
      mainAxis,
      alignItems,
    );
    positionedChildren.push(positioned);
  }

  return positionedChildren;
}
