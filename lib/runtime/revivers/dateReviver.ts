import { BaseReviver } from "./baseReviver.js";

export class DateReviver implements BaseReviver<Date> {
  nativeTypeName(): string {
    return "Date";
  }

  isInstance(value: unknown): value is Date {
    return value instanceof Date;
  }

  serialize(value: Date): Record<string, unknown> {
    const time = value.getTime();
    return {
      __nativeType: this.nativeTypeName(),
      iso: Number.isNaN(time) ? null : value.toISOString(),
    };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.iso === "string" || value.iso === null;
  }

  revive(value: Record<string, unknown>): Date {
    return value.iso === null ? new Date(NaN) : new Date(value.iso as string);
  }
}
