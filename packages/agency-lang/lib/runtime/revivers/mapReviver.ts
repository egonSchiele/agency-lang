import { BaseReviver } from "./baseReviver.js";

export class MapReviver implements BaseReviver<Map<unknown, unknown>> {
  nativeTypeName(): string {
    return "Map";
  }

  isInstance(value: unknown): value is Map<unknown, unknown> {
    return value instanceof Map;
  }

  serialize(value: Map<unknown, unknown>): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), entries: Array.from(value.entries()) };
  }

  validate(value: Record<string, unknown>): boolean {
    return Array.isArray(value.entries);
  }

  revive(value: Record<string, unknown>): Map<unknown, unknown> {
    return new Map(value.entries as [unknown, unknown][]);
  }
}
