import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { paint, paintedLine, segment, type Piece } from "../../tui/paint.js";
import { THEME } from "../theme.js";
import { SCREEN_ORDER, type ScreenName } from "./screen.js";
export const MIN_COLS = 100;
export type TracePosition = { at: number; of: number };
export type TabStripArgs = {
  active: ScreenName;
  title: string;
  tracePosition?: TracePosition;
  annotation?: string;
  following: boolean;
  cols: number;
};
export function tabStrip(args: TabStripArgs): Element {
  const pieces: Piece[] = SCREEN_ORDER.map((name, position) => ({
    text: args.active === name ? ` [${position + 1} ${name}] ` : ` ${position + 1} ${name} `,
    style: { fg: args.active === name ? THEME.accent : THEME.muted, bold: args.active === name },
  }));
  pieces.push({ text: ` ${args.title}`, style: { fg: THEME.text } });
  if (args.tracePosition !== undefined && args.tracePosition.of > 1) {
    pieces.push({
      text: `  trace ${args.tracePosition.at}/${args.tracePosition.of} · t traces`,
      style: { fg: THEME.muted },
    });
  }
  if (args.annotation !== undefined) {
    pieces.push({ text: `  ${args.annotation}`, style: { fg: THEME.muted } });
  }
  if (args.following) {
    pieces.push({ text: "  ● following", style: { fg: THEME.ok } });
  }
  return paintedLine(segment(pieces, args.cols));
}
export function keyFooter(hints: string, cols: number): Element {
  return paintedLine(segment(hints, cols, { style: { fg: THEME.muted } }));
}
export function tooNarrow(cols: number): Element {
  const messages = [
    "",
    `  This viewer wants ${MIN_COLS} columns; this terminal has ${cols}.`,
    "  Widen the window and open it again.",
  ];
  return column(
    { justifyContent: "flex-start" },
    ...messages.map((text) => paintedLine(paint(text))),
  );
}
