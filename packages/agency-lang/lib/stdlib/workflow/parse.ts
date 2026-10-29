/**
 * Stage 1 of the workflow generator: a JSON value becomes a typed
 * `Workflow`, or the list of every shape problem in it. The shape is a zod
 * schema; the rules zod cannot say (a name is an identifier, a reference
 * path is well formed, type text parses) are refinements on it. Whether a
 * tool exists or a reference points backwards is resolve's job.
 */
import { z } from "zod";
import { isReservedInternalName } from "../../reservedNames.js";
import { MAX_TIME } from "./limits.js";
import { parseTypeText } from "./typeText.js";
import { isIdentifier, isObject, REF_PATH, refsIn, type Problem, type Workflow } from "./types.js";

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

const step = z.discriminatedUnion("kind", [toolStep, llmStep], {
  error: (issue) =>
    isObject(issue.input)
      ? `kind must be "tool" or "llm", got ${JSON.stringify(issue.input.kind)}`
      : "a step must be an object",
});

const steps = z
  .array(step, { error: "steps must be a list" })
  .min(1, { error: "steps must hold at least one step" })
  .superRefine((list, ctx) => {
    const ids = list.map((item) => item.id);
    ids.forEach((id, index) => {
      if (ids.indexOf(id) < index) {
        const message = `step id "${id}" is used by an earlier step`;
        ctx.addIssue({ code: "custom", message, path: [index, "id"] });
      }
    });
  });

const workflow = z.object({
  format: z.literal(1, {
    error: (issue) => `format must be 1, got ${JSON.stringify(issue.input)}`,
  }),
  name: identifier("name"),
  description: z.string({ error: "description must be a string" }),
  inputs: typeText("Inputs", "inputs", "inputs must be a string holding an object type"),
  steps,
  result: value.optional(),
  limits,
});

/** A problem's place from an issue's path: `steps[i]...` belongs to that
 *  step, named by its id when it has one; anything else to the workflow. */
function problemAt(raw: Record<string, unknown>, issue: Issue): Problem {
  const [root, index, ...rest] = issue.path;
  if (root === "steps" && typeof index === "number") {
    const item = Array.isArray(raw.steps) ? raw.steps[index] : undefined;
    const id = isObject(item) && typeof item.id === "string" ? item.id : null;
    const field = rest.length === 0 ? `steps[${index}]` : fieldText(rest);
    return { step: id, field, message: issue.message };
  }
  return { step: null, field: fieldText(issue.path), message: issue.message };
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
