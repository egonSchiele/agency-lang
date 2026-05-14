import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "./parser.js";
import type { AgencyConfig } from "./config.js";
import type {
  AgencyNode,
  AgencyProgram,
  FunctionParameter,
  VariableType,
} from "./types.js";
import type { SourceLocation } from "./types/base.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import type { ExportFromStatement } from "./types/exportFromStatement.js";
import { walkNodes } from "./utils/node.js";
import {
  resolveAgencyImportPath,
  isAgencyImport,
  getStdlibDir,
} from "./importPaths.js";

export type InterruptKind = {
  kind: string;
};

/** Type-alias names that resolve to built-in types. */
const RESERVED_TYPE_NAMES = new Set<string>(["Result"]);

/** Marker on a SymbolInfo that entered FileSymbols via an `export from` re-export. */
export type ReExportedFrom = {
  sourceFile: string;
  originalName: string;
};

export type FunctionSymbol = {
  kind: "function";
  name: string;
  loc?: SourceLocation;
  safe: boolean;
  exported: boolean;
  parameters: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
  interruptKinds?: InterruptKind[];
  reExportedFrom?: ReExportedFrom;
};

export type NodeSymbol = {
  kind: "node";
  name: string;
  loc?: SourceLocation;
  parameters: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
  exported?: boolean;
  interruptKinds?: InterruptKind[];
  reExportedFrom?: ReExportedFrom;
};

export type TypeSymbol = {
  kind: "type";
  name: string;
  loc?: SourceLocation;
  exported: boolean;
  aliasedType: VariableType;
  reExportedFrom?: ReExportedFrom;
};

export type ClassSymbol = {
  kind: "class";
  name: string;
  loc?: SourceLocation;
};

export type ConstantSymbol = {
  kind: "constant";
  name: string;
  loc?: SourceLocation;
  exported: boolean;
  reExportedFrom?: ReExportedFrom;
};

export type SymbolInfo = FunctionSymbol | NodeSymbol | TypeSymbol | ClassSymbol | ConstantSymbol;
export type SymbolKind = SymbolInfo["kind"];

/** Maps symbol name → info for a single file. */
export type FileSymbols = Record<string, SymbolInfo>;

/**
 * One named symbol resolved through an import: where it lives, what name
 * the importing file uses, and what it actually is.
 */
export type ResolvedImport = {
  file: string;
  originalName: string;
  localName: string;
  symbol: SymbolInfo;
};

/**
 * Cross-file index of every declaration reachable from an entrypoint.
 * Built eagerly: parses every reachable .agency file, classifies its
 * top-level (and nested type-alias) declarations, and follows imports.
 */
export class SymbolTable {
  private readonly files: Record<string, FileSymbols>;

  constructor(files: Record<string, FileSymbols> = {}) {
    this.files = files;
  }

