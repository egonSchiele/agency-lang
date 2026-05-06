import type { Element, PositionedElement } from "./elements.js";

type Edges = { top: number; bottom: number; left: number; right: number };

function resolveEdges(value: number | { top?: number; bottom?: number; left?: number; right?: number } | undefined): Edges {
  if (value === undefined) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (typeof value === "number") return { top: value, bottom: value, left: value, right: value };
  return {
    top: value.top ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
    right: value.right ?? 0,
  };
}

function resolveDimension(
  value: number | string | undefined,
  available: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.endsWith("%")) {
    const pct = parseFloat(value) / 100;
    return Math.floor(available * pct);
  }
  return undefined;
}

function clampDimension(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  return value;
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

  let width = resolveDimension(style.width, availableWidth) ?? availableWidth;
  let height = resolveDimension(style.height, availableHeight) ?? availableHeight;
  width = clampDimension(width, style.minWidth, style.maxWidth);
  height = clampDimension(height, style.minHeight, style.maxHeight);

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
function layoutChild(
  element: Element,
  x: number,
  y: number,
  mainAxisSize: number,
  crossAxisAvailable: number,
  mainAxis: "width" | "height",
): PositionedElement {
  const style = element.style ?? {};
  const margin = resolveEdges(style.margin);

  const crossAxis = mainAxis === "width" ? "height" : "width";

  // Main axis: already resolved by parent, use directly
  const mainDim = mainAxisSize;

  // Cross axis: child resolves its own size against available space
  const crossProp = style[crossAxis];
  let crossDim = resolveDimension(crossProp, crossAxisAvailable) ?? crossAxisAvailable;
  const crossMin = crossAxis === "width" ? style.minWidth : style.minHeight;
  const crossMax = crossAxis === "width" ? style.maxWidth : style.maxHeight;
  crossDim = clampDimension(crossDim, crossMin, crossMax);

  const width = mainAxis === "width" ? mainDim : crossDim;
  const height = mainAxis === "height" ? mainDim : crossDim;
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

  const padding = resolveEdges(style.padding);
  const borderSize = style.border ? 1 : 0;

  // Inner area after border and padding
  const innerX = parent.resolvedX + borderSize + padding.left;
  const innerY = parent.resolvedY + borderSize + padding.top;
  const innerWidth = parent.resolvedWidth - 2 * borderSize - padding.left - padding.right;
  const innerHeight = parent.resolvedHeight - 2 * borderSize - padding.top - padding.bottom;

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

  for (const child of visibleChildren) {
    const cs = child.style ?? {};
    const childMargin = resolveEdges(cs.margin);
    const mainMarginSum = isRow
      ? childMargin.left + childMargin.right
      : childMargin.top + childMargin.bottom;

    const mainProp = isRow ? cs.width : cs.height;
    const hasFlex = cs.flex !== undefined && cs.flex > 0;
    const hasExplicitMainSize = mainProp !== undefined;

    if (hasFlex || !hasExplicitMainSize) {
      // Flex children and children with no explicit main-axis size both
      // get their space from pass 2. Treat no-size-no-flex as flex: 1.
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
  let mainOffset = 0;
  const positionedChildren: PositionedElement[] = [];

  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i];
    const childMainSize = childMainSizes[i]!;
    const cs = child.style ?? {};
    const childMargin = resolveEdges(cs.margin);

    let childX: number;
    let childY: number;

    if (isRow) {
      childX = innerX + mainOffset;
      childY = innerY;
      mainOffset += childMainSize + childMargin.left + childMargin.right;
    } else {
      childX = innerX;
      childY = innerY + mainOffset;
      mainOffset += childMainSize + childMargin.top + childMargin.bottom;
    }

    // Parent owns the main axis; child resolves the cross axis.
    const positioned = layoutChild(
      child, childX, childY,
      childMainSize, crossSize,
      mainAxis,
    );
    positionedChildren.push(positioned);
  }

  return positionedChildren;
}
