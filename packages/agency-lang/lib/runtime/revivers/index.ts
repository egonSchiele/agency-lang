import { BaseReviver } from "./baseReviver.js";
import { SetReviver } from "./setReviver.js";
import { MapReviver } from "./mapReviver.js";
import { DateReviver } from "./dateReviver.js";
import { RegExpReviver } from "./regExpReviver.js";
import { URLReviver } from "./urlReviver.js";
import { ErrorReviver } from "./errorReviver.js";
import { FunctionRefReviver } from "./functionRefReviver.js";

export const functionRefReviver = new FunctionRefReviver();

const revivers: BaseReviver<any>[] = [
  new SetReviver(),
  new MapReviver(),
  new DateReviver(),
  new RegExpReviver(),
  new URLReviver(),
  new ErrorReviver(),
  functionRefReviver,
];

const reviversByName: Record<string, BaseReviver<any>> = {};
for (const r of revivers) {
  reviversByName[r.nativeTypeName()] = r;
}

// Must be a regular function (not arrow) so `this` is the parent object.
// When value is a primitive but this[key] is an object, it means toJSON()
// was called (Date, URL). Fall back to this[key] to get the raw value.
export function nativeTypeReplacer(this: any, key: string, value: unknown): unknown {
  let raw: unknown;
  if (typeof value === "object" && value !== null) {
    raw = value;
  } else {
    // Primitives: fall back to this[key] to handle toJSON() conversion (Date, URL)
    raw = key === "" ? value : this[key];
  }
  if (raw === null) return value;
  if (typeof raw !== "object") return value;
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
