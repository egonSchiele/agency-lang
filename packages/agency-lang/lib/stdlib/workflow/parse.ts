/**
 * Stage 1 of the workflow generator: a JSON value becomes a typed
 * `Workflow`, or the list of every shape problem in it. The shape is a zod
 * schema; the rules zod cannot say (a name is an identifier, a reference
 * path is well formed, type text parses) are refinements on it. Whether a
 * tool exists or a reference points backwards is resolve's job.
 */
import { z } from "zod";
import { isReservedInternalName } from "../../reservedNames.js";
import { MAX_TIME, PLAIN_DECIMAL } from "./limits.js";
import { parseTypeText } from "./typeText.js";
import {
  EFFECT_NAME,
  isIdentifier,
  isObject,
  isRef,
  locatedSteps,
  REF_PATH,
  refsIn,
  type CaseValue,
  type Located,
  type Problem,
  type Ref,
  type Step,
  type Workflow,
} from "./types.js";

export type ParseResult =
  { workflow: Workflow; problems: [] } | { workflow: null; problems: Problem[] };

type Issue = { path: PropertyKey[]; message: string };

const LIMIT_FIELDS = ["maxCost", "maxTime"];

/** The message for a name that is not an identifier, or null when it is one. */
function nameMessage(label: string, text: string): string | null {
  if (isReservedInternalName(text)) {
    return `${label} "${text}" is reserved: names that start with two underscores belong to the compiler`;
  }
  return isIdentifier(text) ? null : `${label} "${text}" is not an identifier`;
}

/** The rule parse gives a workflow's `name`, for `loadWorkflow`, which
 *  takes a name from its caller and builds a file name from it. Null for
 *  an identifier; otherwise parse's message, so `../x` is refused before
 *  anything is read. */
export function _workflowNameProblem(name: string): string | null {
  return nameMessage("name", name);
}

function identifier(label: string) {
  return z.string({ error: `${label} must be a string` }).superRefine((text, ctx) => {
    const message = nameMessage(label, text);
    if (message !== null) {
      ctx.addIssue({ code: "custom", message });
    }
  });
}

function refMessages(value: Record<string, unknown>): string[] {
  if (Object.keys(value).length !== 1) {
    return ["a reference must have exactly one key, $ref"];
  }
  const path = value.$ref;
  const root = typeof path === "string" ? path.split(/[.[]/)[1] : "";
  if (typeof path === "string" && REF_PATH.test(path) && isIdentifier(root)) {
    return [];
  }
  return [`reference ${JSON.stringify(path)} is not a well-formed path`];
}

/** Keys that cannot be written into the program. An object holding a
 *  reference is built from its keys as names, so they must be identifiers;
 *  any other object is lifted whole, which refuses only `__proto__`. */
function keyMessages(value: Record<string, unknown>): string[] {
  const holdsRef = refsIn(value).length > 0;
  return Object.keys(value).flatMap((key) => {
    if (key === "__proto__") {
      return ['an object may not have the key "__proto__"'];
    }
    if (holdsRef && !isIdentifier(key)) {
      return [
        `key "${key}" is not an identifier; an object that holds a reference needs identifier keys`,
      ];
    }
    return [];
  });
}

/** Everything wrong with a value written into the program: a malformed
 *  reference, a key that cannot be written, or a number with no literal. */
function valueMessages(value: unknown): string[] {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return [`${value} cannot be written as a number literal`];
  }
  if (Array.isArray(value)) {
    return value.flatMap(valueMessages);
  }
  if (!isObject(value)) {
    return [];
  }
  if ("$ref" in value) {
    return refMessages(value);
  }
  return [...keyMessages(value), ...Object.values(value).flatMap(valueMessages)];
}

const value = z.unknown().superRefine((item, ctx) => {
  for (const message of valueMessages(item)) {
    ctx.addIssue({ code: "custom", message });
  }
});

