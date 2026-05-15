import { AgencyConfig } from "./config.js";
import { generateAgency } from "./backends/agencyGenerator.js";
import { parseAgency, replaceBlankLines } from "./parser.js";

/**
 * Parse an Agency source string and return the formatted output.
 * Returns null if parsing fails.
 */
export function formatSource(source: string, config: AgencyConfig = {}): string | null {
  // Skip pattern lowering — the formatter needs the original pattern AST
  // so it can print patterns back as patterns.
  const result = parseAgency(replaceBlankLines(source), config, false, false);
  if (!result.success) return null;
  return generateAgency(result.result);
}
