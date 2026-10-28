import { variableNameParser } from "../../parsers/parsers.js";
import { isReservedInternalName } from "../../reservedNames.js";

/** One thing wrong with a workflow. `step` and `field` are null only for a
 *  problem that belongs to the whole workflow. */
export type Problem = { step: string | null; field: string | null; message: string };

export type Ref = { $ref: string };

export type ToolStep = {
  id: string;
  kind: "tool";
  module: string;
  tool: string;
  args: Record<string, unknown>;
};
export type LlmStep = {
  id: string;
  kind: "llm";
  prompt: string;
  context: unknown[];
  output: string;
  model?: string;
  provider?: string;
};
export type Step = ToolStep | LlmStep;
export type Limits = { maxCost?: number; maxTime?: number };
export type Workflow = {
  format: 1;
  name: string;
  description: string;
  inputs: string;
  steps: Step[];
  result?: unknown;
  limits?: Limits;
};

/** A tool the host passed, as an import line spells it: `module` is
 *  `std::<name>`, `pkg::<name>`, or `./<path>` relative to the workflow's
 *  directory. */
export type ToolRef = { module: string; name: string };

/** A reference path: a root, a name, then `.field` and `[n]` segments. */
export const REF_PATH =
  /^(inputs|steps)\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/;

/** Exactly `{ "$ref": "<string>" }`. Any other object is a plain value. */
export function isRef(value: unknown): value is Ref {
  if (!isObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "$ref" && typeof (value as Ref).$ref === "string";
}

/** A name the parser accepts as a variable name. Reserved `__` names are
 *  refused here, before the parser would throw on them. */
export function isIdentifier(text: string): boolean {
  if (isReservedInternalName(text)) {
    return false;
  }
  const result = variableNameParser(text);
  return result.success && result.rest === "";
}

/** Every reference nested anywhere in a value, in document order. */
export function refsIn(value: unknown): Ref[] {
  if (isRef(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(refsIn);
  }
  if (isObject(value)) {
    return Object.values(value).flatMap(refsIn);
  }
  return [];
}

/** A JSON object: not null and not an array. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
