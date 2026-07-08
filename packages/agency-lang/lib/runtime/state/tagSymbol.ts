// Module-private key for durable object tags. Stored non-enumerable, so it is
// invisible to Object.keys / for-in / spread / JSON.stringify (symbol keys are
// always dropped by JSON). Reachable only via this symbol. Lives in its own
// dependency-free module so globalStore.ts and the TaggedReviver can share it
// without an import cycle.
export const TAG_SYMBOL: unique symbol = Symbol("agencyTags");

export function isPlainObjectOrArray(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// A value can hold a *durable* on-object tag only if it's a plain object/array
// and still extensible (a frozen/sealed object can't take a new property).
export function canHoldDurableTag(value: unknown): boolean {
  return isPlainObjectOrArray(value) && Object.isExtensible(value as object);
}

// Attach the tag record as a non-enumerable Symbol property. Forces the record
// null-proto so a user/LLM-controlled "__proto__" tag key is plain data (the
// same invariant GlobalStore establishes on creation and must survive revive).
export function attachTag(
  target: object,
  tags: Record<string, unknown>,
): void {
  Object.setPrototypeOf(tags, null);
  Object.defineProperty(target, TAG_SYMBOL, {
    value: tags,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

// Remove the tag property from a target that can still afford it: our
// property is defined configurable, and only freeze/seal flips that — both of
// which also make the object non-extensible, so isExtensible is a safe proxy
// for "delete won't throw". Returns false when the caller must fall back to
// clearing the record's keys in place.
export function detachTag(target: object): boolean {
  if (!Object.isExtensible(target)) return false;
  delete (target as Record<symbol, unknown>)[TAG_SYMBOL];
  return true;
}

export function readTag(value: unknown): Record<string, unknown> | undefined {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  return (value as Record<symbol, Record<string, unknown> | undefined>)[
    TAG_SYMBOL
  ];
}
