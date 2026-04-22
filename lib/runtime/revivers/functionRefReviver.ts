import { BaseReviver } from "./baseReviver.js";
import { AgencyFunction } from "../agencyFunction.js";

// During the transition, the registry may contain either AgencyFunction instances
// (new path) or legacy { handler: { execute: Function } } entries (old path).
// This type handles both. Once the builder migration is complete, remove the legacy type.
type LegacyRegistryEntry = { handler: { execute: Function & { __functionRef?: { name: string; module: string } } } };
type RegistryEntry = AgencyFunction | LegacyRegistryEntry;
type FunctionRefRegistry = Record<string, RegistryEntry>;

function isAgencyFunctionEntry(entry: RegistryEntry): entry is AgencyFunction {
  return AgencyFunction.isAgencyFunction(entry);
}

function getEntryRef(entry: RegistryEntry): { name: string; module: string; value: any } | null {
  if (isAgencyFunctionEntry(entry)) {
    return { name: entry.name, module: entry.module, value: entry };
  }
  const fn = (entry as LegacyRegistryEntry).handler?.execute;
  if (fn && (fn as any).__functionRef) {
    const ref = (fn as any).__functionRef;
    return { name: ref.name, module: ref.module, value: fn };
  }
  return null;
}

type FunctionWithRef = Function & { __functionRef?: { name: string; module: string } };

export class FunctionRefReviver implements BaseReviver<AgencyFunction | FunctionWithRef> {
  registry: FunctionRefRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is AgencyFunction | FunctionWithRef {
    if (AgencyFunction.isAgencyFunction(value)) return true;
    // Legacy: bare function with __functionRef metadata
    if (typeof value === "function" && (value as any).__functionRef) {
      const ref = (value as any).__functionRef;
      return typeof ref.name === "string" && typeof ref.module === "string";
    }
    return false;
  }

  serialize(value: AgencyFunction | FunctionWithRef): Record<string, unknown> {
    if (AgencyFunction.isAgencyFunction(value)) {
      return { __nativeType: this.nativeTypeName(), name: value.name, module: value.module };
    }
    // Legacy path
    const ref = (value as FunctionWithRef).__functionRef!;
    return { __nativeType: this.nativeTypeName(), name: ref.name, module: ref.module };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): AgencyFunction | Function {
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${value.name}" from module "${value.module}".`
      );
    }
    const name = value.name as string;
    const module = value.module as string;

    // Fast path: direct lookup by name
    const direct = this.registry[name];
    if (direct) {
      const ref = getEntryRef(direct);
      if (ref && ref.name === name && ref.module === module) {
        return ref.value;
      }
    }

    // Slow path: linear scan for aliased imports
    for (const [_key, entry] of Object.entries(this.registry)) {
      const ref = getEntryRef(entry);
      if (ref && ref.name === name && ref.module === module) {
        return ref.value;
      }
    }

    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
  }
}
