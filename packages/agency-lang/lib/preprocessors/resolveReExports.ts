import type { AgencyNode, AgencyProgram } from "../types.js";
import type {
  ConstantSymbol,
  FileSymbols,
  FunctionSymbol,
  NodeSymbol,
  SymbolInfo,
  SymbolTable,
  TypeSymbol,
} from "../symbolTable.js";
import type { ImportStatement } from "../types/importStatement.js";
import type { ExportFromStatement } from "../types/exportFromStatement.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type { TypeAlias } from "../types/typeHints.js";
import type { Assignment, FunctionCall, ReturnStatement } from "../types.js";
import { resolveAgencyImportPath, isAgencyImport } from "../importPaths.js";

const REEXPORT_PREFIX = "__reexport_";

/**
 * Expand `exportFromStatement` nodes into synthesized internal `importStatement`
 * + local exported wrapper declarations. Driven by FileSymbols (the SymbolTable
 * is the single source of truth for what each re-export resolved to). The
 * exportFromStatement nodes themselves are stripped so downstream stages never
 * see them.
 */
export function resolveReExports(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  currentFile: string,
): AgencyProgram {
  const fileSymbols = symbolTable.getFile(currentFile) ?? {};

  // Build a map: absolute source path → original user-written modulePath.
  // Each `exportFromStatement` AST node tells us how the user spelled the source.
  const sourcePathToModulePath: Record<string, string> = {};
  for (const node of program.nodes) {
    if (node.type !== "exportFromStatement") continue;
    if (!isAgencyImport(node.modulePath)) continue;
    const abs = resolveAgencyImportPath(node.modulePath, currentFile);
    sourcePathToModulePath[abs] = node.modulePath;
  }

  // Group re-exported symbols by source file.
  const bySource: Record<string, Array<{ localName: string; sym: SymbolInfo }>> = {};
  for (const [localName, sym] of Object.entries(fileSymbols)) {
    if (!hasReExportedFrom(sym)) continue;
    const src = sym.reExportedFrom!.sourceFile;
    (bySource[src] ??= []).push({ localName, sym });
  }

  // Strip all exportFromStatement nodes.
  const kept: AgencyNode[] = program.nodes.filter(
    (n) => n.type !== "exportFromStatement",
  );

  // Synthesize one coalesced import + one wrapper per re-exported symbol per source.
  const synthesized: AgencyNode[] = [];
  for (const [sourceFile, entries] of Object.entries(bySource)) {
    const modulePath = sourcePathToModulePath[sourceFile];
    if (!modulePath) {
      // Defensive: a re-exported entry exists in FileSymbols but no AST node
      // mentions this source. Should not happen if SymbolTable and program are in sync.
      throw new Error(
        `resolveReExports: re-exported symbol from '${sourceFile}' has no matching exportFromStatement in '${currentFile}'`,
      );
    }
    synthesized.push(buildCoalescedImport(modulePath, entries));
    for (const { localName, sym } of entries) {
      synthesized.push(buildWrapper(localName, sym));
    }
  }

  // Synthesized imports go before kept nodes (matches normal import positioning).
  return { ...program, nodes: [...synthesized, ...kept] };
}

function hasReExportedFrom(
  sym: SymbolInfo,
): sym is FunctionSymbol | NodeSymbol | TypeSymbol | ConstantSymbol {
  return (
    sym.kind !== "class" &&
    "reExportedFrom" in sym &&
    sym.reExportedFrom !== undefined
  );
}

function buildCoalescedImport(
  modulePath: string,
  entries: Array<{ localName: string; sym: SymbolInfo }>,
): ImportStatement {
  const importedNames: string[] = [];
  const aliases: Record<string, string> = {};
  for (const { sym } of entries) {
    if (!hasReExportedFrom(sym)) continue;
    const original = sym.reExportedFrom!.originalName;
    if (importedNames.includes(original)) continue; // already coalesced
    importedNames.push(original);
    aliases[original] = `${REEXPORT_PREFIX}${original}`;
  }
  return {
    type: "importStatement",
    modulePath,
    isAgencyImport: true,
    importedNames: [
      {
        type: "namedImport",
        importedNames,
        safeNames: [],
        aliases,
      },
    ],
  };
}

function buildWrapper(localName: string, sym: SymbolInfo): AgencyNode {
  switch (sym.kind) {
    case "function":
      return buildFunctionWrapper(localName, sym);
    case "node":
      return buildNodeWrapper(localName, sym);
    case "type":
      return buildTypeWrapper(localName, sym);
    case "constant":
      return buildConstantWrapper(localName, sym);
    default:
      throw new Error(
        `resolveReExports: unsupported re-export kind '${(sym as any).kind}'`,
      );
  }
}

function buildCallArgs(
  parameters: FunctionSymbol["parameters"],
  loc: SymbolInfo["loc"],
): FunctionCall["arguments"] {
  return parameters.map((p) => ({
    type: "variableName" as const,
    value: p.name,
    loc,
  }));
}

function buildFunctionWrapper(
  localName: string,
  sym: FunctionSymbol,
): FunctionDefinition {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  const call: FunctionCall = {
    type: "functionCall",
    functionName: internal,
    arguments: buildCallArgs(sym.parameters, sym.loc),
    loc: sym.loc,
  };
  const ret: ReturnStatement = {
    type: "returnStatement",
    value: call,
    loc: sym.loc,
  };
  const out: FunctionDefinition = {
    type: "function",
    functionName: localName,
    parameters: sym.parameters,
    returnType: sym.returnType ?? null,
    returnTypeValidated: sym.returnTypeValidated,
    safe: sym.safe,
    exported: true,
    body: [ret],
    loc: sym.loc,
  };
  return out;
}

function buildNodeWrapper(
  localName: string,
  sym: NodeSymbol,
): GraphNodeDefinition {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  const call: FunctionCall = {
    type: "functionCall",
    functionName: internal,
    arguments: buildCallArgs(sym.parameters, sym.loc),
    loc: sym.loc,
  };
  const ret: ReturnStatement = {
    type: "returnStatement",
    value: call,
    loc: sym.loc,
  };
  const out: GraphNodeDefinition = {
    type: "graphNode",
    nodeName: localName,
    parameters: sym.parameters,
    returnType: sym.returnType ?? null,
    returnTypeValidated: sym.returnTypeValidated,
    exported: true,
    body: [ret],
    loc: sym.loc,
  };
  return out;
}

function buildTypeWrapper(localName: string, sym: TypeSymbol): TypeAlias {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  return {
    type: "typeAlias",
    aliasName: localName,
    aliasedType: { type: "typeAliasVariable", aliasName: internal },
    exported: true,
    loc: sym.loc,
  };
}

function buildConstantWrapper(
  localName: string,
  sym: ConstantSymbol,
): Assignment {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  return {
    type: "assignment",
    variableName: localName,
    declKind: "const",
    static: true,
    exported: true,
    value: { type: "variableName", value: internal, loc: sym.loc },
    loc: sym.loc,
  };
}
