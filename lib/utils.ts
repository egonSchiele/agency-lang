import { Message } from "smoltalk";

export function escape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

export function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function zip<T, U>(arr1: T[], arr2: U[]): Array<[T, U]> {
  const length = Math.min(arr1.length, arr2.length);
  const result: Array<[T, U]> = [];
  for (let i = 0; i < length; i++) {
    result.push([arr1[i], arr2[i]]);
  }
  return result;
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Simple object check.
 */
export function isObject(item: any): boolean {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Deep merge two objects.
 */
export function mergeDeep(
  _objA: Record<string, any>,
  _objB: Record<string, any>,
): Record<string, any> {
  const objA = structuredClone(_objA);
  const objB = structuredClone(_objB);

  if (isObject(objA) && isObject(objB)) {
    for (const key in objB) {
      // console.log("key", key);
      if (isObject(objB[key])) {
        // console.log("is object!");
        if (!objA[key]) {
          // console.log("initializing", key);
          Object.assign(objA, { [key]: {} });
        } else if (!isObject(objA[key])) {
          // console.log("overwriting non-object key", key, "with object");
          Object.assign(objA, { [key]: {} });
        }
        objA[key] = mergeDeep(objA[key], objB[key]);
      } else {
        // console.log("setting", key, "to", objB[key]);
        Object.assign(objA, { [key]: objB[key] });
      }
    }
  }

  return objA;
}
