import { BaseReviver } from "./baseReviver.js";
import {
  isPlainObjectOrArray,
  attachTag,
  readTag,
} from "../state/tagSymbol.js";

// Preserves a plain object's / array's durable tag (a non-enumerable TAG_SYMBOL
// property) across the shared JSON round-trip. Plain objects/arrays match no
// other reviver, so registration order is irrelevant.
export class TaggedReviver implements BaseReviver<object> {
  nativeTypeName(): string {
    return "Tagged";
  }

  isInstance(value: unknown): value is object {
    // Cheap symbol read first, then confirm it's a plain object/array.
    return readTag(value) !== undefined && isPlainObjectOrArray(value);
  }

  serialize(value: object): Record<string, unknown> {
    // Spread drops the non-enumerable symbol, so `v` is tag-free and recursing
    // into it can't re-match this reviver (no loop). Nested natives and nested
    // tagged values inside `v` recurse normally.
    const v = Array.isArray(value) ? [...value] : { ...value };
    return { __nativeType: this.nativeTypeName(), tags: readTag(value), v };
  }

  validate(value: Record<string, unknown>): boolean {
    return "tags" in value && "v" in value;
  }

  revive(value: Record<string, unknown>): object {
    // `v` is already revived (JSON.parse revivers run bottom-up). attachTag
    // re-hides the tag and restores the null prototype the round-trip stripped.
    const target = value.v as object;
    attachTag(target, value.tags as Record<string, unknown>);
    return target;
  }
}
