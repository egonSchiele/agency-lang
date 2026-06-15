import { existsSync } from "fs";
import { analyzeInterrupts, type AnalysisResult, type HandlerRef } from "@/analysis/interrupts.js";
import type { AgencyConfig } from "@/config.js";

/**
 * `agency interrupts <file>`: statically print every interrupt site
 * reachable from `file` and the set of handle blocks that could be on
 * the active stack at each site. Plain text output; no color, no JSON.
 */
export function interruptsCmd(config: AgencyConfig, file: string): void {
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  try {
    const result = analyzeInterrupts(file, config);
    process.stdout.write(renderInterrupts(result));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function renderInterrupts(result: AnalysisResult): string {
  const blocks: string[] = [];
  for (const s of result.sites) {
    const lines: string[] = [];
    const header =
      s.site.effect === "unknown"
        ? `${s.site.file}:${s.site.line}  interrupt`
        : `${s.site.file}:${s.site.line}  interrupt of effect ${s.site.effect}`;
    lines.push(header);
    lines.push("  Possible enclosing handlers:");
    if (s.handlers.length === 0) {
      lines.push("    (none)");
    } else {
      for (const h of s.handlers) {
        lines.push(`    ${formatHandler(h)}`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

function formatHandler(h: HandlerRef): string {
  if (h.shape === "functionRef") {
    return `handle via fn ${h.functionName} at ${h.file}:${h.line}`;
  }
  return `handle block at ${h.file}:${h.line}`;
}
