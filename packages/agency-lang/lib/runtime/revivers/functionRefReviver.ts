import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";
import type { FuncParam, ToolDefinition } from "../agencyFunction.js";

type FunctionRefRegistry = Record<string, AgencyFunction>;

export class FunctionRefReviver implements BaseReviver<AgencyFunction> {
  registry: FunctionRefRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is AgencyFunction {
    return AgencyFunction.isAgencyFunction(value);
  }

  serialize(value: AgencyFunction): Record<string, unknown> {
    const result: Record<string, unknown> = {
      __nativeType: this.nativeTypeName(),
      name: value.name,
      module: value.module,
    };
    // Serialize params with bound values inline
    if (value.params.some(p => p.isBound)) {
      result.params = value.params;
    }
    // Serialize full tool definition (may have reduced schema/description)
    if (value.toolDefinition) {
      result.toolDescription = value.toolDefinition.description;
    }
    return result;
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): AgencyFunction {
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${value.name}" from module "${value.module}".`
      );
    }
    const name = value.name as string;
    const module = value.module as string;

    const original = this.findInRegistry(name, module);

    // If serialized params have bound values, reconstruct the bound function
    if (Array.isArray(value.params) && value.params.some((p: any) => p.isBound)) {
      const params = value.params as FuncParam[];
      // Rebuild bindings from the serialized params
      const bindings: Record<string, unknown> = {};
      for (const p of params) {
        if (p.isBound) {
          bindings[p.name] = p.boundValue;
        }
      }
      let revived = original.partial(bindings);

      // Restore tool description if it was customized via .describe()
      if (typeof value.toolDescription === "string" && revived.toolDefinition) {
        revived = revived.withToolDefinition({
          ...revived.toolDefinition,
          description: value.toolDescription,
        });
      }
      return revived;
    }

    // Restore tool description for non-bound functions that used .describe()
    if (typeof value.toolDescription === "string" && original.toolDefinition &&
        value.toolDescription !== original.toolDefinition.description) {
      return original.withToolDefinition({
        ...original.toolDefinition,
        description: value.toolDescription,
      });
    }

    return original;
  }

  private findInRegistry(name: string, module: string): AgencyFunction {
    // Fast path: direct lookup by name
    const direct = this.registry![name];
    if (direct && direct.name === name && direct.module === module) {
      return direct;
    }

    // Slow path: linear scan for aliased imports
    for (const entry of Object.values(this.registry!)) {
      if (entry.name === name && entry.module === module) {
        return entry;
      }
    }

    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
  }
}
