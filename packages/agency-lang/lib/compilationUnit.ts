import type {
  AgencyProgram,
  FunctionDefinition,
  FunctionParameter,
  GraphNodeDefinition,
  Scope,
  Tag,
  TypeAliasEntry,
  TypeParam,
  ValueParam,
  VariableType,
} from "./types.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import { getImportedNames } from "./types/importStatement.js";
import type { SymbolTable, InterruptEffect } from "./symbolTable.js";
import { collectTypeAliasTags } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";
import { resultTypeForValidation } from "./typeChecker/validation.js";
import { visitTypes } from "./typeChecker/typeWalker.js";

export const GLOBAL_SCOPE_KEY = "global";

/**
 * Type aliases keyed by the scope they were declared in. Lookups via
 * `visibleIn(scopeKey)` see the requested scope plus the global scope
 * (scope-local overrides global).
 */
export class ScopedTypeAliases {
  private readonly byScope: Record<string, Record<string, TypeAliasEntry>>;

  constructor(initial?: Record<string, Record<string, TypeAliasEntry>>) {
    this.byScope = { [GLOBAL_SCOPE_KEY]: {} };
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.byScope[k] = { ...v };
      }
    }
  }

  add(
    scopeKey: string,
    name: string,
    body: VariableType,
    typeParams?: TypeParam[],
    tags?: Tag[],
    valueParams?: ValueParam[],
    isEffectSet?: boolean,
  ): void {
    if (!this.byScope[scopeKey]) this.byScope[scopeKey] = {};
    const entry: TypeAliasEntry = { body };
    if (typeParams) entry.typeParams = typeParams;
    if (valueParams) entry.valueParams = valueParams;
    if (tags && tags.length > 0) entry.tags = tags;
    if (isEffectSet) entry.isEffectSet = true;
    this.byScope[scopeKey][name] = entry;
  }

  get(scopeKey: string): Record<string, TypeAliasEntry> | undefined {
    return this.byScope[scopeKey];
  }

  /** Flat map of every alias visible in `scopeKey`; scope-local wins. */
  visibleIn(scopeKey: string): Record<string, TypeAliasEntry> {
    return { ...this.byScope[GLOBAL_SCOPE_KEY], ...this.byScope[scopeKey] };
  }

  /** Iterate over every (scopeKey, aliases-in-that-scope) pair. */
  scopes(): [string, Record<string, TypeAliasEntry>][] {
    return Object.entries(this.byScope);
  }

  clone(): ScopedTypeAliases {
    return new ScopedTypeAliases(this.byScope);
  }
}

/**
 * Signature info collected from a SymbolTable for a name brought in via
 * `import { ... }`. Both fields may be populated lazily — `parameters` is
 * filled by the stitch loop in `buildCompilationUnit`, and `returnType`
 * comes from the imported function/node's declaration.
 */
export type ImportedFunctionSignature = {
  parameters: FunctionParameter[];
  returnType: VariableType | null;
  /** Absolute path of the file the symbol was imported from. Used to
   * resolve type aliases referenced by the signature in the right module
   * (so a type-name collision across files picks the right one). */
  originFile?: string;
  /** Name of the symbol as declared in its origin file, before any
   *  `import { foo as bar }` aliasing rewrote it locally. Used by the
   *  interrupt call-graph analysis to build a stable cross-file identity
   *  (`${originFile}:${originalName}`) for resolved call edges. */
  originalName?: string;
};

/**
 * Per-compilation aggregate. Holds the rich AST nodes for the entry file's
 * local declarations plus a typechecker-shaped scoped type-alias map. For
 * any cross-file question — what does this name resolve to in another
 * file? — call methods on the SymbolTable directly.
 */
