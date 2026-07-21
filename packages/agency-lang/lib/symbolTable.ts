import * as fs from "fs";
import * as path from "path";
import { parseAgencyFileCached } from "./parseCache.js";
import { parseAgency } from "./parser.js";
import type { AgencyConfig } from "./config.js";
import type {
  AgencyNode,
  AgencyProgram,
  FunctionMarkers,
  FunctionParameter,
  Tag,
  TypeParam,
  ValueParam,
  VariableType,
} from "./types.js";
import type { SourceLocation } from "./types/base.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import type { ExportFromStatement } from "./types/exportFromStatement.js";
import type { EffectDeclaration } from "./types/effectDeclaration.js";
import { walkNodes } from "./utils/node.js";
import {
  resolveAgencyImportPath,
  isAgencyImport,
  isNonTemplatedStdlib,
} from "./importPaths.js";

export type InterruptEffect = {
  effect: string;
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
  markers?: FunctionMarkers;
  exported: boolean;
  parameters: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
  interruptEffects?: InterruptEffect[];
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
  interruptEffects?: InterruptEffect[];
  reExportedFrom?: ReExportedFrom;
};

export type TypeSymbol = {
  kind: "type";
  name: string;
  loc?: SourceLocation;
  exported: boolean;
  aliasedType: VariableType;
  /** Type parameters for generic aliases (e.g., `T` in `type Container<T> = ...`). */
  typeParams?: TypeParam[];
  /** Value parameters for value-parameterized aliases (e.g. `low` and `high`
   * in `type NumberInRange(low: number, high: number) = number`).
   * Carried through imports/re-exports alongside `typeParams`. */
  valueParams?: ValueParam[];
  /** `@validate(...)` / `@jsonSchema(...)` annotations declared above the alias.
   * Carried through imports/re-exports so annotation metadata flows across modules. */
  tags?: Tag[];
  /** True when declared via `effectSet` (not `type`). Carried through imports
   *  so an imported effect set is recognized as one. */
  isEffectSet?: boolean;
  reExportedFrom?: ReExportedFrom;
};

export type ConstantSymbol = {
  kind: "constant";
  name: string;
  loc?: SourceLocation;
  exported: boolean;
  reExportedFrom?: ReExportedFrom;
};

export type SymbolInfo = FunctionSymbol | NodeSymbol | TypeSymbol | ConstantSymbol;
export type SymbolKind = SymbolInfo["kind"];

/** Maps symbol name → info for a single file. */
export type FileSymbols = Record<string, SymbolInfo>;

