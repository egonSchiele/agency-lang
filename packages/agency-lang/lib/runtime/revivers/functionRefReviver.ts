import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";

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
    if (value.boundArgs) {
      result.boundArgs = value.boundArgs;
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

    // Find the original function
    let original: AgencyFunction | undefined;

    // Fast path: direct lookup by name
    const direct = this.registry[name];
    if (direct && direct.name === name && direct.module === module) {
      original = direct;
    }

    // Slow path: linear scan for aliased imports
    if (!original) {
      for (const [_key, entry] of Object.entries(this.registry)) {
        if (entry.name === name && entry.module === module) {
          original = entry;
          break;
        }
      }
    }

    if (!original) {
      throw new Error(
        `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
        `The function may have been renamed or removed since this state was serialized.`
      );
    }

    // If boundArgs present, re-apply partial bindings
    if (value.boundArgs) {
      const boundArgs = value.boundArgs as any;
      const bindings: Record<string, unknown> = {};
      const originalParams = boundArgs.originalParams;
      for (let i = 0; i < boundArgs.indices.length; i++) {
        const paramIndex = boundArgs.indices[i];
        const paramName = originalParams[paramIndex].name;
        bindings[paramName] = boundArgs.values[i];
      }
      return original.partial(bindings);
    }

    return original;
  }
}
