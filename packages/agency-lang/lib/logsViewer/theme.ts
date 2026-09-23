// Viewer colors by role.
import type { PaintStyle } from "../tui/paint.js";
import { costMagnitude, durationMagnitude, type ViewerThresholds } from "./thresholds.js";

export const THEME = {
  kind: {
    user: "#89b4fa",
    assistant: "#a6e3a1",
    tool: "#f9e2af",
    interrupt: "#fab387",
    error: "#f38ba8",
  },
  chrome: "#585b70",
  muted: "#7f849c",
  text: "#cdd6f4",
  accent: "#cba6f7",
  cached: "#45475a",
  ok: "#94e2d5",
  warning: "#fab387",
  rule: "#313244",
  cursorBg: "#313244",
} as const;

const THREAD_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#cba6f7", "#94e2d5", "#fab387"];

export type Tone = "quiet" | "normal" | "hot";

export function durationTone(ms: number, thresholds: ViewerThresholds): Tone {
  const magnitude = durationMagnitude(ms, thresholds);
  if (magnitude === "slow") {
    return "hot";
  }
  return magnitude === "fast" ? "quiet" : "normal";
}

export function costTone(usd: number, thresholds: ViewerThresholds): Tone {
  return costMagnitude(usd, thresholds) === "expensive" ? "hot" : "quiet";
}

export function toneStyle(tone: Tone): PaintStyle {
  if (tone === "hot") {
    return { fg: THEME.warning, bold: true };
  }
  return { fg: tone === "quiet" ? THEME.chrome : THEME.muted };
}

/** Color never carries meaning alone: a hot number also gets a mark, so
 * it reads in plain text and under NO_COLOR. */
export function hotMark(tone: Tone): string {
  return tone === "hot" ? "!" : "";
}

export function threadColor(position: number): string {
  return THREAD_COLORS[position % THREAD_COLORS.length];
}
