import type { Cell } from "./elements.js";

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

export function sameStyle(a: Cell, b: Cell): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
