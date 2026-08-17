// Count an entrypoint's exported nodes and functions, so `remote deploy` can
// warn when an agent would host no callable endpoints (usually a forgotten
// `export`). Derived from the shared serve metadata — one exported-symbol owner.
//
// Only the entrypoint's exports are served. An `export` in an imported file is
// invisible to the host unless the entrypoint re-exports it, so alongside the
// count we report which imported files carry exports of their own — the deploy
// warning uses that to explain the fix instead of just saying "none".

import path from "path";
import type { AgencyConfig } from "@/config.js";
import { collectServeMetadata } from "@/serve/metadata.js";
import { SymbolTable } from "@/symbolTable.js";
import { collectAgencyBundle } from "../deploy/bundle.js";

export type ImportedFileExports = {
  /** Basename of the imported file, e.g. `lib.agency`. */
  file: string;
  /** Its exported node and function names, in declaration order. */
  names: string[];
};

export type ExportedEndpointCount = {
  nodes: number;
  functions: number;
  /** Exports living in imported sibling files (not served from this entrypoint). */
  imported: ImportedFileExports[];
};

export function countExportedEndpoints(
  filePath: string,
  config: AgencyConfig,
): ExportedEndpointCount {
  const metadata = collectServeMetadata({ filePath, config });
  const nodes = metadata.exportedNodeNames.length;
  const functions = metadata.exportedFunctionNames.length;
  // The imported-file scan builds a second symbol table; only pay for it when
  // the answer changes what deploy says (the entrypoint exports nothing).
  const imported = nodes + functions === 0 ? importedFileExports(filePath, config) : [];
  return { nodes, functions, imported };
}

function importedFileExports(filePath: string, config: AgencyConfig): ImportedFileExports[] {
  const entrypointAbs = path.resolve(filePath);
  const bundle = collectAgencyBundle(entrypointAbs, config);
  if (!bundle.ok) {
    return [];
  }
  const symbolTable = SymbolTable.build(entrypointAbs, config);
  const result: ImportedFileExports[] = [];
  for (const file of bundle.bundle.files) {
    if (file.absPath === entrypointAbs) continue;
    const names = Object.values(symbolTable.getFile(file.absPath) ?? {})
      .filter((sym) => (sym.kind === "node" || sym.kind === "function") && sym.exported)
      .map((sym) => sym.name);
    if (names.length > 0) {
      result.push({ file: file.name, names });
    }
  }
  return result;
}
