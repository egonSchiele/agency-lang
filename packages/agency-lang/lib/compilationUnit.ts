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
          if (node.isAgencyImport) {
            for (const name of nameType.importedNames) {
              const localName = nameType.aliases[name] ?? name;
              unit.importedFunctions[localName] = { parameters: [], returnType: null };
            }
          }
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

  // Stitch in cross-file information from imports. Both passes use
  // resolveImport, so the (file, original→local) mapping is computed once
  // per statement instead of being re-derived from raw symbol-table loops.
  if (symbolTable && fromFile) {
    for (const stmt of unit.importStatements) {
      for (const r of symbolTable.resolveImport(stmt, fromFile)) {
        if (
          (r.symbol.kind === "function" || r.symbol.kind === "node") &&
          unit.importedFunctions[r.localName]
        ) {
          unit.importedFunctions[r.localName].parameters = r.symbol.parameters;
          unit.importedFunctions[r.localName].returnType = r.symbol.returnType;
        }
        if (r.symbol.kind === "function" && r.symbol.safe) {
          unit.safeFunctions[r.localName] = true;
        }
        if (r.symbol.kind === "type") {
          unit.typeAliases.add(GLOBAL_SCOPE_KEY, r.localName, r.symbol.aliasedType);
        }
      }
    }
  }

  return unit;
}
