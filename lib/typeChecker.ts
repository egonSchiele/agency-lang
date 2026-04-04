import { color } from "@/utils/termcolors.js";
import type { ProgramInfo } from "./programInfo.js";
import { GLOBAL_SCOPE_KEY, getVisibleTypes, scopeKey, collectProgramInfo } from "./programInfo.js";
import { AgencyConfig } from "./config.js";
import {
  AgencyNode,
  AgencyProgram,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
  TypeAlias,
  Assignment,
  FunctionCall,
  ReturnStatement,
  ValueAccess,
  AccessChainElement,
  functionScope,
  nodeScope,
} from "./types.js";
import { getImportedNames } from "./types/importStatement.js";
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
  scopeKey: string;
  returnType?: VariableType | null;
};

type BuiltinSignature = {
  params: (VariableType | "any")[];
  returnType: VariableType | "any";
};

const BUILTIN_FUNCTION_TYPES: Record<string, BuiltinSignature> = {
  print: {
    params: ["any"],
    returnType: { type: "primitiveType", value: "void" },
  },
  printJSON: {
    params: ["any"],
    returnType: { type: "primitiveType", value: "void" },
  },
  input: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  read: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  readImage: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  write: {
    params: [
      { type: "primitiveType", value: "string" },
      { type: "primitiveType", value: "string" },
    ],
    returnType: { type: "primitiveType", value: "void" },
  },
  fetch: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: { type: "primitiveType", value: "string" },
  },
  fetchJSON: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: "any",
  },
  fetchJson: {
    params: [{ type: "primitiveType", value: "string" }],
    returnType: "any",
  },
  sleep: {
    params: [{ type: "primitiveType", value: "number" }],
    returnType: { type: "primitiveType", value: "void" },
  },
  round: {
    params: [{ type: "primitiveType", value: "number" }],
    returnType: { type: "primitiveType", value: "number" },
  },
  llm: {
    params: ["any"],
    returnType: { type: "primitiveType", value: "string" },
  },
};

export class TypeChecker {
  private program: AgencyProgram;
  private config: AgencyConfig;
  private scopedTypeAliases: Record<string, Record<string, VariableType>> = {};
  private currentScopeKey: string = GLOBAL_SCOPE_KEY;
  private functionDefs: Record<string, FunctionDefinition> = {};
  private nodeDefs: Record<string, GraphNodeDefinition> = {};
  private errors: TypeCheckError[] = [];
  private inferredReturnTypes: Record<string, VariableType | "any"> = {};
  private inferringReturnType = new Set<string>();

  constructor(program: AgencyProgram, config: AgencyConfig = {}, info?: ProgramInfo) {
    this.program = program;
    this.config = config;
    const resolved = info ?? collectProgramInfo(program);
    this.scopedTypeAliases = Object.fromEntries(
      Object.entries(resolved.typeAliases).map(([k, v]) => [k, { ...v }]),
    );
    this.functionDefs = { ...resolved.functionDefinitions };
    this.nodeDefs = Object.fromEntries(
      resolved.graphNodes.map((n) => [n.nodeName, n]),
    );
  }

  /** Get the flat map of type aliases visible in the current scope. */
  private get typeAliases(): Record<string, VariableType> {
    return getVisibleTypes(this.scopedTypeAliases, this.currentScopeKey);
  }

  /** Run a callback with currentScopeKey set, restoring it afterwards. */
  private withScope<T>(key: string, fn: () => T): T {
    const prev = this.currentScopeKey;
    this.currentScopeKey = key;
    try {
      return fn();
    } finally {
      this.currentScopeKey = prev;
    }
  }

  check(): TypeCheckResult {
    this.errors = [];
    // Validate that type aliases don't reference unknown aliases
    for (const [sk, scopeAliases] of Object.entries(this.scopedTypeAliases)) {
      this.withScope(sk, () => {
        for (const [name, aliasedType] of Object.entries(scopeAliases)) {
          this.validateTypeReferences(aliasedType, name);
        }
      });
    }
    this.inferReturnTypes();
    this.checkScopes();
    return { errors: this.deduplicateErrors() };
  }