  static build(entrypoint: string, config: AgencyConfig = {}): SymbolTable {
    const parsed: Record<string, { symbols: FileSymbols; program: AgencyProgram }> = {};
    const visited = new Set<string>();

    function visit(filePath: string): void {
      const absPath = path.resolve(filePath);
      if (visited.has(absPath)) return;
      visited.add(absPath);

      if (!fs.existsSync(absPath)) return;

      if (config.verbose) {
        console.log(`[SymbolTable] Processing ${absPath}`);
      }

      const contents = fs.readFileSync(absPath, "utf-8");
      const isStdlibIndex =
        absPath === path.join(getStdlibDir(), "index.agency");
      const parseResult = parseAgency(contents, config, !isStdlibIndex);
      if (!parseResult.success) {
        if (config.verbose) {
          console.error(
            `[SymbolTable] Failed to parse ${absPath}: ${JSON.stringify(parseResult, null, 2)}`,
          );
        }
        return;
      }

      const program = parseResult.result;
      parsed[absPath] = { symbols: classifySymbols(program), program };

      for (const { node } of walkNodes(program.nodes)) {
        if (node.type === "importNodeStatement") {
          visit(resolveAgencyImportPath(node.agencyFile, absPath));
        } else if (
          node.type === "importStatement" &&
          isAgencyImport(node.modulePath)
        ) {
          visit(resolveAgencyImportPath(node.modulePath, absPath));
        } else if (
          node.type === "exportFromStatement" &&
          isAgencyImport(node.modulePath)
        ) {
          visit(resolveAgencyImportPath(node.modulePath, absPath));
        }
      }
    }

    visit(entrypoint);
    const files: Record<string, FileSymbols> = {};
    for (const [filePath, { symbols }] of Object.entries(parsed)) {
      files[filePath] = symbols;
    }

    // Merge re-exports (exportFromStatement) in dependency order with cycle detection.
    const reExportResolved = new Set<string>();

    function resolveReExports(filePath: string, visiting: string[]): void {
      if (reExportResolved.has(filePath)) return;
      if (visiting.includes(filePath)) {
        const chain = [...visiting, filePath].join(" → ");
        throw new Error(`Re-export cycle detected: ${chain}`);
      }
      const entry = parsed[filePath];
      if (!entry) {
        reExportResolved.add(filePath);
        return;
      }
      const newVisiting = [...visiting, filePath];

      for (const node of entry.program.nodes) {
        if (node.type !== "exportFromStatement") continue;
        if (!isAgencyImport(node.modulePath)) {
          throw new Error(
            `Re-export source must be an Agency module (std::, pkg::, or .agency path): '${node.modulePath}'`,
          );
        }
        const sourcePath = resolveAgencyImportPath(node.modulePath, filePath);
        resolveReExports(sourcePath, newVisiting);
        mergeExportsFrom(files, filePath, sourcePath, node);
      }

      reExportResolved.add(filePath);
    }

    for (const filePath of Object.keys(parsed)) {
      resolveReExports(filePath, []);
    }

    return new SymbolTable(files);
  }

  has(absPath: string): boolean {
    return absPath in this.files;
  }

  getFile(absPath: string): FileSymbols | undefined {
    return this.files[absPath];
  }

  filePaths(): string[] {
    return Object.keys(this.files);
  }

  /**
   * Walk every file looking for a type alias with the given name. Returns
   * the first match in iteration order. Used to surface imported type
   * definitions for Zod schema generation.
   */
  findTypeAcrossFiles(name: string): SymbolInfo | undefined {
    for (const fileSymbols of Object.values(this.files)) {
      const sym = fileSymbols[name];
      if (sym?.kind === "type") return sym;
    }
    return undefined;
  }

  /**
   * Resolve every named symbol in an import statement to its source file
   * + SymbolInfo. Skips namespace and default imports. Returns [] for
   * non-Agency imports.
   */
  resolveImport(stmt: ImportStatement, fromFile: string): ResolvedImport[] {
    if (!isAgencyImport(stmt.modulePath)) return [];
    const file = resolveAgencyImportPath(stmt.modulePath, fromFile);
    const out: ResolvedImport[] = [];
    for (const nameType of stmt.importedNames) {
      if (nameType.type !== "namedImport") continue;
      for (const originalName of nameType.importedNames) {
        const symbol = this.files[file]?.[originalName];
        if (!symbol) continue;
        out.push({
          file,
          originalName,
          localName: nameType.aliases[originalName] ?? originalName,
          symbol,
        });
      }
    }
    return out;
  }

  resolveImportedNodes(
    stmt: ImportNodeStatement,
    fromFile: string,
  ): ResolvedImport[] {
    const file = resolveAgencyImportPath(stmt.agencyFile, fromFile);
    const out: ResolvedImport[] = [];
    for (const name of stmt.importedNodes) {
      const symbol = this.files[file]?.[name];
      if (!symbol) continue;
      out.push({ file, originalName: name, localName: name, symbol });
    }
    return out;
  }
}

/**
 * Classify symbols in a parsed Agency program.
 *
 * Uses walkNodes to descend into every nested body so we can also reach
 * symbols that aren't legal at the inner location and reject them with
 * a useful diagnostic (e.g. type aliases declared inside a function /
 * node / class body — see the `typeAlias` case below).
 */
