/**
 * Stage 1 of the workflow generator: a JSON value becomes a typed
 * `Workflow`, or the list of every shape problem in it. This stage knows
 * only shape. Whether a tool exists or a reference points backwards is
 * resolve's job.
 */
import { isReservedInternalName } from "../../reservedNames.js";
import { isIdentifier, isObject, REF_PATH, refsIn, type Problem, type Workflow } from "./types.js";

export type ParseResult =
  { workflow: Workflow; problems: [] } | { workflow: null; problems: Problem[] };

type Json = Record<string, unknown>;
type Rule = (value: Json) => Problem[];
type StepRule = (step: Json, owner: string | null) => Problem[];

const LIMIT_FIELDS = ["maxCost", "maxTime"];

function problem(step: string | null, field: string | null, message: string): Problem {
  return { step, field, message };
}

/** The message for a name that is not an identifier, or null when it is one. */
function nameMessage(label: string, text: unknown): string | null {
  if (typeof text !== "string") {
    return `${label} must be a string`;
  }
  if (isReservedInternalName(text)) {
    return `${label} "${text}" is reserved: names that start with two underscores belong to the compiler`;
  }
  return isIdentifier(text) ? null : `${label} "${text}" is not an identifier`;
}

function nameProblems(step: string | null, field: string, label: string, text: unknown): Problem[] {
  const message = nameMessage(label, text);
  return message === null ? [] : [problem(step, field, message)];
}

function stepsOf(value: Json): Json[] {
  return Array.isArray(value.steps) ? value.steps.filter(isObject) : [];
}

function ownerOf(step: Json): string | null {
  return typeof step.id === "string" ? step.id : null;
}

function refShapeProblems(step: string | null, field: string, value: Json): Problem[] {
  if (Object.keys(value).length !== 1) {
    return [problem(step, field, "a reference must have exactly one key, $ref")];
  }
  const path = value.$ref;
  const root = typeof path === "string" ? path.split(/[.[]/)[1] : "";
  if (typeof path === "string" && REF_PATH.test(path) && isIdentifier(root)) {
    return [];
  }
  return [problem(step, field, `reference ${JSON.stringify(path)} is not a well-formed path`)];
}

/** Keys that cannot be written into the program. An object holding a
 *  reference is built from its keys as names, so they must be identifiers;
 *  any other object is lifted whole, which refuses only `__proto__`. */
function keyProblems(step: string | null, field: string, value: Json): Problem[] {
  const holdsRef = refsIn(value).length > 0;
  return Object.keys(value).flatMap((key) => {
    if (key === "__proto__") {
      return [problem(step, field, 'an object may not have the key "__proto__"')];
    }
    if (holdsRef && !isIdentifier(key)) {
      const message = `key "${key}" is not an identifier; an object that holds a reference needs identifier keys`;
      return [problem(step, field, message)];
    }
    return [];
  });
}

/** Problems with a value written into the program, all reported on `field`:
 *  a malformed reference, a key that cannot be written, or a number with no
 *  literal. */
function valueProblems(step: string | null, field: string, value: unknown): Problem[] {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return [problem(step, field, `${value} cannot be written as a number literal`)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => valueProblems(step, field, item));
  }
  if (!isObject(value)) {
    return [];
  }
  if ("$ref" in value) {
    return refShapeProblems(step, field, value);
  }
  const nested = Object.values(value).flatMap((item) => valueProblems(step, field, item));
  return [...keyProblems(step, field, value), ...nested];
}

/** The property names an `inputs` type declares, nested ones included.
 *  String literal types are removed first so a colon inside one is not read
 *  as a property. */
export function inputNames(text: string): string[] {
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const matches = withoutStrings.matchAll(/([^\s{},;:?|&()<>[\]]+)\s*\??\s*:/g);
  return [...matches].map((match) => match[1]);
}

const formatRule: Rule = (value) =>
  value.format === 1
    ? []
    : [problem(null, "format", `format must be 1, got ${JSON.stringify(value.format)}`)];

const nameRule: Rule = (value) => nameProblems(null, "name", "name", value.name);

const descriptionRule: Rule = (value) =>
  typeof value.description === "string"
    ? []
    : [problem(null, "description", "description must be a string")];

const inputsRule: Rule = (value) => {
  if (typeof value.inputs !== "string") {
    return [problem(null, "inputs", "inputs must be a string holding an object type")];
  }
  return inputNames(value.inputs).flatMap((name) =>
    nameProblems(null, "inputs", "input name", name),
  );
};

