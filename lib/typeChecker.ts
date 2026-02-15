import { color } from "termcolors";
import { AgencyConfig, BUILTIN_FUNCTIONS } from "./config.js";
import {
  AgencyNode,
  AgencyProgram,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
  TypeAlias,
  TypeHint,
  Assignment,
  FunctionCall,
  ReturnStatement,
} from "./types.js";
import { walkNodes } from "./utils/node.js";
import { formatTypeHint } from "./cli/util.js";

export type TypeCheckError = {
  message: string;
  variableName?: string;
  expectedType?: string;
  actualType?: string;
};

export type TypeCheckResult = {
  errors: TypeCheckError[];
};

type ScopeInfo = {
  variableTypes: Record<string, VariableType | "any">;
  body: AgencyNode[];
  name: string;
  returnType?: VariableType | null;
};

export class TypeChecker {
  private program: AgencyProgram;
  private config: AgencyConfig;
  private typeAliases: Record<string, VariableType> = {};
  private functionDefs: Record<string, FunctionDefinition> = {};
  private nodeDefs: Record<string, GraphNodeDefinition> = {};
  private errors: TypeCheckError[] = [];

  constructor(program: AgencyProgram, config: AgencyConfig = {}) {
    this.program = program;
    this.config = config;
  }

  check(): TypeCheckResult {
    this.errors = [];
    this.collectTypeAliases();
    this.collectFunctionDefs();
    this.checkScopes();
    return { errors: this.errors };
  }

  private collectTypeAliases(): void {
    for (const node of this.program.nodes) {
      if (node.type === "typeAlias") {
        this.typeAliases[node.aliasName] = node.aliasedType;
      }
    }
    // Validate that type aliases don't reference unknown aliases
    for (const [name, aliasedType] of Object.entries(this.typeAliases)) {
      this.validateTypeReferences(aliasedType, name);
    }
  }

  private validateTypeReferences(vt: VariableType, context: string): void {
    switch (vt.type) {
      case "typeAliasVariable":
        if (!this.typeAliases[vt.aliasName]) {
          this.errors.push({
            message: `Type alias '${vt.aliasName}' is not defined (referenced in '${context}').`,
          });
        }
        break;
      case "arrayType":
        this.validateTypeReferences(vt.elementType, context);
        break;
      case "unionType":
        for (const t of vt.types) {
          this.validateTypeReferences(t, context);
        }
        break;
      case "objectType":
        for (const prop of vt.properties) {
          this.validateTypeReferences(prop.value, context);
        }
        break;
    }
  }

  private collectFunctionDefs(): void {
    for (const node of this.program.nodes) {
      if (node.type === "function") {
        this.functionDefs[node.functionName] = node;
      } else if (node.type === "graphNode") {
        this.nodeDefs[node.nodeName] = node;
      }
    }
  }

  private checkScopes(): void {
    // Build scopes for top-level, each function, and each graph node
    const scopes: ScopeInfo[] = [];

    // Top-level scope
    const topLevelVars: Record<string, VariableType | "any"> = {};
    this.collectVariableTypes(this.program.nodes, topLevelVars, "top-level");
    scopes.push({
      variableTypes: topLevelVars,
      body: this.program.nodes,
      name: "top-level",
    });

    // Function scopes
    for (const fn of Object.values(this.functionDefs)) {
      const vars: Record<string, VariableType | "any"> = {};
      for (const param of fn.parameters) {
        vars[param.name] = param.typeHint ?? "any";
      }
      this.collectVariableTypes(fn.body, vars, fn.functionName);
      scopes.push({
        variableTypes: vars,
        body: fn.body,
        name: fn.functionName,
        returnType: fn.returnType,
      });
    }

    // Graph node scopes
    for (const node of Object.values(this.nodeDefs)) {
      const vars: Record<string, VariableType | "any"> = {};
      for (const param of node.parameters) {
        vars[param.name] = param.typeHint ?? "any";
      }
      this.collectVariableTypes(node.body, vars, node.nodeName);
      scopes.push({
        variableTypes: vars,
        body: node.body,
        name: node.nodeName,
        returnType: node.returnType,
      });
    }

    // Now check function calls and return types within each scope
    for (const scope of scopes) {
      this.checkFunctionCallsInScope(scope);
      if (scope.returnType !== undefined) {
        this.checkReturnTypesInScope(scope);
      }
    }
  }

