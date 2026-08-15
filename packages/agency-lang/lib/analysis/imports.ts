import { AgencyProgram, ImportStatement } from "@/types.js";
import { isAgencyImport } from "@/importPaths.js";

/** The agency-file imports a program declares: import-node statements plus
 *  `import ... from "<agency path>"` statements. Filters out npm/Node module
 *  imports — see compile.ts's getAllImports for the unfiltered walk. */
export function getImports(program: AgencyProgram): string[] {
  const toolAndNodeImports = program.nodes
    .filter((node) => node.type === "importNodeStatement")
    .map((node) => node.agencyFile.trim());
  // this makes compile() try to parse non-agency files
  const importStatements = program.nodes
    .filter((node) => node.type === "importStatement" && isAgencyImport(node.modulePath))
    .map((node) => (node as ImportStatement).modulePath.trim());

  return [...toolAndNodeImports, ...importStatements];
}

// EVERY import a program declares, whether it resolves to
// agency code (`.agency` / `std::` / `pkg::`) or a raw npm/Node module
// (e.g. `fs`, `child_process`). Use this when you need to inspect or
// validate the full import surface — `getImports` filters out non-agency
// imports, which is the wrong behavior for restriction checks.
export type AnyImport = { path: string; kind: "module" | "node" };
export function getAllImports(program: AgencyProgram): AnyImport[] {
  return program.nodes.flatMap((node): AnyImport[] => {
    if (node.type === "importStatement") {
      return [{ path: node.modulePath.trim(), kind: "module" }];
    }
    if (node.type === "importNodeStatement") {
      return [{ path: node.agencyFile.trim(), kind: "node" }];
    }
    return [];
  });
}
