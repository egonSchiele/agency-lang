import { BaseReviver } from "./baseReviver.js";

export class RegExpReviver implements BaseReviver<RegExp> {
  nativeTypeName(): string {
    return "RegExp";
  }

  isInstance(value: unknown): value is RegExp {
    return value instanceof RegExp;
  }

  serialize(value: RegExp): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), source: value.source, flags: value.flags };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.source === "string" && typeof value.flags === "string";
  }

  revive(value: Record<string, unknown>): RegExp {
    return new RegExp(value.source as string, value.flags as string);
  }
}