export function classifySymbols(program: AgencyProgram): FileSymbols {
  const symbols: FileSymbols = {};

  for (const { node, ancestors } of walkNodes(program.nodes)) {
    switch (node.type) {
      case "graphNode":
        symbols[node.nodeName] = {
          kind: "node",
          name: node.nodeName,
          loc: node.loc,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
          returnTypeValidated: node.returnTypeValidated,
          exported: !!node.exported,
          interruptKinds: collectDirectInterruptKinds(node.body),
        };
        break;
      case "function":
        symbols[node.functionName] = {
          kind: "function",
          name: node.functionName,
          loc: node.loc,
          safe: !!node.safe,
          exported: !!node.exported,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
          returnTypeValidated: node.returnTypeValidated,
          interruptKinds: collectDirectInterruptKinds(node.body),
        };
        break;
      case "typeAlias":
        if (RESERVED_TYPE_NAMES.has(node.aliasName)) {
          throw new Error(
            `'${node.aliasName}' is a reserved built-in type; cannot be redefined.`,
          );
        }
        // Type aliases are only allowed at the top (module) level.
        // Declaring them inside a function/node/class body is not
        // supported because Agency types are runtime zod schemas
        // shared across all runner.step closures, so a "local" alias
        // wouldn't actually be local — moving it to the top level is
        // the right fix.
        for (const a of ancestors) {
          if (
            a.type === "function" ||
            a.type === "graphNode" ||
            a.type === "classDefinition"
          ) {
            const where =
              a.type === "function"
                ? `function '${a.functionName}'`
                : a.type === "graphNode"
                  ? `node '${a.nodeName}'`
                  : `class '${a.className}'`;
            throw new Error(
              `Type alias '${node.aliasName}' must be declared at the top level, not inside ${where}.`,
            );
          }
        }
        symbols[node.aliasName] = {
          kind: "type",
          name: node.aliasName,
          loc: node.loc,
          exported: !!node.exported,
          aliasedType: node.aliasedType,
        };
        break;
      case "classDefinition":
        symbols[node.className] = {
          kind: "class",
          name: node.className,
          loc: node.loc,
        };
        break;
      case "assignment":
        if (node.exported && node.static && node.declKind === "const") {
          symbols[node.variableName] = {
            kind: "constant",
            name: node.variableName,
            loc: node.loc,
            exported: true,
          };
        }
        break;
    }
  }

  return symbols;
}

function collectDirectInterruptKinds(body: AgencyNode[]): InterruptKind[] {
  const kinds: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement" && !kinds.includes(node.kind)) {
      kinds.push(node.kind);
    }
  }
  return kinds.map((k) => ({ kind: k }));
}

function isExportedSymbol(sym: SymbolInfo): boolean {
  if (sym.kind === "class") return false;
  // Nodes are importable without an explicit `export` keyword (see importResolver
  // — node imports skip the assertExported check). Treat them as exported for
  // re-export purposes so `export { main } from "..."` and `export * from "..."`
  // pick them up regardless of whether the source wrote `export node`.
  if (sym.kind === "node") return true;
  return !!sym.exported;
}

function symbolKindLabel(sym: SymbolInfo): string {
  switch (sym.kind) {
    case "function":
      return "Function";
    case "node":
      return "Node";
    case "type":
      return "Type";
    // The "constant" and "class" branches below are defensive — the only
    // current caller (the namedExport "not exported" error path) cannot reach
    // them: ConstantSymbol is only ever added when `exported && static && const`,
    // and class re-exports are rejected earlier with their own error message.
    case "constant":
      return "Constant";
    case "class":
      return "Class";
  }
}

/**
 * Merge symbols flowing through one `exportFromStatement` from `sourcePath`
 * into the re-exporter's `FileSymbols`. Hard errors on missing symbols,
 * class re-exports, non-exported sources, and collisions.
 */