export type CompilationUnit = {
  functionDefinitions: Record<string, FunctionDefinition>;
  typeAliases: ScopedTypeAliases;
  graphNodes: GraphNodeDefinition[];
  importedNodes: ImportNodeStatement[];
  importStatements: ImportStatement[];
  safeFunctions: Record<string, boolean>;
  importedFunctions: Record<string, ImportedFunctionSignature>;
  /**
   * Local names brought in by non-Agency `import { … } from "some.js"`
   * statements. We don't have signatures for these (they're JS), so they
   * live in their own bag and the typechecker treats them as untyped
   * known-callable bindings — enough to keep undefined-function /
   * variable diagnostics quiet without pretending we know their types.
   */
  jsImportedNames: Record<string, true>;
  /** Original source text. Used by the typechecker to locate
   * `// @tc-nocheck` / `// @tc-ignore` directives. Optional because
   * many callers (including most tests) construct the AST directly. */
  sourceText?: string;
  /** Transitive interrupt effects per function/node, populated from the symbol table. */
  interruptEffectsByFunction?: Record<string, InterruptEffect[]>;
  /** Symbol table used to build this unit. Forwarded so downstream
   *  consumers (e.g. the typechecker) can use it for cross-file lookups
   *  like resolving the file a function/node lives in. Optional because
   *  in-process callers that build a unit from a raw program (no entry
   *  file) don't have one. */
  symbolTable?: SymbolTable;
  /** Absolute path of the file this compilation unit was built from.
   *  Forwarded so downstream consumers (e.g. the typechecker) can tag
   *  scopes with the file they came from without re-running a name
   *  lookup against the symbol table. Undefined when callers build a
   *  unit from a raw program with no entry file. */
  fromFile?: string;
};

export function scopeKey(scope: Scope): string {
  switch (scope.type) {
    case "global":
      return GLOBAL_SCOPE_KEY;
    case "function":
      return `function:${scope.functionName}`;
    case "node":
      return `node:${scope.nodeName}`;
    case "local":
      return `local`;
    case "imported":
      return "imported";
    case "static":
      return "static";
    case "block":
      return `block:${scope.blockName}`;
  }
}

