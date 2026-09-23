import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { clipText, paint, paintedLine, segment, type Piece } from "../../tui/paint.js";
import { THEME } from "../theme.js";
import { bottomHints } from "../views/shared.js";
import { SCREEN_ORDER, type ScreenName } from "./screen.js";
export const MIN_COLS = 100;
export type TracePosition = { at: number; of: number };
export type TabStripArgs = {
  active: ScreenName | undefined;
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
      text: `  trace ${args.tracePosition.at}/${args.tracePosition.of}`,
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
export function keyFooter(hints: string, cols: number, title: string, sharedHints = ""): Element {
  const label = `[${title}]`;
  const gap = "   ";
  const sharedWidth = sharedHints ? sharedHints.length + gap.length : 0;
  const room = Math.max(0, cols - label.length - 1 - sharedWidth);
  const combined = [clipText(hints, room), sharedHints].filter(Boolean).join(gap);
  const content = bottomHints(combined, title, cols);
  return paintedLine(
    segment(
      [
        { text: content.slice(0, -label.length), style: { fg: THEME.muted } },
        { text: label, style: { fg: THEME.accent, bg: THEME.rule, bold: true } },
      ],
      cols,
    ),
  );
}
export function twoLineKeyFooter(
  hints: string,
  cols: number,
  title: string,
  sharedHints = "",
): Element {
  const commands = hints.split("   ").filter(Boolean);
  const first: string[] = [];
  let consumed = 0;
  for (const command of commands) {
    if (first.length > 0 && [...first, command].join("   ").length > cols) {
      break;
    }
    first.push(command);
    consumed++;
  }
  return column(
    { height: 2, justifyContent: "flex-start" },
    paintedLine(segment(first.join("   "), cols, { style: { fg: THEME.muted } })),
    keyFooter(commands.slice(consumed).join("   "), cols, title, sharedHints),
  );
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
