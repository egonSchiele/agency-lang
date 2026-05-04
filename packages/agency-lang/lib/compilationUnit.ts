import type {
  AgencyProgram,
  ClassDefinition,
  FunctionDefinition,
  FunctionParameter,
  GraphNodeDefinition,
  Scope,
  VariableType,
} from "./types.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import type { SymbolTable } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";
import { resultTypeForValidation } from "./typeChecker/validation.js";

export const GLOBAL_SCOPE_KEY = "global";

/**
 * Type aliases keyed by the scope they were declared in. Lookups via
 * `visibleIn(scopeKey)` see the requested scope plus the global scope
 * (scope-local overrides global).
 */
export class ScopedTypeAliases {
  private readonly byScope: Record<string, Record<string, VariableType>>;

  constructor(initial?: Record<string, Record<string, VariableType>>) {
    this.byScope = { [GLOBAL_SCOPE_KEY]: {} };
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.byScope[k] = { ...v };
      }
    }
  }

  add(scopeKey: string, name: string, type: VariableType): void {
    if (!this.byScope[scopeKey]) this.byScope[scopeKey] = {};
    this.byScope[scopeKey][name] = type;
  }

  get(scopeKey: string): Record<string, VariableType> | undefined {
    return this.byScope[scopeKey];
  }

  /** Flat map of every alias visible in `scopeKey`; scope-local wins. */
  visibleIn(scopeKey: string): Record<string, VariableType> {
    return { ...this.byScope[GLOBAL_SCOPE_KEY], ...this.byScope[scopeKey] };
  }

  /** Iterate over every (scopeKey, aliases-in-that-scope) pair. */
  scopes(): [string, Record<string, VariableType>][] {
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
  classDefinitions: Record<string, ClassDefinition>;
  /** Original source text. Used by the typechecker to locate
   * `// @tc-nocheck` / `// @tc-ignore` directives. Optional because
   * many callers (including most tests) construct the AST directly. */
  sourceText?: string;
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
    classDefinitions: {},
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
      case "classDefinition":
        unit.classDefinitions[node.className] = node;
        for (const method of node.methods) {
          if (method.safe) {
            unit.safeFunctions[`${node.className}.${method.name}`] = true;
          }
        }
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
        break;
    }
  }

  // Deep walk: collect every type alias keyed by its enclosing scope.
  for (const { node, scopes } of walkNodes(program.nodes)) {
    const key = scopeKey(scopes[scopes.length - 1]);
    if (node.type === "typeAlias") {
      unit.typeAliases.add(key, node.aliasName, node.aliasedType);
    }
  }

  // Stitch in cross-file information from imports. Entries are only added
  // to importedFunctions when the SymbolTable actually resolves them — an
  // unresolved import (no SymbolTable, missing file, etc.) falls through
  // to the typechecker's builtin/any path instead of being treated as a
  // bogus 0-arg signature.
  if (symbolTable && fromFile) {
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
          };
        }
        if (r.symbol.kind === "function" && r.symbol.safe) {
          unit.safeFunctions[r.localName] = true;
        }
        if (r.symbol.kind === "type") {
          unit.typeAliases.add(
            GLOBAL_SCOPE_KEY,
            r.localName,
            r.symbol.aliasedType,
          );
        }
      }
    }
    // Pull in any type aliases referenced by imported function/node
    // signatures so property access on those return values resolves
    // correctly. Without this, `let r = exec(...); r.exitCode` errors with
    // "Property 'exitCode' does not exist on type 'ExecResult'" because
    // the alias body lives in the source module and was never imported.
    pullTransitiveAliases(unit, symbolTable);
  }

  return unit;
}

/**
 * Walk every imported function/node signature and recursively pull any
 * type aliases its parameters or return type reference into the unit's
 * global scope, so the typechecker can resolve property access through
 * them. Walks transitively (an alias whose body references another alias
 * pulls that one too) and tracks visited names to terminate on cycles.
 */
function pullTransitiveAliases(
  unit: CompilationUnit,
  symbolTable: SymbolTable,
): void {
  const globalAliases = unit.typeAliases.get(GLOBAL_SCOPE_KEY) ?? {};
  const queue: string[] = [];

  for (const sig of Object.values(unit.importedFunctions)) {
    for (const p of sig.parameters) {
      if (p.typeHint) collectAliasNames(p.typeHint, queue);
    }
    if (sig.returnType) collectAliasNames(sig.returnType, queue);
  }

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (globalAliases[name] !== undefined) continue; // already known
    const sym = symbolTable.findTypeAcrossFiles(name);
    if (!sym || sym.kind !== "type") continue;
    unit.typeAliases.add(GLOBAL_SCOPE_KEY, name, sym.aliasedType);
    collectAliasNames(sym.aliasedType, queue);
  }
}

function collectAliasNames(t: VariableType, out: string[]): void {
  switch (t.type) {
    case "typeAliasVariable":
      out.push(t.aliasName);
      return;
    case "arrayType":
      collectAliasNames(t.elementType, out);
      return;
    case "unionType":
      for (const m of t.types) collectAliasNames(m, out);
      return;
    case "objectType":
      for (const p of t.properties) collectAliasNames(p.value, out);
      return;
    case "resultType":
      collectAliasNames(t.successType, out);
      collectAliasNames(t.failureType, out);
      return;
    case "blockType":
      for (const p of t.params) collectAliasNames(p.typeAnnotation, out);
      collectAliasNames(t.returnType, out);
      return;
    default:
      return;
  }
}
