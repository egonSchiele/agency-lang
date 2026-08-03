// Count an entrypoint's exported nodes and functions, so `remote deploy` can
// warn when an agent would host no callable endpoints (usually a forgotten
// `export`). Derived from the shared serve metadata — one exported-symbol owner.

import type { AgencyConfig } from "@/config.js";
import { collectServeMetadata } from "@/serve/metadata.js";

export type ExportedEndpointCount = { nodes: number; functions: number };

export function countExportedEndpoints(
  filePath: string,
  config: AgencyConfig,
): ExportedEndpointCount {
  const metadata = collectServeMetadata({ filePath, config });
  return {
    nodes: metadata.exportedNodeNames.length,
    functions: metadata.exportedFunctionNames.length,
  };
}
