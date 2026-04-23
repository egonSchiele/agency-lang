import { AgencyFunction } from "./agencyFunction.js";
import type { CallType } from "./agencyFunction.js";

export async function __call(
  target: unknown,
  descriptor: CallType,
  state?: unknown,
): Promise<unknown> {
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor, state);
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value: ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(
      `Named arguments are not supported for non-Agency function '${target.name || "(anonymous)"}'`,
    );
  }
  return target(...descriptor.args);
}

export async function __callMethod(
  obj: unknown,
  prop: string | number,
  descriptor: CallType,
  state?: unknown,
  optional?: boolean,
): Promise<unknown> {
  if (optional && (obj === null || obj === undefined)) {
    return undefined;
  }
  const target = (obj as any)[prop];
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor, state);
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value at property '${String(prop)}': ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(
      `Named arguments are not supported for non-Agency function '${String(prop)}'`,
    );
  }
  // Call as obj[prop](...) to preserve `this` binding
  return (obj as any)[prop](...descriptor.args);
}
