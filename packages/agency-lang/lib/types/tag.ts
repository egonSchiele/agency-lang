import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

export type Tag = BaseNode & {
  type: "tag";
  name: string;
  arguments: Expression[];
};

/**
 * Recover a legacy string view of a tag argument for back-compat with
 * consumers that haven't been generalised to Expression[] yet.
 *
 * Returns null when the argument can't be represented as a plain string
 * (e.g. function calls, object literals, multi-segment interpolated strings).
 */
export function tagArgToLegacyString(arg: Expression): string | null {
  switch (arg.type) {
    case "string": {
      // Only support single-segment plain text strings.
      if (arg.segments.length === 1 && arg.segments[0].type === "text") {
        return arg.segments[0].value;
      }
      return null;
    }
    case "number":
      return arg.value;
    case "boolean":
      return String(arg.value);
    case "variableName":
      return arg.value;
    default:
      return null;
  }
}