export type ImportModuleResolution =
  | { kind: "missing" }
  | { kind: "notLoaded" }
  | { kind: "loaded"; symbols: FileSymbols };

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
  private readonly effectDecls: Record<string, EffectDeclaration[]>;

  constructor(
    files: Record<string, FileSymbols> = {},
    effectDecls: Record<string, EffectDeclaration[]> = {},
  ) {
    this.files = files;
    this.effectDecls = effectDecls;
  }

  /**
   * @param overrides Maps an absolute file path to in-memory source that
   *   replaces the on-disk contents for that file. The LSP passes the active
   *   editor buffer here so an unsaved edit (e.g. a just-typed `import`) is
   *   reflected in the symbol table without waiting for a save. Keyed by
   *   `path.resolve`d absolute path to match how `visit` normalizes paths.
   */
  static build(
    entrypoint: string | string[],
    config: AgencyConfig = {},
    overrides: Record<string, string> = {},
  ): SymbolTable {
    const parsed: Record<string, { symbols: FileSymbols; program: AgencyProgram }> = {};
    const visited = new Set<string>();

    function visit(filePath: string): void {
      const absPath = path.resolve(filePath);
      if (visited.has(absPath)) return;
      visited.add(absPath);

      const override = overrides[absPath];
      if (override === undefined && !fs.existsSync(absPath)) return;

      if (config.verbose) {
        console.log(`[SymbolTable] Processing ${absPath}`);
      }

      const applyTemplate = !isNonTemplatedStdlib(absPath);
      // An override is unsaved buffer text with no meaningful mtime/size, so
      // parse it directly rather than through the disk-keyed parse cache.
      const parseResult =
        override !== undefined
          ? parseAgency(override, config, applyTemplate)
          : parseAgencyFileCached(absPath, config, applyTemplate);
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

      // Following an import may throw before it can be visited — e.g. a
      // `pkg::` module that isn't installed makes `resolveAgencyImportPath`
      // throw. That must not abort the whole crawl: symbol discovery is
      // best-effort, and the unresolvable import is reported downstream (by
      // resolveImports / the type checker's checkMissingImports) with a proper
      // location. Skip what won't resolve and keep crawling the rest.
      const visitImport = (modulePath: string): void => {
        try {
          visit(resolveAgencyImportPath(modulePath, absPath));
        } catch {
          /* unresolvable import path — reported downstream, not here */
        }
      };
      for (const { node } of walkNodes(program.nodes)) {
        if (node.type === "importNodeStatement") {
          visitImport(node.agencyFile);
        } else if (
          node.type === "importStatement" &&
          isAgencyImport(node.modulePath)
        ) {
          visitImport(node.modulePath);
        } else if (
          node.type === "exportFromStatement" &&
          isAgencyImport(node.modulePath)
        ) {
          visitImport(node.modulePath);
        }
      }
    }

    const entrypoints = Array.isArray(entrypoint) ? entrypoint : [entrypoint];
    for (const e of entrypoints) {
      visit(e);
    }
    const files: Record<string, FileSymbols> = {};
    for (const [filePath, { symbols }] of Object.entries(parsed)) {
      files[filePath] = symbols;
    }

    // Effect declarations can appear at the top level OR nested inside
    // function/node/block bodies (the parser permits both). Deep-walk so
    // body-scoped declarations are also registered in the ambient
    // registry — matches how `classifySymbols` collects type aliases.
    const effectDecls: Record<string, EffectDeclaration[]> = {};
    for (const [filePath, { program }] of Object.entries(parsed)) {
      const decls: EffectDeclaration[] = [];
      for (const { node } of walkNodes(program.nodes)) {
        if (node.type === "effectDeclaration") decls.push(node);
      }
      if (decls.length > 0) effectDecls[filePath] = decls;
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

    return new SymbolTable(files, effectDecls);
  }

  has(absPath: string): boolean {
    return absPath in this.files;
  }

  getFile(absPath: string): FileSymbols | undefined {
    return this.files[absPath];
  }

  /**
   * Classify an import's target module for the strict-imports check.
   * - `missing`   — the path resolves to nothing on disk, or resolution threw
   *                 (e.g. an unresolvable `pkg::`).
   * - `notLoaded` — the file exists on disk but was never crawled into this
   *                 table (a parse failure in it, or a partial single-file
   *                 check). The caller must stay silent: the view is incomplete.
   * - `loaded`    — the file was crawled; `symbols` is its FileSymbols.
   */
  resolveImportModule(
    modulePath: string,
    fromFile: string,
    config?: AgencyConfig,
  ): ImportModuleResolution {
    let resolved: string;
    try {
      resolved = path.resolve(resolveAgencyImportPath(modulePath, fromFile));
    } catch (e) {
      // An unresolvable `pkg::` throwing is the EXPECTED path here, so we
      // report it as `missing` rather than crashing. But don't swallow the
      // error entirely: an unexpected resolution bug (malformed path, internal
      // fault) would otherwise be silently mislabelled "Cannot find module".
      // Surface it under verbose, matching how `build` logs.
      if (config?.verbose) {
        console.error(`[resolveImportModule] '${modulePath}' failed to resolve:`, e);
      }
      return { kind: "missing" };
    }
    if (!fs.existsSync(resolved)) {
      return { kind: "missing" };
    }
    const symbols = this.getFile(resolved);
    if (symbols === undefined) {
      return { kind: "notLoaded" };
    }
    return { kind: "loaded", symbols };
  }

  /** Every effect declaration reachable in the closure, tagged with its
   *  source file. Includes duplicates so the typechecker can detect
   *  same-file dups and cross-file conflicts. */
  allEffectDeclarations(): { decl: EffectDeclaration; file: string }[] {
    return Object.entries(this.effectDecls).flatMap(([file, decls]) =>
      decls.map((decl) => ({ decl, file })),
    );
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
 * Walk the top-level program node list to find `@tag(...)` nodes
 * sitting directly above type aliases, returning a map from alias name
 * to its pending tag list. This mirrors what the TypescriptPreprocessor's
 * `attachTags` does later in the pipeline, but happens early so symbol
 * table consumers (other modules that import this alias) see annotations
 * attached to the TypeSymbol.
 *
 * Pre-pass only, no mutation: keeps SymbolTable.build idempotent and
 * decoupled from the preprocessor.
 */
export function collectTypeAliasTags(program: AgencyProgram): Record<string, Tag[]> {
  const byName: Record<string, Tag[]> = {};
  function walk(nodes: AgencyNode[]): void {
    let pending: Tag[] = [];
    for (const node of nodes) {
      if (node.type === "tag") {
        pending.push(node);
        continue;
      }
      if (node.type === "typeAlias" && pending.length > 0) {
        byName[node.aliasName] = [...(byName[node.aliasName] ?? []), ...pending];
      }
      pending = [];
      // Recurse into nested bodies that may contain typeAlias + tag siblings.
      if ((node as any).body && Array.isArray((node as any).body)) {
        walk((node as any).body);
      }
    }
  }
  walk(program.nodes);
  return byName;
}

/**
 * Classify symbols in a parsed Agency program.
 * Uses walkNodes to find symbols at all nesting levels (e.g. type aliases inside functions).
 */
export function classifySymbols(program: AgencyProgram): FileSymbols {
  const symbols: FileSymbols = {};
  const typeAliasTags = collectTypeAliasTags(program);

  for (const { node } of walkNodes(program.nodes)) {
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
          interruptEffects: collectDirectInterruptEffects(node.nodeName, node.body),
        };
        break;
      case "function":
        symbols[node.functionName] = {
          kind: "function",
          name: node.functionName,
          loc: node.loc,
          markers: node.markers,
          exported: !!node.exported,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
          returnTypeValidated: node.returnTypeValidated,
          interruptEffects: collectDirectInterruptEffects(node.functionName, node.body),
        };
        break;
      case "typeAlias":
        if (RESERVED_TYPE_NAMES.has(node.aliasName)) {
          throw new Error(
            `'${node.aliasName}' is a reserved built-in type; cannot be redefined.`,
          );
        }
        symbols[node.aliasName] = {
          kind: "type",
          name: node.aliasName,
          loc: node.loc,
          exported: !!node.exported,
          aliasedType: node.aliasedType,
          ...(node.typeParams ? { typeParams: node.typeParams } : {}),
          ...(node.valueParams ? { valueParams: node.valueParams } : {}),
          ...(node.isEffectSet ? { isEffectSet: true } : {}),
          ...(typeAliasTags[node.aliasName]?.length
            ? { tags: typeAliasTags[node.aliasName] }
            : {}),
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

/** Effects raised by a stdlib impl on the TS SIDE, invisible to the
 *  interrupt-statement walk below. `_guard` (the guard construct's
 *  lowering target, stdlib/index.agency) raises `std::guard` trips
 *  from the runtime (lib/runtime/guardTripInterrupt.ts), so its effect
 *  is seeded at the symbol — every import path, including the
 *  auto-injected prelude, then carries it, and the existing transitive
 *  machinery marks every function containing a guard construct. Keyed
 *  by name: a user def shadowing `_guard` would inherit the seed, an
 *  accepted overapproximation for an underscore-internal name. */
const TS_SIDE_EFFECT_SEEDS: Record<string, string[]> = Object.assign(
  // Null prototype + own-property read below: the index is a
  // user-controlled symbol name, and a def named `__proto__` (or any
  // Object.prototype member) must not resolve through the prototype
  // chain to a non-array.
  Object.create(null),
  {
    _guard: ["std::guard"],
  },
);

function collectDirectInterruptEffects(
  name: string,
  body: AgencyNode[],
): InterruptEffect[] {
  const seeded = Object.prototype.hasOwnProperty.call(
    TS_SIDE_EFFECT_SEEDS,
    name,
  )
    ? TS_SIDE_EFFECT_SEEDS[name]
    : [];
  const effects: string[] = [...seeded];
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement" && !effects.includes(node.effect)) {
      effects.push(node.effect);
    }
  }
  return effects.map((e) => ({ effect: e }));
}

export function isExportedSymbol(sym: SymbolInfo): boolean {
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
    // The "constant" branch below is defensive — the only current caller
    // (the namedExport "not exported" error path) cannot reach it:
    // ConstantSymbol is only ever added when `exported && static && const`.
    case "constant":
      return "Constant";
  }
}

/**
 * Merge symbols flowing through one `exportFromStatement` from `sourcePath`
 * into the re-exporter's `FileSymbols`. Hard errors on missing symbols,
 * non-exported sources, and collisions.
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
      if (!isExportedSymbol(sym)) continue;
      // Star re-exports carry no per-name modifiers; markers are inherited
      // from the source symbol via the spread inside mergeOne.
      mergeOne(targetSymbols, name, name, sym, false, false, sourcePath, stmt);
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
    const isDestructive =
      stmt.body.destructiveNames?.includes(originalName) ?? false;
    const isIdempotent =
      stmt.body.idempotentNames?.includes(originalName) ?? false;
    if (sym.kind === "node" && (isDestructive || isIdempotent)) {
      throw new Error(
        `A retry-safety marker (destructive/idempotent) cannot be applied to node '${originalName}' from '${stmt.modulePath}'. ` +
          `Markers are only meaningful for functions.`,
      );
    }
    mergeOne(
      targetSymbols,
      localName,
      originalName,
      sym,
      isDestructive,
      isIdempotent,
      sourcePath,
      stmt,
    );
  }
}

function mergeOne(
  targetSymbols: FileSymbols,
  localName: string,
  originalName: string,
  sourceSym: SymbolInfo,
  forceDestructive: boolean,
  forceIdempotent: boolean,
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
  // override name, loc, and exported.
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
      };
      // `markers` is copied by the spread above (inherited from the source
      // definition); a `destructive`/`idempotent` modifier on the re-export
      // itself adds it on top. This is the re-export propagation the plan
      // review flagged.
      if (forceDestructive) {
        copied.markers = { ...(copied.markers ?? {}), destructive: true };
      }
      if (forceIdempotent) {
        copied.markers = { ...(copied.markers ?? {}), idempotent: true };
      }
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
