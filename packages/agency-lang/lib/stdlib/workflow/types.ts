import type { ExportParam } from "../agency.js";
import type { Code } from "../template.js";
import { variableNameParser } from "../../parsers/parsers.js";
import { isReservedInternalName } from "../../reservedNames.js";

/** One thing wrong with a workflow. `step` and `field` are null only for a
 *  problem that belongs to the whole workflow. */
export type Problem = { step: string | null; field: string | null; message: string };

export type Ref = { $ref: string };

export type Limits = { maxCost?: number; maxTime?: number };
/** `limits` reads null as absent. */
export type ToolStep = {
  id: string;
  kind: "tool";
  module: string;
  tool: string;
  args: Record<string, unknown>;
  limits?: Limits | null;
};
/** `model`, `provider`, and `limits` read null as absent. */
export type LlmStep = {
  id: string;
  kind: "llm";
  prompt: string;
  context: unknown[];
  output: string;
  model?: string | null;
  provider?: string | null;
  limits?: Limits | null;
};
export type Step = ToolStep | LlmStep;
/** `result` and `limits` read null as absent. */
export type Workflow = {
  format: 1;
  name: string;
  description: string;
  inputs: string;
  steps: Step[];
  result?: unknown;
  limits?: Limits | null;
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

/** How a tool's signature is keyed: by its module and its name. */
export function signatureKey(module: string, name: string): string {
  return `${module}.${name}`;
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

/** What `describe` says about one tool, keyed by `"<module>.<name>"`.
 *  `returnsResult` is resolved through the tool module's own aliases. */
export type Signature = {
  signature: string;
  returnType: string | null;
  returnsResult: boolean;
  docstring: string | null;
  /** What `describe` says about each parameter. */
  params: ExportParam[];
  /** What `describe` reports the tool can raise. */
  effects: string[];
};

/** A checked reference. `path` is the text after the root name, such as
 *  `[0].id`, `.body`, or the empty string. */
export type InputRef = { kind: "input"; name: string; path: string };
export type StepRef = { kind: "step"; step: string; path: string };
export type ResolvedRef = InputRef | StepRef;

/** A JSON value with no reference anywhere inside it. */
export type Literal = { kind: "literal"; value: unknown };
/** A list or an object with a reference somewhere inside it. */
export type ResolvedList = { kind: "list"; items: ResolvedValue[] };
export type ResolvedEntry = { key: string; value: ResolvedValue };
export type ResolvedRecord = { kind: "record"; entries: ResolvedEntry[] };
export type ResolvedValue = Literal | ResolvedRef | ResolvedList | ResolvedRecord;

/** One generated `const`: its name, the field it came from, and its value. */
export type Binding = { local: string; field: string; value: ResolvedValue };
/** A context value and `text`, the local that holds it as the model sees
 *  it: the string itself, or JSON for anything else. */
export type ContextBinding = Binding & { text: string };

/** `value` is the local that holds the step's value. `holdsResult` says
 *  that local holds a `Result`: the tool returns one, or the step has
 *  limits and so runs inside a guard, which always gives a `Result`. */
export type ResolvedToolStep = {
  id: string;
  kind: "tool";
  value: string;
  module: string;
  tool: string;
  holdsResult: boolean;
  limits: Limits | null;
  bindings: Binding[];
  argOrder: string[];
};

/** `outputType` is the type text as written, `typeName` the alias it is
 *  declared as, and `reply` the local inside the thread that holds the
 *  model's typed answer. */
export type ResolvedLlmStep = {
  id: string;
  kind: "llm";
  value: string;
  reply: string;
  holdsResult: boolean;
  limits: Limits | null;
  prompt: string;
  outputType: string;
  typeName: string;
  bindings: ContextBinding[];
  model: string | null;
  provider: string | null;
};
export type ResolvedStep = ResolvedToolStep | ResolvedLlmStep;

export type ImportGroup = { module: string; names: string[] };

export type ResolvedWorkflow = {
  name: string;
  inputsType: string;
  imports: ImportGroup[];
  steps: ResolvedStep[];
  result: ResolvedValue | null;
  limits: Limits | null;
  warnings: Problem[];
};

/** The step and field a generated statement belongs to. */
export type Owner = { step: string | null; field: string | null };
export type Fragment = { code: Code; owner: Owner | null };
/** A type the program declares. Its text is canonicalized in render. */
export type TypeDecl = { name: string; text: string; owner: Owner };
export type Lowered = {
  imports: string[];
  types: TypeDecl[];
  body: Fragment[];
  result: Code;
  guard: Limits | null;
};

/** Source lines `from` to `to` (1-based, inclusive) belong to `owner`. */
export type Range = { from: number; to: number; owner: Owner };
