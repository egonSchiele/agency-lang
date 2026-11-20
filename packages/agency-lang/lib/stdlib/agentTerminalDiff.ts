// An edit's diff, drawn for the terminal from the hunks the session core
// reports (`session.editDiff`). The terminal shows it for an edit a rule
// approved inside the session run, where no prompt drew it, as the
// terminal's policy handler always did for a rule's approval.
import { color } from "../utils/termcolors.js";
import type { EditHunk, EditLine } from "./editDiff.js";

const SIGNS: Record<EditLine["kind"], string> = { context: " ", delete: "-", insert: "+" };

function lineNumber(line: EditLine): string {
  const number = line.kind === "insert" ? line.newNumber : line.oldNumber;
  return String(number ?? "").padStart(4);
}

function drawnLine(line: EditLine): string {
  const text = line.tokens.map((token) => token.text).join("");
  const drawn = `${lineNumber(line)} ${SIGNS[line.kind]} ${text}`;
  if (line.kind === "delete") return color.red(drawn);
  if (line.kind === "insert") return color.green(drawn);
  return color.dim(drawn);
}

/** "⏺ Edit: <file>", then each hunk's lines, numbered, with removed lines
 *  red and added lines green. An edit with no hunks (too big to diff)
 *  shows the header alone. */
export function renderEditDiff(filename: string, hunks: EditHunk[]): string {
  const lines = [color.yellow(`⏺ Edit: ${filename}`)];
  for (const hunk of hunks) {
    lines.push(
      color.dim(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
    );
    lines.push(...hunk.lines.map(drawnLine));
  }
  return lines.join("\n");
}
