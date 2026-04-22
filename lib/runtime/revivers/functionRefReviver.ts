import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";

type AgencyFunctionRegistry = Record<string, AgencyFunction>;

export class FunctionRefReviver implements BaseReviver<AgencyFunction> {
  registry: AgencyFunctionRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is AgencyFunction {
    return AgencyFunction.isAgencyFunction(value);
  }

  serialize(value: AgencyFunction): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), name: value.name, module: value.module };
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

    // Fast path: direct lookup by name
    const direct = this.registry[name];
    if (direct && direct.name === name && direct.module === module) {
      return direct;
    }

    // Slow path: linear scan for aliased imports (registry key differs from original name)
    for (const [_key, entry] of Object.entries(this.registry)) {
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
