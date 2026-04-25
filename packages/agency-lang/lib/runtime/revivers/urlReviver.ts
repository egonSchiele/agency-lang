import { BaseReviver } from "./baseReviver.js";

export class URLReviver implements BaseReviver<URL> {
  nativeTypeName(): string {
    return "URL";
  }

  isInstance(value: unknown): value is URL {
    return value instanceof URL;
  }

  serialize(value: URL): Record<string, unknown> {
    return { __nativeType: this.nativeTypeName(), href: value.href };
  }

  validate(value: Record<string, unknown>): boolean {
    return typeof value.href === "string";
  }

  revive(value: Record<string, unknown>): URL {
    return new URL(value.href as string);
  }
}
