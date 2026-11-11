import { color, styles, RESET } from "../utils/termcolors.js";
import { visualWidth, wrapText } from "./layout/ansi.js";
import { isEffectRisk, RISK_COLOR } from "../runtime/effectRisk.js";

// The lines of the approval prompt's footer that are not its body: the
// divider that opens it and the answers. Pure. `renderInterruptFooter` in
// cli.ts puts them together with the title, the body, and the input line.

/** One answer at the approval prompt. */
export type InterruptItem = {
  key: string;
  label: string;
  /** Dim text in the third column: what the answer covers. */
  detail?: string;
  /** Colors the key: green for approve, red for reject, bold alone otherwise. */
  tone?: "approve" | "reject";
};

const KEY_COLUMN_GAP = 3;
const LABEL_COLUMN_GAP = 3;
const TONE_COLOR: Record<"approve" | "reject", (text: string) => string> = {
  approve: color.bold.green,
  reject: color.bold.red,
};

const dim = (text: string) => `${styles.dim}${text}${RESET}`;

function coloredKey(item: InterruptItem): string {
  return item.tone === undefined ? color.bold(item.key) : TONE_COLOR[item.tone](item.key);
}

/** The answers, one per line, in three columns: key, label, and a dim
 *  detail. An item that does not fit on one line wraps its label and then
 *  its detail onto lines of their own, indented to the label column, so a
 *  long path is shown whole whether it is the label (the folder step) or
 *  the detail. One or more lines per item. */
export function optionRows(items: InterruptItem[], width: number): string[] {
  const keyWidth = Math.max(...items.map((item) => item.key.length)) + KEY_COLUMN_GAP;
  const withDetail = items.filter((item) => item.detail !== undefined && item.detail !== "");
  const labelWidth =
    Math.max(0, ...withDetail.map((item) => visualWidth(item.label))) + LABEL_COLUMN_GAP;
  const indent = " ".repeat(keyWidth);
  const wrapWidth = Math.max(1, width - keyWidth);
  return items.flatMap((item) => {
    const key = coloredKey(item) + " ".repeat(keyWidth - item.key.length);
    const detail = item.detail ?? "";
    if (detail === "" && keyWidth + visualWidth(item.label) <= width) {
      return [key + item.label];
    }
    if (detail !== "" && keyWidth + labelWidth + visualWidth(detail) <= width) {
      const pad = " ".repeat(labelWidth - visualWidth(item.label));
      return [key + item.label + pad + dim(detail)];
    }
    const labelLines = wrapText(item.label, wrapWidth);
    const detailLines = detail === "" ? [] : wrapText(detail, wrapWidth).map(dim);
    const rest = [...labelLines.slice(1), ...detailLines];
    return [key + labelLines[0], ...rest.map((line) => indent + line)];
  });
}

/** The line that opens the footer: "── approval needed ────" in the color
 *  for the prompt's risk, or "answer needed" for a raise that wants a
 *  value. A plain dim rule when there is no risk to color by. */
export function footerDivider(width: number, risk: string, expectsValue: boolean): string {
  if (!isEffectRisk(risk)) {
    return dim("─".repeat(width));
  }
  const label = `── ${expectsValue ? "answer needed" : "approval needed"} `;
  return RISK_COLOR[risk](label + "─".repeat(Math.max(0, width - label.length)));
}