export function buildCompilationUnit(
  program: AgencyProgram,
  symbolTable?: SymbolTable,
  fromFile?: string,
  sourceText?: string,
): CompilationUnit {
  const unit: CompilationUnit = {
    functionDefinitions: {},
    typeAliases: new ScopedTypeAliases(),
    graphNodes: [],
    importedNodes: [],
    importStatements: [],
    importedFunctions: {},
    jsImportedNames: {},
    safeFunctions: {},
    sourceText,
  };

  // Top-level pass: collect functions, graph nodes, imports.
  for (const node of program.nodes) {
    switch (node.type) {
      case "function":
        unit.functionDefinitions[node.functionName] = node;
        if (node.safe) unit.safeFunctions[node.functionName] = true;
        break;
      case "graphNode":
        unit.graphNodes.push(node);
        break;
      case "importNodeStatement":
        unit.importedNodes.push(node);
        break;
      case "importStatement":
        unit.importStatements.push(node);
        for (const nameType of node.importedNames) {
          if (nameType.type !== "namedImport") continue;
          for (const safeName of nameType.safeNames) {
            const localSafe = nameType.aliases[safeName] ?? safeName;
            unit.safeFunctions[localSafe] = true;
          }
        }
        // JS imports (`import { foo } from "./helpers.js"`) don't have
        // typed signatures the way Agency imports do — symbolTable.resolveImport
        // skips them — but the names ARE bound at runtime, so the typechecker
        // shouldn't flag them as undefined. Track them here so resolveCall /
        // resolveVariable can recognize them.
        if (!node.isAgencyImport) {
          for (const nameType of node.importedNames) {
            for (const local of getImportedNames(nameType)) {
              unit.jsImportedNames[local] = true;
            }
          }
        }
        break;
    }
  }

  // Tags on local typeAlias nodes are only attached after the preprocessor
  // runs (which happens AFTER buildCompilationUnit). Pre-collect them here
  // so cross-module annotation propagation works in the first pass.
  const localAliasTags = collectTypeAliasTags(program);

  // Deep walk: collect every type alias keyed by its enclosing scope.
  for (const { node, scopes } of walkNodes(program.nodes)) {
    const key = scopeKey(scopes[scopes.length - 1]);
    if (node.type === "typeAlias") {
      const tags = node.tags && node.tags.length > 0
        ? node.tags
        : localAliasTags[node.aliasName];
      unit.typeAliases.add(
        key,
        node.aliasName,
        node.aliasedType,
        node.typeParams,
        tags,
        node.valueParams,
        node.isEffectSet,
      );
    }
  }

  // Stitch in cross-file information from imports. Entries are only added
  // to importedFunctions when the SymbolTable actually resolves them — an
  // unresolved import (no SymbolTable, missing file, etc.) falls through
  // to the typechecker's builtin/any path instead of being treated as a
  // bogus 0-arg signature.
  if (symbolTable && fromFile) {
    // Type-alias seeds gathered from imports — both directly imported
    // aliases and the types referenced by imported function/node
    // signatures. Each seed remembers the file it came from so transitive
    // resolution can prefer that module on name collisions.
    type AliasSeed = { type: VariableType; preferFile: string };
    const aliasSeeds: AliasSeed[] = [];
    for (const stmt of unit.importStatements) {
      for (const r of symbolTable.resolveImport(stmt, fromFile)) {
        if (r.symbol.kind === "function" || r.symbol.kind === "node") {
          // Pre-wrap the imported return type so consumers see the same
          // caller-visible shape they would for a local def. The runtime
          // validation lives inside the imported function's body, so by
          // the time a value crosses the import boundary it really is a
          // Result<T, string> — the typechecker just needs to agree.
          const returnType = r.symbol.returnType
            ? resultTypeForValidation(
                r.symbol.returnType,
                r.symbol.returnTypeValidated,
              )
            : r.symbol.returnType;
          unit.importedFunctions[r.localName] = {
            parameters: r.symbol.parameters,
            returnType,
            originFile: r.file,
            originalName: r.originalName,
          };
          for (const p of r.symbol.parameters) {
            // eslint-disable-next-line max-depth -- collecting alias seeds from imported function params
            if (p.typeHint) aliasSeeds.push({ type: p.typeHint, preferFile: r.file });
          }
          if (returnType) aliasSeeds.push({ type: returnType, preferFile: r.file });
        }
        if (r.symbol.kind === "function" && r.symbol.safe) {
          unit.safeFunctions[r.localName] = true;
        }
        if (r.symbol.kind === "type") {
          unit.typeAliases.add(
            GLOBAL_SCOPE_KEY,
            r.localName,
            r.symbol.aliasedType,
            r.symbol.typeParams,
            r.symbol.tags,
            r.symbol.valueParams,
            r.symbol.isEffectSet,
          );
          // Imported type's body may reference other aliases from its
          // module — pull those transitively too.
          aliasSeeds.push({ type: r.symbol.aliasedType, preferFile: r.file });
        }
      }
    }
    // Pull in any type aliases referenced by imports so property access
    // on those values resolves correctly. Without this, `let r = exec(...);
    // r.exitCode` errors with "Property 'exitCode' does not exist on type
    // 'ExecResult'" because the alias body lives in the source module and
    // was never imported.
    pullTransitiveAliases(unit, symbolTable, aliasSeeds);

    const interruptEffectsByFunction: Record<string, InterruptEffect[]> = {};
    const fileSymbols = symbolTable.getFile(fromFile);
    if (fileSymbols) {
      for (const [name, sym] of Object.entries(fileSymbols)) {
        if ((sym.kind === "function" || sym.kind === "node") && sym.interruptEffects) {
          interruptEffectsByFunction[name] = sym.interruptEffects;
        }
      }
    }
    for (const stmt of unit.importStatements) {
      for (const r of symbolTable.resolveImport(stmt, fromFile)) {
        if ((r.symbol.kind === "function" || r.symbol.kind === "node") && r.symbol.interruptEffects) {
          interruptEffectsByFunction[r.localName] = r.symbol.interruptEffects;
        }
      }
    }
    for (const stmt of unit.importedNodes) {
      for (const r of symbolTable.resolveImportedNodes(stmt, fromFile)) {
        if (r.symbol.kind === "node" && r.symbol.interruptEffects) {
          interruptEffectsByFunction[r.localName] = r.symbol.interruptEffects;
        }
      }
    }
    unit.interruptEffectsByFunction = interruptEffectsByFunction;
    unit.symbolTable = symbolTable;
    unit.fromFile = fromFile;
  }

  return unit;
}