/** Type text must parse as the declaration render will write; an `inputs`
 *  type must be an object whose top-level names are identifiers. */
function typeText(name: string, field: string, missing: string) {
  return z.string({ error: missing }).superRefine((text, ctx) => {
    const parsed = parseTypeText(name, text, field);
    if ("message" in parsed) {
      ctx.addIssue({ code: "custom", message: parsed.message });
      return;
    }
    if (parsed.alias.aliasedType.type !== "objectType") {
      return;
    }
    for (const property of parsed.alias.aliasedType.properties) {
      const message = nameMessage("input name", property.key);
      if (message !== null) {
        ctx.addIssue({ code: "custom", message });
      }
    }
  });
}

/** Argument names are written into the call line, so each is an identifier. */
const args = z
  .custom<Record<string, unknown>>(isObject, { error: "args must be an object" })
  .superRefine((record, ctx) => {
    for (const [name, item] of Object.entries(record)) {
      const messages = [nameMessage("argument name", name), ...valueMessages(item)];
      for (const message of messages) {
        if (message !== null) {
          ctx.addIssue({ code: "custom", message, path: [name] });
        }
      }
    }
  });

/** A limit is written into a guard line as text, and a guard reads a
 *  negative number as "no limit", so only a positive finite number passes. */
const positive = z.number().refine((limit) => Number.isFinite(limit) && limit > 0);

/** The message for one limit field, or null when it is acceptable. */
function limitMessage(key: string, limit: unknown): string | null {
  if (!LIMIT_FIELDS.includes(key)) {
    return `limits has no field "${key}"; it takes maxCost and maxTime`;
  }
  if (!positive.safeParse(limit).success) {
    return `limits.${key} must be a positive number`;
  }
  if (!PLAIN_DECIMAL.test(String(limit))) {
    return `limits.${key} must be a number the program can write as a plain decimal such as 0.5; ${String(limit)} is not one`;
  }
  if (key === "maxTime" && (limit as number) > MAX_TIME) {
    return `limits.maxTime must be at most ${MAX_TIME} (one hour less 30 seconds)`;
  }
  return null;
}

/** The same rules for the workflow's limits and a step's. */
const limits = z
  .record(z.string(), z.unknown(), { error: "limits must be an object" })
  .superRefine((record, ctx) => {
    for (const [key, limit] of Object.entries(record)) {
      const message = limitMessage(key, limit);
      if (message !== null) {
        ctx.addIssue({ code: "custom", message, path: [key] });
      }
    }
  })
  .nullish();

const toolStep = z.object({
  id: identifier("step id"),
  kind: z.literal("tool"),
  module: z.string({ error: "module must be a string" }),
  tool: identifier("tool name"),
  args,
  limits,
});

const PROMPT_MESSAGE = "prompt must be a non-empty string";

const llmStep = z.object({
  id: identifier("step id"),
  kind: z.literal("llm"),
  prompt: z.string({ error: PROMPT_MESSAGE }).min(1, { error: PROMPT_MESSAGE }),
  context: z.array(value, { error: "context must be a list" }),
  output: typeText("Output", "output", "output must be a string holding a type"),
  model: z.string({ error: "model must be a string" }).nullish(),
  provider: z.string({ error: "provider must be a string" }).nullish(),
  limits,
});

/** `on` and `over`: a reference whose path is well formed, and nothing else. */
function reference(message: string) {
  return z.custom<Ref>((item) => isObject(item) && isRef(item) && refMessages(item).length === 0, {
    error: message,
  });
}

const IS_MESSAGE = "is must be a string, a number, or true or false";

/** A case's value: what `==` can compare with a literal written into the program. */
const caseValue = z.custom<CaseValue>(
  (item) =>
    typeof item === "string" ||
    typeof item === "boolean" ||
    (typeof item === "number" && Number.isFinite(item)),
  { error: IS_MESSAGE },
);

