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
import { Block } from "./block.js";
import { composeColumn, composeRow } from "./axis.js";
import { composeBox } from "./box.js";
import { composeTable } from "./table.js";
import { LEAF_RENDERERS, LayoutNode, NodeType } from "./nodes.js";

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

export function render(node: LayoutNode): string {
  return renderNode(node).toString();
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

export function _render(node: LayoutNode, color: "auto" | boolean): string {
  const useColor = color === "auto" ? _autoUseColor() : color === true;
  const out = render(node);
  return useColor ? out : stripAnsi(out);
}
