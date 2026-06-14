import { TreeNode } from "./types.js";
import {
  DEFAULT_THRESHOLDS,
  ViewerThresholds,
  durationMagnitude,
  costMagnitude,
  Magnitude,
} from "./thresholds.js";
import { fmtDuration, fmtCost, fmtTime } from "../statelog/summarize.js";

// ---------------------------------------------------------------------------
// Styled-summary variants: produce the same text as the plain functions but
// wrap durations/costs in `{...-fg}...{/...-fg}` tags so the TUI renderer can
// color them by magnitude. Token counts stay uncolored (noisy, not
// actionable). The renderer asks for the styled version when drawing; the
// plain `node.summary` (built by the model) stays grep-able for search.

export function summarizeSpanStyled(
  node: TreeNode,
  thresholds: ViewerThresholds = DEFAULT_THRESHOLDS,
): string {
  const metrics = formatMetricsStyled(node, thresholds);
  return metrics ? `${node.label} (${metrics})` : node.label;
}

export function summarizeTraceStyled(
  node: TreeNode,
  thresholds: ViewerThresholds = DEFAULT_THRESHOLDS,
): string {
  const shortTraceId = node.traceId.slice(0, 6);
  const metrics = formatMetricsStyled(node, thresholds);
  const head = node.firstTs !== undefined ? fmtTime(node.firstTs) : "trace";
  const middle = metrics ? `  (${metrics})` : "";
  return `${head}${middle}  [${shortTraceId}]`;
}

function formatMetricsStyled(node: TreeNode, t: ViewerThresholds): string {
  const parts: string[] = [];
  if (node.duration !== undefined) {
    parts.push(wrapTag(fmtDuration(node.duration), durationColor(node.duration, t)));
  }
  if (node.tokens !== undefined) parts.push(`${node.tokens} tok`);
  if (node.cost !== undefined) {
    parts.push(wrapTag(fmtCost(node.cost), costColor(node.cost, t)));
  }
  return parts.join(", ");
}

function durationColor(ms: number, t: ViewerThresholds): string | undefined {
  return colorForMagnitude(durationMagnitude(ms, t));
}

function costColor(usd: number, t: ViewerThresholds): string | undefined {
  return colorForMagnitude(costMagnitude(usd, t));
}

function colorForMagnitude(m: Magnitude): string | undefined {
  switch (m) {
    case "slow":
    case "expensive":
      return "bright-red";
    case "fast":
      return "gray";
    default:
      return undefined;
  }
}

function wrapTag(text: string, color: string | undefined): string {
  if (!color) return text;
  return `{${color}-fg}${text}{/${color}-fg}`;
}
