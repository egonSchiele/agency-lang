import { BaseReviver } from "./baseReviver.js";

type FunctionWithRef = Function & {
  __functionRef?: { name: string; module: string };
};

type ToolRegistry = Record<string, { handler: { execute: Function } }>;

export class FunctionRefReviver implements BaseReviver<FunctionWithRef> {
  registry: ToolRegistry | null = null;

  nativeTypeName(): string {
    return "FunctionRef";
  }

  isInstance(value: unknown): value is FunctionWithRef {
    return typeof value === "function" && "__functionRef" in value;
  }

  serialize(value: FunctionWithRef): Record<string, unknown> {
    const ref = value.__functionRef!;
    return { __nativeType: this.nativeTypeName(), name: ref.name, module: ref.module };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }

  revive(value: Record<string, unknown>): Function {
    if (!this.registry) {
      throw new Error(
        `FunctionRefReviver: no registry set. Cannot revive function "${value.name}" from module "${value.module}".`
      );
    }
    const name = value.name as string;
    const module = value.module as string;

    // Fast path: direct lookup by name (works when registry key matches original name)
    const direct = this.registry[name];
    if (direct) {
      const fn = direct.handler.execute as FunctionWithRef;
      if (fn.__functionRef && fn.__functionRef.name === name && fn.__functionRef.module === module) {
        return fn;
      }
    }

    // Slow path: linear scan for aliased imports (registry key differs from original name)
    for (const [_key, entry] of Object.entries(this.registry)) {
      const fn = entry.handler.execute as FunctionWithRef;
      if (fn.__functionRef && fn.__functionRef.name === name && fn.__functionRef.module === module) {
        return fn;
      }
    }

    throw new Error(
      `FunctionRefReviver: function "${name}" from module "${module}" not found in registry. ` +
      `The function may have been renamed or removed since this state was serialized.`
    );
  }
}