  private deduplicateErrors(): TypeCheckError[] {
    const seen = new Set<string>();
    return this.errors.filter((err) => {
      const key = err.message;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

  private inferReturnTypes(): void {
    const allDefs: (FunctionDefinition | GraphNodeDefinition)[] = [
      ...Object.values(this.functionDefs),
      ...Object.values(this.nodeDefs),
    ];

    for (const def of allDefs) {
      if (def.returnType) continue; // explicit return type, skip inference

      const name = def.type === "function" ? def.functionName : def.nodeName;
      this.inferReturnTypeFor(name, def);
    }
  }

  private inferReturnTypeFor(
    name: string,
    def: FunctionDefinition | GraphNodeDefinition,
  ): VariableType | "any" {
    // Already inferred
    if (name in this.inferredReturnTypes) {
      return this.inferredReturnTypes[name];
    }

    // Recursion guard
    if (this.inferringReturnType.has(name)) {
      return "any";
    }

    this.inferringReturnType.add(name);

    const defScopeKey = def.type === "function"
      ? scopeKey(functionScope(def.functionName))
      : scopeKey(nodeScope(def.nodeName));

    return this.withScope(defScopeKey, () => {
      // Build scope variable types
      const vars: Record<string, VariableType | "any"> = {};
      for (const param of def.parameters) {
        vars[param.name] = param.typeHint ?? "any";
      }
      this.collectVariableTypes(def.body, vars, name);

      // Collect return statements from the body, filtering out returns inside nested functions/nodes
      const returnValues: AgencyNode[] = [];
      for (const { node, ancestors } of walkNodes(def.body)) {
        if (node.type === "returnStatement") {
          // Skip returns inside nested function or graphNode definitions
          const insideNested = ancestors.some(
            (a) => a.type === "function" || a.type === "graphNode",
          );
          if (!insideNested) {
            returnValues.push(node.value);
          }
        }
      }

      let inferred: VariableType | "any";
      if (returnValues.length === 0) {
        inferred = { type: "primitiveType", value: "void" };
      } else {
        const types = returnValues.map((v) => this.synthType(v, vars));
        if (types.some((t) => t === "any")) {
          inferred = "any";
        } else {
          const first = types[0] as VariableType;
          const allSame = types.every(
            (t) =>
              t !== "any" &&
              this.isAssignable(t, first) &&
              this.isAssignable(first, t),
          );
          inferred = allSame ? first : "any";
        }
      }

      this.inferredReturnTypes[name] = this.widenType(inferred);
      this.inferringReturnType.delete(name);
      return this.inferredReturnTypes[name];
    });
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
      scopeKey: GLOBAL_SCOPE_KEY,
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
        scopeKey: scopeKey(functionScope(fn.functionName)),
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
        scopeKey: scopeKey(nodeScope(node.nodeName)),
        returnType: node.returnType,
      });
    }

    // Now check function calls, return types, and expressions within each scope
    for (const scope of scopes) {
      this.withScope(scope.scopeKey, () => {
        this.checkFunctionCallsInScope(scope);
        if (scope.returnType !== undefined) {
          this.checkReturnTypesInScope(scope);
        }
        this.checkExpressionsInScope(scope);
      });
    }
  }

