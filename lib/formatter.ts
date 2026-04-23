import { AgencyConfig } from "./config.js";
import { generateAgency } from "./backends/agencyGenerator.js";
import { parseAgency } from "./parser.js";

/**
 * Parse an Agency source string and return the formatted output.
 * Returns null if parsing fails.
 */
export function formatSource(source: string, config: AgencyConfig = {}): string | null {
  const result = parseAgency(source, config, false);
  if (!result.success) return null;
  return generateAgency(result.result);
}
