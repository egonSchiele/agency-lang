import { nativeTypeReplacer, nativeTypeReviver } from "./revivers/index.js";

export type ClassRegistry = Record<string, { fromJSON: (data: any) => any }>;

/**
 * Create a JSON reviver that reconstructs Agency class instances.
 * Objects with a `__class` field are looked up in the registry and
 * reconstructed via `fromJSON()`. JSON revivers process bottom-up,
 * so nested instances are handled correctly.
 */
export function createClassReviver(classRegistry: ClassRegistry) {
  return function reviver(_key: string, value: any): any {
    if (value && typeof value === "object" && "__class" in value) {
      const cls = classRegistry[value.__class];
      if (cls) return cls.fromJSON(value);
    }
    return value;
  };
}

/**
 * Revive class instances in a pre-parsed object.
 * Re-serializes and re-parses with the class reviver.
 */
export function reviveWithClasses<T>(data: T, classRegistry: ClassRegistry): T {
  const hasClasses = Object.keys(classRegistry).length > 0;
  if (!hasClasses) {
    return JSON.parse(JSON.stringify(data, nativeTypeReplacer), nativeTypeReviver);
  }
  const classReviver = createClassReviver(classRegistry);
  return JSON.parse(JSON.stringify(data, nativeTypeReplacer), (key, value) => {
    const revived = nativeTypeReviver(key, value);
    return classReviver(key, revived);
  });
}
