import { BaseReviver } from "./baseReviver.js";

export class SetReviver implements BaseReviver<Set<unknown>> {
  nativeTypeName(): string {
    return "Set";
  }

  isInstance(value: unknown): value is Set<unknown> {
    return value instanceof Set;
  }

  serialize(value: Set<unknown>): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), values: Array.from(value) };
  }

  validate(value: Record<string, unknown>): boolean {
    return Array.isArray(value.values);
  }

  revive(value: Record<string, unknown>): Set<unknown> {
    return new Set(value.values as unknown[]);
  }
}