/** A block names `limits` only to refuse it: zod drops a key it does not name. */
function noLimits(kind: string) {
  const message = `${kind} step takes no limits; set limits on the steps inside it`;
  return z.never({ error: message }).optional();
}

/** A step list inside a block. The schema is recursive through it. */
function nestedSteps() {
  return z.array(
    z.lazy(() => step),
    { error: "steps must be a list" },
  );
}

const CASES_MESSAGE = "cases must hold at least one case";

const matchCase = z.object({ is: caseValue, steps: nestedSteps() });

/** Two cases are the same when their values are `===`: `1` and `"1"` differ. */
const cases = z
  .array(matchCase, { error: CASES_MESSAGE })
  .min(1, { error: CASES_MESSAGE })
  .superRefine((list, ctx) => {
    list.forEach((item, index) => {
      if (list.findIndex((other) => other.is === item.is) < index) {
        const message = `case ${JSON.stringify(item.is)} is already handled by an earlier case`;
        ctx.addIssue({ code: "custom", message, path: [index, "is"] });
      }
    });
  });

const matchStep = z.object({
  id: identifier("step id"),
  kind: z.literal("match"),
  on: reference('on must be a reference, such as { "$ref": "steps.triage.level" }'),
  cases,
  otherwise: nestedSteps().nullish(),
  limits: noLimits("a match"),
});

const eachStep = z.object({
  id: identifier("step id"),
  kind: z.literal("each"),
  over: reference('over must be a reference to a list, such as { "$ref": "steps.search" }'),
  steps: nestedSteps().min(1, { error: "steps must hold at least one step" }),
  limits: noLimits("an each"),
});

const step: z.ZodType<Step> = z.discriminatedUnion(
  "kind",
  [toolStep, llmStep, matchStep, eachStep],
  {
    error: (issue) =>
      isObject(issue.input)
        ? `kind must be "tool", "llm", "match", or "each", got ${JSON.stringify(issue.input.kind)}`
        : "a step must be an object",
  },
);

const steps = z
  .array(step, { error: "steps must be a list" })
  .min(1, { error: "steps must hold at least one step" });

/** A step id is unique across the whole tree, so every generated name and
 *  guard label stays unique. Reported on the later step. */
function duplicateIdIssues(located: Located[]): Issue[] {
  const ids = located.map((entry) => entry.step.id);
  return located.flatMap((entry, index) =>
    ids.indexOf(entry.step.id) < index
      ? [
          {
            path: [...entry.path, "id"],
            message: `step id "${String(entry.step.id)}" is used by an earlier step`,
          },
        ]
      : [],
  );
}

/** A step's limit can trip only if the workflow's own limit does not trip
 *  first, so it may be no larger. A step `maxTime` also needs a workflow
 *  `maxTime`, which sets the subprocess wall clock; with no workflow
 *  `maxCost`, nothing else caps cost. The message, or null when the step's
 *  limit can trip. */
function stepLimitMessage(key: string, stepLimit: number, workflowLimit: unknown): string | null {
  if (typeof workflowLimit !== "number") {
    return key === "maxTime"
      ? `limits.maxTime needs the workflow to set a maxTime of at least ${stepLimit}; the subprocess wall clock comes from the workflow's maxTime`
      : null;
  }
  if (stepLimit > workflowLimit) {
    return `limits.${key} (${stepLimit}) is more than the workflow's ${key} (${workflowLimit}), so the workflow's guard would trip first`;
  }
  return null;
}

/** The messages for a `raises` value: one per wrong entry, or one for a
 *  value that is not a list. A missing or null `raises` allows anything. */
function raisesMessages(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [`raises must be a list of effect names, got ${JSON.stringify(value)}`];
  }
  return value.flatMap((entry, index) =>
    entry === "*" || (typeof entry === "string" && EFFECT_NAME.test(entry))
      ? []
      : [`raises[${index}] must be an effect name or "*", got ${JSON.stringify(entry)}`],
  );
}