/**
 * Walk every alias-seed type (from imported function/node signatures and
 * directly imported type aliases) and recursively pull any referenced
 * aliases into the unit's global scope, so the typechecker can resolve
 * property access through them. Walks transitively (an alias whose body
 * references another alias pulls that one too) and tracks visited names
 * to terminate on cycles.
 */
function pullTransitiveAliases(
  unit: CompilationUnit,
  symbolTable: SymbolTable,
  seeds: { type: VariableType; preferFile: string }[],
): void {
  const globalAliases = unit.typeAliases.get(GLOBAL_SCOPE_KEY) ?? {};
  // Each pending alias remembers the file it was referenced from, so
  // resolution prefers the originating module's symbols when a name
  // collides across files.
  const queue: { name: string; preferFile?: string }[] = [];

  for (const seed of seeds) {
    const names: string[] = [];
    collectAliasNames(seed.type, names);
    for (const name of names) queue.push({ name, preferFile: seed.preferFile });
  }

  while (queue.length > 0) {
    const { name, preferFile } = queue.shift()!;
    if (globalAliases[name] !== undefined) continue; // already known
    const found = resolveTypeFromFile(symbolTable, name, preferFile);
    if (!found) continue;
    unit.typeAliases.add(
      GLOBAL_SCOPE_KEY,
      name,
      found.aliasedType,
      found.typeParams,
      found.tags,
      found.valueParams,
      found.isEffectSet,
    );
    // Nested aliases referenced by this type should resolve in the file
    // the type was actually found in (not the original preferFile) — the
    // body's references are scoped to that module.
    const nested: string[] = [];
    collectAliasNames(found.aliasedType, nested);
    for (const n of nested) queue.push({ name: n, preferFile: found.file });
  }
}

/**
 * Look up a type alias by name. Prefers the originating module's symbols
 * (so cross-file name collisions pick the file the import actually came
 * from), then falls back to the global cross-file search. Returns the
 * file the type was found in alongside its body, so callers can resolve
 * nested alias references in that same module.
 */
function resolveTypeFromFile(
  symbolTable: SymbolTable,
  name: string,
  preferFile: string | undefined,
): { aliasedType: VariableType; typeParams?: TypeParam[]; valueParams?: ValueParam[]; tags?: Tag[]; isEffectSet?: boolean; file: string } | undefined {
  if (preferFile) {
    const fileSym = symbolTable.getFile(preferFile)?.[name];
    if (fileSym?.kind === "type") {
      return {
        aliasedType: fileSym.aliasedType,
        typeParams: fileSym.typeParams,
        valueParams: fileSym.valueParams,
        tags: fileSym.tags,
        isEffectSet: fileSym.isEffectSet,
        file: preferFile,
      };
    }
  }
  for (const file of symbolTable.filePaths()) {
    const sym = symbolTable.getFile(file)?.[name];
    if (sym?.kind === "type") {
      return {
        aliasedType: sym.aliasedType,
        typeParams: sym.typeParams,
        valueParams: sym.valueParams,
        tags: sym.tags,
        isEffectSet: sym.isEffectSet,
        file,
      };
    }
  }
  return undefined;
}

function collectAliasNames(t: VariableType, out: string[]): void {
  visitTypes(t, (n) => {
    if (n.type === "typeAliasVariable") out.push(n.aliasName);
  });
}