export function mergeExportsFrom(
  files: Record<string, FileSymbols>,
  reExporterPath: string,
  sourcePath: string,
  stmt: ExportFromStatement,
): void {
  const sourceSymbols = files[sourcePath];
  if (!sourceSymbols) {
    throw new Error(
      `Re-export source '${stmt.modulePath}' could not be resolved`,
    );
  }
  const targetSymbols: FileSymbols = files[reExporterPath] ?? {};
  files[reExporterPath] = targetSymbols;

  if (stmt.body.kind === "starExport") {
    for (const [name, sym] of Object.entries(sourceSymbols)) {
      if (sym.kind === "class") continue; // silently skip classes in star
      if (!isExportedSymbol(sym)) continue;
      mergeOne(targetSymbols, name, name, sym, false, sourcePath, stmt);
    }
    return;
  }

  // namedExport
  for (const originalName of stmt.body.names) {
    const sym = sourceSymbols[originalName];
    if (!sym) {
      throw new Error(
        `Symbol '${originalName}' is not defined in '${stmt.modulePath}'`,
      );
    }
    if (sym.kind === "class") {
      throw new Error(
        `Classes cannot be re-exported (symbol '${originalName}' in '${stmt.modulePath}')`,
      );
    }
    if (!isExportedSymbol(sym)) {
      throw new Error(
        `${symbolKindLabel(sym)} '${originalName}' in '${stmt.modulePath}' is not exported. Add the 'export' keyword to its definition.`,
      );
    }
    const localName = stmt.body.aliases[originalName] ?? originalName;
    if (sym.kind === "node" && localName !== originalName) {
      throw new Error(
        `Node '${originalName}' from '${stmt.modulePath}' cannot be re-exported under a different name. ` +
          `Re-exported nodes preserve their original name because the source graph is merged wholesale.`,
      );
    }
    const isSafe = stmt.body.safeNames.includes(originalName);
    if (sym.kind === "node" && isSafe) {
      throw new Error(
        `The 'safe' modifier cannot be applied to node '${originalName}' from '${stmt.modulePath}'. ` +
          `'safe' is only meaningful for functions; nodes do not carry a safe flag.`,
      );
    }
    mergeOne(targetSymbols, localName, originalName, sym, isSafe, sourcePath, stmt);
  }
}

function mergeOne(
  targetSymbols: FileSymbols,
  localName: string,
  originalName: string,
  sourceSym: SymbolInfo,
  forceSafe: boolean,
  sourcePath: string,
  stmt: ExportFromStatement,
): void {
  const existing = targetSymbols[localName];
  if (existing) {
    if (!("reExportedFrom" in existing) || !existing.reExportedFrom) {
      const at = existing.loc ? ` at line ${existing.loc.line + 1}` : "";
      throw new Error(
        `Re-exported name '${localName}' collides with local declaration${at}`,
      );
    }
    const sameSource =
      existing.reExportedFrom.sourceFile === sourcePath &&
      existing.reExportedFrom.originalName === originalName;
    if (!sameSource) {
      throw new Error(
        `Name '${localName}' is re-exported from both '${existing.reExportedFrom.sourceFile}' and '${sourcePath}'. Disambiguate with explicit 'export { ${localName} as ... } from ...'.`,
      );
    }
    return; // idempotent re-merge
  }

  // Build the merged entry. We copy the source's SymbolInfo fields and
  // override name, loc, exported, and (for functions) safe.
  if (sourceSym.kind === "class") {
    // Defensive: callers must filter classes out before this point.
    throw new Error(`Cannot re-export class '${originalName}'`);
  }

  const base = {
    name: localName,
    loc: stmt.loc,
    reExportedFrom: { sourceFile: sourcePath, originalName },
  };

  let copied: SymbolInfo;
  switch (sourceSym.kind) {
    case "function":
      copied = {
        ...sourceSym,
        ...base,
        exported: true,
        safe: forceSafe ? true : sourceSym.safe,
      };
      break;
    case "node":
      copied = { ...sourceSym, ...base, exported: true };
      break;
    case "type":
      copied = { ...sourceSym, ...base, exported: true };
      break;
    case "constant":
      copied = { ...sourceSym, ...base, exported: true };
      break;
  }
  targetSymbols[localName] = copied;
}