const raises = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const message of raisesMessages(value)) {
      ctx.addIssue({ code: "custom", message });
    }
  })
  .transform((value) => value as string[] | null | undefined)
  .optional();

const workflow = z
  .object({
    format: z.literal(1, {
      error: (issue) => `format must be 1, got ${JSON.stringify(issue.input)}`,
    }),
    name: identifier("name"),
    description: z.string({ error: "description must be a string" }),
    inputs: typeText("Inputs", "inputs", "inputs must be a string holding an object type"),
    steps,
    result: value.optional(),
    limits,
    raises,
  })
  .superRefine((parsed, ctx) => {
    const located = locatedSteps(parsed);
    const issues = [...duplicateIdIssues(located), ...stepLimitIssues(located, parsed.limits)];
    for (const { path, message } of issues) {
      ctx.addIssue({ code: "custom", message, path });
    }
  });

/** Every step's limits, nested or not, checked against the workflow's. */
function stepLimitIssues(
  located: Located[],
  workflowLimits: Record<string, unknown> | null | undefined,
): Issue[] {
  return located.flatMap(({ step: item, path }) => {
    const limits = isObject(item.limits) ? item.limits : {};
    return LIMIT_FIELDS.flatMap((key) => {
      const stepLimit = limits[key];
      if (typeof stepLimit !== "number") {
        return [];
      }
      const message = stepLimitMessage(key, stepLimit, workflowLimits?.[key]);
      return message === null ? [] : [{ path: [...path, "limits", key], message }];
    });
  });
}

function startsWith(path: PropertyKey[], prefix: PropertyKey[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/** The located step whose path is the longest prefix of `path`, among those `keep` accepts. */
function innermost(
  located: Located[],
  path: PropertyKey[],
  keep: (entry: Located) => boolean,
): Located | null {
  return located
    .filter((entry) => keep(entry) && startsWith(path, entry.path))
    .reduce<Located | null>(
      (best, entry) => (best === null || entry.path.length > best.path.length ? entry : best),
      null,
    );
}

/** A problem's place from an issue's path. It belongs to the innermost
 *  step with an id that holds the path, and its field is the rest of the
 *  path. An issue on the step itself is named by the step's place in its
 *  list: `steps[3]`, or `cases[0].steps[1]` inside a block. Anything that
 *  is in no step belongs to the workflow. */
function problemAt(raw: Record<string, unknown>, issue: Issue): Problem {
  const located = locatedSteps(raw);
  const owner = innermost(located, issue.path, (entry) => typeof entry.step.id === "string");
  if (owner === null) {
    return { step: null, field: placeOrField(located, issue.path), message: issue.message };
  }
  const rest = issue.path.slice(owner.path.length);
  const field = rest.length === 0 ? placeOrField(located, owner.path) : fieldText(rest);
  return { step: owner.step.id as string, field, message: issue.message };
}

/** A path as a field, read from the innermost step that strictly holds it. */
function placeOrField(located: Located[], path: PropertyKey[]): string {
  const holder = innermost(located, path, (entry) => entry.path.length < path.length);
  return fieldText(holder === null ? path : path.slice(holder.path.length));
}

/** `args.query`, `context[0]`, `limits.maxCost`. */
function fieldText(path: PropertyKey[]): string {
  return path.reduce<string>((text, segment) => {
    if (typeof segment === "number") {
      return `${text}[${segment}]`;
    }
    return text === "" ? String(segment) : `${text}.${String(segment)}`;
  }, "");
}

export function parseWorkflow(raw: unknown): ParseResult {
  if (!isObject(raw)) {
    return {
      workflow: null,
      problems: [{ step: null, field: null, message: "a workflow must be a JSON object" }],
    };
  }
  const result = workflow.safeParse(raw);
  if (!result.success) {
    return { workflow: null, problems: result.error.issues.map((issue) => problemAt(raw, issue)) };
  }
  const parsed: Workflow = result.data;
  return { workflow: parsed, problems: [] };
}
