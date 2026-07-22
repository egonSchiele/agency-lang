import type { LintFinding } from "../linter/types.js";
import { color } from "../utils/termcolors.js";

/** Render one file's findings, 1-indexed, one line per finding. Callers only
 *  invoke this when there is at least one finding. */
export function formatFindings(filePath: string, findings: LintFinding[]): string {
  const lines = [color.bold(filePath)];
  for (const f of findings) {
    const pos = `${f.loc.line + 1}:${f.loc.col + 1}`;
    lines.push(`  ${color.dim(pos)}  ${color.yellow(f.code)}  ${f.message}`);
  }
  return lines.join("\n");
}
