import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";
import { lookupClosure, CLOSURE_SELF_SENTINEL } from "../closureRegistry.js";
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
    if (value.closureKey) {
      result.closureKey = value.closureKey;
      // Replace self-references with sentinel to avoid circular JSON
      if (value.closureData) {
        const sanitized: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value.closureData)) {
          sanitized[k] = v === value ? CLOSURE_SELF_SENTINEL : v;
        }
        result.closureData = sanitized;
      } else {
        result.closureData = null;
      }
      result.toolDefinition = value.toolDefinition;
      result.params = value.params;
    }
    return result;
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): AgencyFunction {
    const name = value.name as string;
    const module = value.module as string;

    // Closure function path
    if (value.closureKey) {
      const key = value.closureKey as string;
      const entry = lookupClosure(key);
      if (!entry) {
        throw new Error(
          `FunctionRefReviver: cannot revive closure function "${key}" — module not loaded.`
        );
      }
      const closureData = (value.closureData as Record<string, unknown>) ?? null;
      const fn = new AgencyFunction({
        name,
        module,
        fn: entry.fn,
        params: value.params as FuncParam[],
        toolDefinition: (value.toolDefinition as ToolDefinition | null) ?? null,
        closureData,
        closureKey: key,
      });
      // Replace __self__ sentinels for recursive inner functions
      if (fn.closureData) {
        for (const [k, v] of Object.entries(fn.closureData)) {
          if (v === CLOSURE_SELF_SENTINEL) {
            (fn.closureData as Record<string, unknown>)[k] = fn;
          }
        }
      }
      return fn;
    }

    // Regular function path (unchanged)
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${name}" from module "${module}".`
      );
    }

    // Fast path: direct lookup by name
    const direct = this.registry[name];
    if (direct && direct.name === name && direct.module === module) {
      return direct;
    }

    // Slow path: linear scan for aliased imports
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