  private collectVariableTypes(
    nodes: AgencyNode[],
    vars: Record<string, VariableType | "any">,
    scopeName: string,
  ): void {
    // First pass: collect standalone TypeHint nodes
    const typeHints: Record<string, VariableType> = {};
    for (const node of nodes) {
      if (node.type === "typeHint") {
        typeHints[node.variableName] = node.variableType;
        this.validateTypeReferences(node.variableType, node.variableName);
      }
    }

    // Second pass: collect assignments
    for (const node of nodes) {
      if (node.type === "assignment") {
        const existingType = vars[node.variableName];
        const newType =
          node.typeHint ?? typeHints[node.variableName] ?? undefined;

        if (newType) {
          this.validateTypeReferences(newType, node.variableName);
          // Check reassignment consistency
          if (
            existingType &&
            existingType !== "any" &&
            !this.isAssignable(newType, existingType)
          ) {
            this.errors.push({
              message: `Type '${formatTypeHint(newType)}' is not assignable to type '${formatTypeHint(existingType)}'.`,
              variableName: node.variableName,
              expectedType: formatTypeHint(existingType),
              actualType: formatTypeHint(newType),
            });
          }
          vars[node.variableName] = newType;
        } else if (existingType) {
          // Variable being reassigned without a new type annotation
          // Check if the value's inferred type is compatible
          const valueType = this.inferExpressionType(node.value, vars);
          if (
            valueType !== "any" &&
            existingType !== "any" &&
            !this.isAssignable(valueType, existingType)
          ) {
            this.errors.push({
              message: `Type '${typeof valueType === "string" ? valueType : formatTypeHint(valueType)}' is not assignable to type '${formatTypeHint(existingType)}'.`,
              variableName: node.variableName,
              expectedType: formatTypeHint(existingType),
              actualType:
                typeof valueType === "string"
                  ? valueType
                  : formatTypeHint(valueType),
            });
          }
        } else {
          // No type annotation anywhere
          if (this.config.strictTypes) {
            this.errors.push({
              message: `Variable '${node.variableName}' has no type annotation (strict mode).`,
              variableName: node.variableName,
            });
          }
          vars[node.variableName] = "any";
        }
      }
    }

    // Also walk into nested blocks (if/while) to collect types
    for (const node of nodes) {
      if (node.type === "ifElse") {
        this.collectVariableTypes(node.thenBody, vars, scopeName);
        if (node.elseBody) {
          this.collectVariableTypes(node.elseBody, vars, scopeName);
        }
      } else if (node.type === "whileLoop") {
        this.collectVariableTypes(node.body, vars, scopeName);
      } else if (node.type === "timeBlock") {
        this.collectVariableTypes(node.body, vars, scopeName);
      } else if (node.type === "messageThread") {
        this.collectVariableTypes(node.body, vars, scopeName);
      }
    }
  }

  private checkFunctionCallsInScope(scope: ScopeInfo): void {
    for (const { node } of walkNodes(scope.body)) {
      if (node.type === "functionCall") {
        this.checkSingleFunctionCall(node, scope.variableTypes);
      }
    }
  }

