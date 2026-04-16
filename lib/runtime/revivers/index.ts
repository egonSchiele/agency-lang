import { BaseReviver } from "./baseReviver.js";
import { SetReviver } from "./setReviver.js";
import { MapReviver } from "./mapReviver.js";
import { DateReviver } from "./dateReviver.js";
import { RegExpReviver } from "./regExpReviver.js";
import { URLReviver } from "./urlReviver.js";
import { ErrorReviver } from "./errorReviver.js";

const revivers: BaseReviver<any>[] = [
  new SetReviver(),
  new MapReviver(),
  new DateReviver(),
  new RegExpReviver(),
  new URLReviver(),
  new ErrorReviver(),
];

const reviversByName: Record<string, BaseReviver<any>> = {};
for (const r of revivers) {
  reviversByName[r.nativeTypeName()] = r;
}

// Must be a regular function (not arrow) so `this` is the parent object.
// JSON.stringify calls toJSON() on Date/URL/etc before the replacer sees
// the value, so we check the raw value via this[key] instead.
export function nativeTypeReplacer(this: any, key: string, value: unknown): unknown {
  const raw = key === "" ? value : this[key];
  for (const r of revivers) {
    if (r.isInstance(raw)) {
      return r.serialize(raw);
    }
  }
  return value;
}

export function nativeTypeReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "__nativeType")
  ) {
    const v = value as Record<string, unknown>;
    const r = reviversByName[v.__nativeType as string];
    if (r && r.validate(v)) {
      return r.revive(v);
    }
  }
  return value;
}