  private collectVariableTypes(
    nodes: AgencyNode[],
    vars: Record<string, VariableType | "any">,
    scopeName: string,
  ): void {
    for (const node of nodes) {
      if (node.type === "assignment") {
        const existingType = vars[node.variableName];
        const newType = node.typeHint;

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
          // Check that the assigned value is compatible with the annotation
          this.checkType(
            node.value,
            newType,
            vars,
            `assignment to '${node.variableName}'`,
          );
          vars[node.variableName] = newType;
        } else if (existingType) {
          // Variable being reassigned without a new type annotation
          // Check if the value's inferred type is compatible
          const valueType = this.synthType(node.value, vars);
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
          // No type annotation anywhere — infer from the value
          if (this.config.strictTypes) {
            this.errors.push({
              message: `Variable '${node.variableName}' has no type annotation (strict mode).`,
              variableName: node.variableName,
            });
          }
          const inferred = this.synthType(node.value, vars);
          vars[node.variableName] = this.widenType(inferred);
        }
      } else if (node.type === "importStatement") {
        for (const importName of node.importedNames) {
          for (const name of getImportedNames(importName)) {
            vars[name] = "any";
          }
        }
      } else if (node.type === "forLoop") {
        // Infer item variable type from the iterable's array element type
        const iterableType = this.synthType(node.iterable, vars);
        if (iterableType !== "any" && iterableType.type === "arrayType") {
          vars[node.itemVar] = iterableType.elementType;
        } else {
          vars[node.itemVar] = "any";
        }
        if (node.indexVar) {
          vars[node.indexVar] = { type: "primitiveType", value: "number" };
        }
        this.collectVariableTypes(node.body, vars, scopeName);
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
    // Check builtins using their type signatures
    if (call.functionName in BUILTIN_FUNCTION_TYPES) {
      const sig = BUILTIN_FUNCTION_TYPES[call.functionName];

      // Arity check
      if (call.arguments.length !== sig.params.length) {
        this.errors.push({
          message: `Expected ${sig.params.length} argument(s) for '${call.functionName}', but got ${call.arguments.length}.`,
        });
        return;
      }

      // Type check each argument
      for (let i = 0; i < call.arguments.length; i++) {
        const argType = this.synthType(call.arguments[i], scopeVars);
        const paramType = sig.params[i];
        if (paramType === "any") continue;
        if (argType === "any") continue;

        if (!this.isAssignable(argType, paramType)) {
          this.errors.push({
            message: `Argument type '${formatTypeHint(argType)}' is not assignable to parameter type '${formatTypeHint(paramType)}' in call to '${call.functionName}'.`,
            expectedType: formatTypeHint(paramType),
            actualType: formatTypeHint(argType),
          });
        }
      }
      return;
    }

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
      const argType = this.synthType(call.arguments[i], scopeVars);
      const paramType = params[i].typeHint;
      if (!paramType) continue; // No type hint on param, skip
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
        this.checkType(
          node.value,
          scope.returnType,
          scope.variableTypes,
          `return in '${scope.name}'`,
        );
      }
    }
  }

  /**
   * Walk all expressions in a scope and synthesize their types to trigger
   * validation errors (e.g., property access on non-object types).
   */
  private checkExpressionsInScope(scope: ScopeInfo): void {
    for (const { node } of walkNodes(scope.body)) {
      if (node.type === "valueAccess") {
        this.synthType(node, scope.variableTypes);
      } else if (node.type === "returnStatement") {
        // Always synth the return value to validate sub-expressions,
        // even when the function has no declared return type
        this.synthType(node.value, scope.variableTypes);
      }
    }
  }

  /**
   * Check mode (top-down): verify that an expression is compatible with expectedType.
   * Prompts are skipped since they adopt the expected type for structured output.
   */
  private checkType(
    expr: AgencyNode,
    expectedType: VariableType,
    scopeVars: Record<string, VariableType | "any">,
    context: string,
  ): void {
    // llm() calls adopt the expected type — skip checking
    if (expr.type === "functionCall" && expr.functionName === "llm") return;

    const actualType = this.synthType(expr, scopeVars);
    if (actualType === "any") return;

    if (!this.isAssignable(actualType, expectedType)) {
      this.errors.push({
        message: `Type '${formatTypeHint(actualType)}' is not assignable to type '${formatTypeHint(expectedType)}' (${context}).`,
        expectedType: formatTypeHint(expectedType),
        actualType: formatTypeHint(actualType),
      });
    }
  }

  /**
   * Synth mode (bottom-up): infer the type of an expression from its structure.
   */
  private synthType(
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
      case "string": {
        // Plain string literal (single text segment, no interpolation) → literal type
        if (expr.segments.length === 1 && expr.segments[0].type === "text") {
          return { type: "stringLiteralType", value: expr.segments[0].value };
        }
        return { type: "primitiveType", value: "string" };
      }
      case "multiLineString":
        return { type: "primitiveType", value: "string" };
      case "boolean":
        return { type: "primitiveType", value: "boolean" };
      case "binOpExpression": {
        const op = expr.operator;
        if (
          op === "==" ||
          op === "!=" ||
          op === "<" ||
          op === ">" ||
          op === "<=" ||
          op === ">=" ||
          op === "&&" ||
          op === "||"
        ) {
          return { type: "primitiveType", value: "boolean" };
        }
        // Arithmetic operators: +, -, *, /, +=, -=, *=, /=
        if (op === "+") {
          // Special case: + with a string operand → string
          const leftType = this.synthType(expr.left, scopeVars);
          const rightType = this.synthType(expr.right, scopeVars);
          const isString = (t: VariableType | "any") =>
            t !== "any" &&
            ((t.type === "primitiveType" && t.value === "string") ||
              t.type === "stringLiteralType");
          if (isString(leftType) || isString(rightType)) {
            return { type: "primitiveType", value: "string" };
          }
        }
        return { type: "primitiveType", value: "number" };
      }
      case "functionCall": {
        // Check builtins first
        if (expr.functionName in BUILTIN_FUNCTION_TYPES) {
          return BUILTIN_FUNCTION_TYPES[expr.functionName].returnType;
        }
        const fn = this.functionDefs[expr.functionName];
        const graphNode = this.nodeDefs[expr.functionName];
        const def = fn ?? graphNode;
        if (def?.returnType) return def.returnType;
        if (expr.functionName in this.inferredReturnTypes) {
          return this.inferredReturnTypes[expr.functionName];
        }
        // Lazily trigger inference if we're in the inference phase
        if (def && !def.returnType && this.inferringReturnType.size > 0) {
          return this.inferReturnTypeFor(expr.functionName, def);
        }
        return "any";
      }
      case "agencyArray": {
        if (expr.items.length === 0)
          return {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "any" },
          };
        // Synth each item; if all share a type, return that array type
        const itemTypes: (VariableType | "any")[] = [];
        for (const item of expr.items) {
          if (item.type === "splat") {
            // Can't easily infer splat element types
            return "any";
          }
          itemTypes.push(this.synthType(item, scopeVars));
        }
        // Check if all non-any types are the same primitive
        const concreteTypes = itemTypes.filter((t) => t !== "any");
        if (concreteTypes.length === 0) return "any";
        const first = concreteTypes[0];
        const allSame = concreteTypes.every(
          (t) => this.isAssignable(t, first) && this.isAssignable(first, t),
        );
        if (allSame) {
          return { type: "arrayType", elementType: first };
        }
        return "any";
      }
      case "agencyObject": {
        const properties: { key: string; value: VariableType }[] = [];
        for (const entry of expr.entries) {
          if ("type" in entry && entry.type === "splat") {
            // Can't easily infer splat properties
            return "any";
          }
          const kv = entry as { key: string; value: AgencyNode };
          const valueType = this.synthType(kv.value, scopeVars);
          if (valueType === "any") {
            return "any";
          }
          properties.push({ key: kv.key, value: valueType });
        }
        return { type: "objectType", properties };
      }
      case "valueAccess":
        return this.synthValueAccess(expr, scopeVars);
      default:
        return "any";
    }
  }

  /**
   * Walk the access chain on a ValueAccess node to resolve its type.
   */
  private synthValueAccess(
    expr: ValueAccess,
    scopeVars: Record<string, VariableType | "any">,
  ): VariableType | "any" {
    let currentType = this.synthType(expr.base, scopeVars);

    for (const element of expr.chain) {
      if (currentType === "any") return "any";
      const resolved = this.resolveType(currentType);
      // primitiveType("any") behaves like the "any" sentinel for access chains
      if (resolved.type === "primitiveType" && resolved.value === "any") return "any";

      switch (element.kind) {
        case "property": {
          if (resolved.type === "unionType") {
            // Collect property types from all union members that have this property
            const propTypes: VariableType[] = [];
            for (const member of resolved.types) {
              const resolvedMember = this.resolveType(member);
              if (resolvedMember.type === "objectType") {
                const prop = resolvedMember.properties.find(
                  (p) => p.key === element.name,
                );
                if (prop) propTypes.push(prop.value);
              }
            }
            if (propTypes.length > 0) {
              if (propTypes.length === 1) {
                currentType = propTypes[0];
              } else {
                currentType = { type: "unionType", types: propTypes };
              }
            } else {
              this.errors.push({
                message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
              });
              return "any";
            }
          } else if (resolved.type === "objectType") {
            const prop = resolved.properties.find(
              (p) => p.key === element.name,
            );
            if (prop) {
              currentType = prop.value;
            } else {
              this.errors.push({
                message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
              });
              return "any";
            }
          } else if (
            resolved.type === "arrayType" &&
            element.name === "length"
          ) {
            currentType = { type: "primitiveType", value: "number" };
          } else {
            this.errors.push({
              message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
            });
            return "any";
          }
          break;
        }
        case "index": {
          if (resolved.type === "arrayType") {
            currentType = resolved.elementType;
          } else {
            return "any";
          }
          break;
        }
        case "methodCall": {
          // Method calls return any
          return "any";
        }
      }
    }

    return currentType;
  }

  /**
   * Widen literal types to their base primitives.
   * Used when inferring types for untyped variables so that reassignment works.
   */
  private widenType(vt: VariableType | "any"): VariableType | "any" {
    if (vt === "any") return "any";
    switch (vt.type) {
      case "stringLiteralType":
        return { type: "primitiveType", value: "string" };
      case "numberLiteralType":
        return { type: "primitiveType", value: "number" };
      case "booleanLiteralType":
        return { type: "primitiveType", value: "boolean" };
      case "objectType":
        return {
          type: "objectType",
          properties: vt.properties.map((p) => ({
            key: p.key,
            value: this.widenType(p.value) as VariableType,
          })),
        };
      case "arrayType":
        return {
          type: "arrayType",
          elementType: this.widenType(vt.elementType) as VariableType,
        };
      case "unionType":
        return {
          type: "unionType",
          types: vt.types.map((t) => this.widenType(t) as VariableType),
        };
      default:
        return vt;
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

    // primitiveType("any") behaves the same as the "any" sentinel
    if (
      (resolvedSource.type === "primitiveType" && resolvedSource.value === "any") ||
      (resolvedTarget.type === "primitiveType" && resolvedTarget.value === "any")
    ) {
      return true;
    }

    // unknown as target: anything can be assigned to unknown
    if (resolvedTarget.type === "primitiveType" && resolvedTarget.value === "unknown") {
      return true;
    }

    // unknown as source: only assignable to any (handled above) or unknown
    if (resolvedSource.type === "primitiveType" && resolvedSource.value === "unknown") {
      return false;
    }

    // Union type as source: every member must be assignable to target
    // (checked first so that union-to-union works: each source member is tested
    // against the full target union via the "union as target" rule below)
    if (resolvedSource.type === "unionType") {
      return resolvedSource.types.every((t) =>
        this.isAssignable(t, resolvedTarget),
      );
    }

    // Union type as target: source must be assignable to at least one member
    if (resolvedTarget.type === "unionType") {
      return resolvedTarget.types.some((t) =>
        this.isAssignable(resolvedSource, t),
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
  info?: ProgramInfo,
): TypeCheckResult {
  const checker = new TypeChecker(program, config, info);
  return checker.check();
}

export function formatErrors(
  errors: TypeCheckError[],
  errorType: "warning" | "error" = "error",
): string {
  return errors
    .map((err) => {
      const colorFunc = errorType === "warning" ? color.yellow : color.red;
      return `${colorFunc(errorType)}: ${err.message}`;
    })
    .join("\n");
}
