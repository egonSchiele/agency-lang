import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
  type DiagnosticName,
} from "@/typeChecker/diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "@/typeChecker/diagnosticExplanations.js";
import { color } from "@/utils/termcolors.js";

function lookup(codeOrName: string): DiagnosticName | undefined {
  const q = codeOrName.trim();
  if (q in DIAGNOSTICS) return q as DiagnosticName;
  const upper = q.toUpperCase();
  for (const [name, entry] of Object.entries(DIAGNOSTICS)) {
    if (entry.code.toUpperCase() === upper) return name as DiagnosticName;
  }
  return undefined;
}

/** Rendered detail for one diagnostic. `found:false` carries the not-found
 *  message with a suggestion; the caller prints it and exits 1. */
export function renderDiagnosticText(codeOrName: string): {
  text: string;
  found: boolean;
} {
  const name = lookup(codeOrName);
  if (!name) {
    return {
      found: false,
      text: `Unknown diagnostic code '${codeOrName}'. Run 'agency explain --list' to see all codes.`,
    };
  }
  const entry = DIAGNOSTICS[name];
  const lines = [
    `${color.bold(entry.code)} ${color.dim(name)}`,
    `${color.dim("severity:")} ${entry.severity}`,
    "",
    entry.message,
    "",
    DIAGNOSTIC_EXPLANATIONS[name],
  ];
  return { found: true, text: lines.join("\n") };
}

/** Every code, grouped under its category title, with the message template
 *  as the one-line summary. Codes sort within a category. */
export function renderDiagnosticList(): string {
  const blocks: string[] = [];
  for (const cat of DIAGNOSTIC_CATEGORIES) {
    const rows = Object.entries(DIAGNOSTICS)
      .filter(([, e]) => categoryForCode(e.code)?.prefix === cat.prefix)
      .sort(([, a], [, b]) => a.code.localeCompare(b.code))
      .map(([, e]) => `  ${color.bold(e.code)}  ${e.message}`);
    if (rows.length === 0) continue;
    blocks.push([color.underline(cat.title), ...rows].join("\n"));
  }
  return blocks.join("\n\n");
}
