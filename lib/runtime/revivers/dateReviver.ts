import { BaseReviver } from "./baseReviver.js";

export class DateReviver implements BaseReviver<Date> {
  nativeTypeName(): string {
    return "Date";
  }

  isInstance(value: unknown): value is Date {
    return value instanceof Date;
  }

  serialize(value: Date): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), iso: value.toISOString() };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.iso === "string";
  }

  revive(value: Record<string, unknown>): Date {
    return new Date(value.iso as string);
  }
}
