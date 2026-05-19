import type { AgencyNode } from "../../types.js";
import type {
  ClassDefinition,
  ClassField,
  ClassMethod,
} from "../../types/classDefinition.js";
import type { FunctionParameter } from "../../types/function.js";
import type { TsNode, TsParam } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";
import { printTs } from "../../ir/prettyPrint.js";
import { formatTypeHintTs } from "../../utils/formatType.js";
import * as renderClassDefinition from "../../templates/backends/typescriptGenerator/classDefinition.js";
import type { ScopeManager } from "./scopeManager.js";

/**
 * Callbacks ClassEmitter needs from the parent TypeScriptBuilder.
 *
 * Class lowering reuses the same body / function-body machinery that the
 * builder already drives for free-standing functions, so we accept those
 * routines as dependencies rather than holding a reference to the whole
 * builder.
 */
export type ClassEmitterDeps = {
  scopes: ScopeManager;
  classDefinitions: Record<string, ClassDefinition>;
  moduleId: string;
  enterScope: (scopeName: string) => void;
  hoistBodyTypeAliases: (body: AgencyNode[]) => TsNode[];
  processBodyAsParts: (body: AgencyNode[]) => TsNode[];
  buildFunctionBody: (opts: {
    functionName: string;
    parameters: FunctionParameter[];
    bodyCode: TsNode[];
    hoistedAliases: TsNode[];
  }) => TsNode[];
};

/**
 * Lowers Agency `class` definitions into the generated TypeScript class
 * via the `classDefinition` mustache template.
 *
 * Responsible for:
 *   - walking the inheritance chain to collect all fields
 *   - lowering each method body (scope push/pop, hoisted aliases,
 *     `safe` flag, runner step assembly) into a stringified async method
 *   - feeding the template the per-class data it needs
 *     (constructor params, super args, field declarations, methods)
 *
 * Public API:
 *   - {@link emit} — turn a `ClassDefinition` AST node into a `TsNode`
 */
export class ClassEmitter {
  constructor(private deps: ClassEmitterDeps) {}

  /** Lower a class definition to its `ts.raw` template output. */
  emit(node: ClassDefinition): TsNode {
    const { className, fields, methods, parentClass } = node;
    const allFields = this.collectAllFields(node);
    const classKey = `${this.deps.moduleId}::${className}`;

    return ts.raw(renderClassDefinition.default({
      className,
      parentClassName: parentClass || "",
      hasParent: !!parentClass,
      classKey,
      fields: fields.map((f) => ({ name: f.name, typeStr: formatTypeHintTs(f.typeHint) })),
      allFields: allFields.map((f) => ({ name: f.name })),
      constructorParamsStr: allFields.map((f) => `${f.name}: ${formatTypeHintTs(f.typeHint)}`).join(", "),
      superArgsStr: parentClass
        ? this.collectAllFields(this.deps.classDefinitions[parentClass]).map((f) => f.name).join(", ")
        : "",
      methods: methods.map((m) => this.buildMethodCode(m, className)),
    }));
  }

  /**
   * Collect all fields for a class, walking the inheritance chain.
   * Returns parent fields first, then own fields.
   */
  private collectAllFields(node: ClassDefinition): ClassField[] {
    const allFields: ClassField[] = [];
    if (node.parentClass) {
      const parent = this.deps.classDefinitions[node.parentClass];
      if (parent) {
        allFields.push(...this.collectAllFields(parent));
      }
    }
    allFields.push(...node.fields);
    return allFields;
  }

  /**
   * Lower one method into its stringified form, reusing the same
   * function-body machinery the builder uses for top-level functions.
   */
  private buildMethodCode(method: ClassMethod, className: string): string {
    const methodScopeName = `${className}.${method.name}`;
    this.deps.scopes.push({ type: "function", functionName: methodScopeName });
    this.deps.enterScope(methodScopeName);
    const prevSafe = this.deps.scopes.inSafeFunction;
    this.deps.scopes.inSafeFunction = !!method.safe;
    // Hoist body-local type aliases to the method's outer scope.
    const hoistedAliases = this.deps.hoistBodyTypeAliases(method.body);
    const bodyCode = this.deps.processBodyAsParts(method.body);
    this.deps.scopes.inSafeFunction = prevSafe;
    this.deps.scopes.pop();

    // Reuse the same function body logic as processFunctionDefinition
    const setupStmts = this.deps.buildFunctionBody({
      functionName: methodScopeName,
      parameters: method.parameters,
      bodyCode,
      hoistedAliases,
    });

    // Build as an async method with __state as last param
    const fnParams: TsParam[] = method.parameters.map((p) => {
      const baseType = p.typeHint ? formatTypeHintTs(p.typeHint) : "any";
      return { name: p.name, typeAnnotation: baseType };
    });
    fnParams.push({
      name: "__state",
      typeAnnotation: "any",
      defaultValue: ts.id("undefined"),
    });

    // Use printTs on the IR body, then wrap as a method
    const bodyStr = printTs(ts.statements(setupStmts), 2);
    const paramStr = fnParams
      .map((p) => p.defaultValue
        ? `${p.name}: ${p.typeAnnotation} = ${printTs(p.defaultValue, 0)}`
        : `${p.name}: ${p.typeAnnotation}`)
      .join(", ");
    return `  async ${method.name}(${paramStr}) {\n${bodyStr}\n  }`;
  }
}
