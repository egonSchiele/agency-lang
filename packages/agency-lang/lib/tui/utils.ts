import type { Cell, Style } from "./elements.js";

export type Edges = { top: number; bottom: number; left: number; right: number };

export function resolveEdges(value: number | { top?: number; bottom?: number; left?: number; right?: number } | undefined): Edges {
  if (value === undefined) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (typeof value === "number") return { top: value, bottom: value, left: value, right: value };
  return {
    top: value.top ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
    right: value.right ?? 0,
  };
}

/**
 * Compute the inner content area of a box after subtracting border and
 * padding. Shared between layout (positioning children) and rendering
 * (placing content cells) so they cannot drift apart.
 */
export function innerArea(
  style: Style | undefined,
  outerX: number,
  outerY: number,
  outerWidth: number,
  outerHeight: number,
): { x: number; y: number; width: number; height: number } {
  const padding = resolveEdges(style?.padding);
  const borderSize = style?.border ? 1 : 0;
  return {
    x: outerX + borderSize + padding.left,
    y: outerY + borderSize + padding.top,
    width: Math.max(0, outerWidth - 2 * borderSize - padding.left - padding.right),
    height: Math.max(0, outerHeight - 2 * borderSize - padding.top - padding.bottom),
  };
}

export function sameStyle(a: Cell, b: Cell): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