  private checkSingleFunctionCall(
    call: FunctionCall,
    scopeVars: Record<string, VariableType | "any">,
  ): void {
    // Skip builtins
    if (call.functionName in BUILTIN_FUNCTIONS) return;

    const fn = this.functionDefs[call.functionName];
    const graphNode = this.nodeDefs[call.functionName];
    const def = fn ?? graphNode;
    if (!def) return; // External/unknown function, skip

    const params = def.parameters;

    // Arity check
    if (call.arguments.length !== params.length) {
      this.errors.push({
        message: `Expected ${params.length} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
      });
      return;
    }

    // Type check each argument
    for (let i = 0; i < call.arguments.length; i++) {
      const paramType = params[i].typeHint;
      if (!paramType) continue; // No type hint on param, skip

      const argType = this.inferExpressionType(call.arguments[i], scopeVars);
      if (argType === "any") continue;

      if (!this.isAssignable(argType, paramType)) {
        this.errors.push({
          message: `Argument type '${formatTypeHint(argType)}' is not assignable to parameter type '${formatTypeHint(paramType)}' in call to '${call.functionName}'.`,
          expectedType: formatTypeHint(paramType),
          actualType: formatTypeHint(argType),
        });
      }
    }
  }

  private checkReturnTypesInScope(scope: ScopeInfo): void {
    if (!scope.returnType) return; // null or undefined means no return type

    for (const { node } of walkNodes(scope.body)) {
      if (node.type === "returnStatement") {
        const valueType = this.inferExpressionType(
          node.value,
          scope.variableTypes,
        );
        if (valueType === "any") continue;

        if (!this.isAssignable(valueType, scope.returnType)) {
          this.errors.push({
            message: `Return type '${formatTypeHint(valueType)}' is not assignable to declared return type '${formatTypeHint(scope.returnType)}' in '${scope.name}'.`,
            expectedType: formatTypeHint(scope.returnType),
            actualType: formatTypeHint(valueType),
          });
        }
      }
    }
  }

  private inferExpressionType(
    expr: AgencyNode,
    scopeVars: Record<string, VariableType | "any">,
  ): VariableType | "any" {
    switch (expr.type) {
      case "variableName": {
        const t = scopeVars[expr.value];
        return t ?? "any";
      }
      case "number":
        return { type: "primitiveType", value: "number" };
      case "string":
      case "multiLineString":
        return { type: "primitiveType", value: "string" };
      case "prompt":
        return "any"; // LLM output type depends on type hint
      case "functionCall": {
        // Skip builtins
        if (expr.functionName in BUILTIN_FUNCTIONS) return "any";
        const fn = this.functionDefs[expr.functionName];
        const graphNode = this.nodeDefs[expr.functionName];
        const def = fn ?? graphNode;
        if (def?.returnType) return def.returnType;
        return "any";
      }
      case "agencyArray":
        return "any"; // Could be refined but keeping simple
      case "agencyObject":
        return "any"; // Could be refined but keeping simple
      case "accessExpression":
        return "any";
      case "indexAccess":
        return "any";
      default:
        return "any";
    }
  }

  private resolveType(vt: VariableType): VariableType {
    if (vt.type === "typeAliasVariable") {
      const resolved = this.typeAliases[vt.aliasName];
      if (resolved) return this.resolveType(resolved);
      return vt; // Unresolved, error already reported
    }
    return vt;
  }

  isAssignable(
    source: VariableType | "any",
    target: VariableType | "any",
  ): boolean {
    if (source === "any" || target === "any") return true;

    const resolvedSource = this.resolveType(source);
    const resolvedTarget = this.resolveType(target);

    // Union type as target: source must be assignable to at least one member
    if (resolvedTarget.type === "unionType") {
      return resolvedTarget.types.some((t) =>
        this.isAssignable(resolvedSource, t),
      );
    }

    // Union type as source: every member must be assignable to target
    if (resolvedSource.type === "unionType") {
      return resolvedSource.types.every((t) =>
        this.isAssignable(t, resolvedTarget),
      );
    }

    // Literal types assignable to their base primitives
    if (resolvedTarget.type === "primitiveType") {
      if (
        resolvedSource.type === "stringLiteralType" &&
        resolvedTarget.value === "string"
      )
        return true;
      if (
        resolvedSource.type === "numberLiteralType" &&
        resolvedTarget.value === "number"
      )
        return true;
      if (
        resolvedSource.type === "booleanLiteralType" &&
        resolvedTarget.value === "boolean"
      )
        return true;
    }

    // Same kind matching
    if (
      resolvedSource.type === "primitiveType" &&
      resolvedTarget.type === "primitiveType"
    ) {
      return resolvedSource.value === resolvedTarget.value;
    }

    if (
      resolvedSource.type === "stringLiteralType" &&
      resolvedTarget.type === "stringLiteralType"
    ) {
      return resolvedSource.value === resolvedTarget.value;
    }

    if (
      resolvedSource.type === "numberLiteralType" &&
      resolvedTarget.type === "numberLiteralType"
    ) {
      return resolvedSource.value === resolvedTarget.value;
    }

    if (
      resolvedSource.type === "booleanLiteralType" &&
      resolvedTarget.type === "booleanLiteralType"
    ) {
      return resolvedSource.value === resolvedTarget.value;
    }

    if (
      resolvedSource.type === "arrayType" &&
      resolvedTarget.type === "arrayType"
    ) {
      return this.isAssignable(
        resolvedSource.elementType,
        resolvedTarget.elementType,
      );
    }

    if (
      resolvedSource.type === "objectType" &&
      resolvedTarget.type === "objectType"
    ) {
      // Structural: source must have all properties of target with compatible types
      for (const targetProp of resolvedTarget.properties) {
        const sourceProp = resolvedSource.properties.find(
          (p) => p.key === targetProp.key,
        );
        if (!sourceProp) return false;
        if (!this.isAssignable(sourceProp.value, targetProp.value))
          return false;
      }
      return true;
    }

    return false;
  }
}

export function typeCheck(
  program: AgencyProgram,
  config: AgencyConfig = {},
): TypeCheckResult {
  const checker = new TypeChecker(program, config);
  return checker.check();
}

export function formatErrors(errors: TypeCheckError[]): string {
  return errors
    .map((err) => {
      return `${color.red("error")}: ${err.message}`;
    })
    .join("\n");
}