const stepsRule: Rule = (value) => {
  if (!Array.isArray(value.steps)) {
    return [problem(null, "steps", "steps must be a list")];
  }
  if (value.steps.length === 0) {
    return [problem(null, "steps", "steps must hold at least one step")];
  }
  return value.steps.flatMap((step, index) =>
    isObject(step) ? [] : [problem(null, `steps[${index}]`, `step ${index + 1} must be an object`)],
  );
};

const duplicateIdRule: Rule = (value) => {
  const ids = stepsOf(value).map(ownerOf);
  return ids.flatMap((id, index) =>
    id !== null && ids.indexOf(id) < index
      ? [problem(id, "id", `step id "${id}" is used by an earlier step`)]
      : [],
  );
};

const idRule: StepRule = (step, owner) => nameProblems(owner, "id", "step id", step.id);

const toolStepRule: StepRule = (step, owner) => {
  const moduleProblems =
    typeof step.module === "string" ? [] : [problem(owner, "module", "module must be a string")];
  const toolProblems = nameProblems(owner, "tool", "tool name", step.tool);
  if (!isObject(step.args)) {
    return [...moduleProblems, ...toolProblems, problem(owner, "args", "args must be an object")];
  }
  const args = Object.entries(step.args);
  const argNameProblems = args.flatMap(([name]) =>
    nameProblems(owner, `args.${name}`, "argument name", name),
  );
  const argRefProblems = args.flatMap(([name, arg]) => valueProblems(owner, `args.${name}`, arg));
  return [...moduleProblems, ...toolProblems, ...argNameProblems, ...argRefProblems];
};

function optionalString(step: Json, owner: string | null, field: string): Problem[] {
  return step[field] == null || typeof step[field] === "string"
    ? []
    : [problem(owner, field, `${field} must be a string`)];
}

const llmStepRule: StepRule = (step, owner) => {
  const promptProblems =
    typeof step.prompt === "string" && step.prompt !== ""
      ? []
      : [problem(owner, "prompt", "prompt must be a non-empty string")];
  const contextProblems = Array.isArray(step.context)
    ? step.context.flatMap((item, index) => valueProblems(owner, `context[${index}]`, item))
    : [problem(owner, "context", "context must be a list")];
  const outputProblems =
    typeof step.output === "string"
      ? []
      : [problem(owner, "output", "output must be a string holding a type")];
  return [
    ...promptProblems,
    ...contextProblems,
    ...outputProblems,
    ...optionalString(step, owner, "model"),
    ...optionalString(step, owner, "provider"),
  ];
};

const KIND_RULES: Record<string, StepRule> = { tool: toolStepRule, llm: llmStepRule };

const kindRule: StepRule = (step, owner) => {
  const kindRuleFor = typeof step.kind === "string" ? KIND_RULES[step.kind] : undefined;
  if (kindRuleFor === undefined) {
    return [
      problem(owner, "kind", `kind must be "tool" or "llm", got ${JSON.stringify(step.kind)}`),
    ];
  }
  return kindRuleFor(step, owner);
};

const STEP_RULES: StepRule[] = [idRule, kindRule];

const eachStepRule: Rule = (value) =>
  stepsOf(value).flatMap((step) => STEP_RULES.flatMap((rule) => rule(step, ownerOf(step))));

const resultRule: Rule = (value) => valueProblems(null, "result", value.result);

const limitsRule: Rule = (value) => {
  if (value.limits == null) {
    return [];
  }
  if (!isObject(value.limits)) {
    return [problem(null, "limits", "limits must be an object")];
  }
  return Object.entries(value.limits).flatMap(([key, limit]) => {
    if (!LIMIT_FIELDS.includes(key)) {
      return [
        problem(
          null,
          `limits.${key}`,
          `limits has no field "${key}"; it takes maxCost and maxTime`,
        ),
      ];
    }
    // Limits are written into the guard line as text, so only a finite number may pass.
    return typeof limit === "number" && Number.isFinite(limit)
      ? []
      : [problem(null, `limits.${key}`, `limits.${key} must be a finite number`)];
  });
};

const RULES: Rule[] = [
  formatRule,
  nameRule,
  descriptionRule,
  inputsRule,
  stepsRule,
  eachStepRule,
  duplicateIdRule,
  resultRule,
  limitsRule,
];

export function parseWorkflow(value: unknown): ParseResult {
  if (!isObject(value)) {
    return { workflow: null, problems: [problem(null, null, "a workflow must be a JSON object")] };
  }
  const problems = RULES.flatMap((rule) => rule(value));
  if (problems.length > 0) {
    return { workflow: null, problems };
  }
  return { workflow: value as Workflow, problems: [] };
}
