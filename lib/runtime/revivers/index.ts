import { BaseReviver } from "./baseReviver.js";
import { SetReviver } from "./setReviver.js";
import { MapReviver } from "./mapReviver.js";

const revivers: BaseReviver<any>[] = [
  new SetReviver(),
  new MapReviver(),
];

const reviversByName: Record<string, BaseReviver<any>> = {};
for (const r of revivers) {
  reviversByName[r.nativeTypeName()] = r;
}

export function nativeTypeReplacer(_key: string, value: unknown): unknown {
  for (const r of revivers) {
    if (r.isInstance(value)) {
      return r.serialize(value);
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
