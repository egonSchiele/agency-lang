// std::layout — text layout renderer (public entry point).
//
// Two layers (see docs/superpowers/specs/2026-06-02-layout-module-design.md):
//   * Agency-side (stdlib/layout.agency) — pure data construction.
//   * TS-side (this directory)            — pure render.
//
// This file is a thin re-exporter so the package's
// `agency-lang/stdlib-lib/layout.js` subpath import stays stable.
// The implementation lives in `./layout/` split by concern:
//
//   * ansi.ts    — SGR / color primitives, visualWidth
//   * block.ts   — Block class + pad / beside / above / styled
//   * border.ts  — bordered frame, BORDER_CHARS, title in top edge
//   * nodes.ts   — LayoutNode types + leaf renderers
//   * axis.ts    — composeRow / composeColumn
//   * box.ts     — composeBox
//   * table.ts   — composeTable + validation + cell layout
//   * render.ts  — RENDERERS dispatch table + renderNode + render + _render

import { BORDER_CHARS, resolveBorderStyle } from "./layout/border.js";
import { colorToRgb, sgr, stripAnsi, visualWidth } from "./layout/ansi.js";
import { padLine } from "./layout/block.js";
import { RENDERERS } from "./layout/render.js";
import { _coerceCell, _validateTable } from "./layout/table.js";
import { styleOf } from "./layout/nodes.js";

export { Style } from "./layout/ansi.js";
export { Align, Block, above, beside, pad, styled } from "./layout/block.js";
export { BorderOpts, BorderStyle, bordered } from "./layout/border.js";
export { Cell, ColumnSpec, LayoutNode, NodeType } from "./layout/nodes.js";
export { _render, render, renderNode } from "./layout/render.js";

// Internal exports for tests only — pinned here so the test surface
// stays at a single import path even as implementation files move.
export const _internal = {
  visualWidth, sgr, padLine, stripAnsi, colorToRgb,
  BORDER_CHARS, resolveBorderStyle,
  styleOf, RENDERERS,
  _coerceCell, _validateTable,
};
