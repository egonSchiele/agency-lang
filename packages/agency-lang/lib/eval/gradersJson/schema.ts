import * as path from "path";

import { z } from "zod";

/** The shape of `graders.json`: a list of graders in five kinds. See
 *  docs/dev/evals/graders-json.md. Each kind answers one question about a
 *  run; the fields every kind shares are `name`, `weight`, and `mustPass`. */

const shared = {
  name: z.string().min(1),
  weight: z.number().finite().nonnegative().optional(),
  mustPass: z.boolean().optional(),
};

const GoalSchema = z
  .object({
    ...shared,
    kind: z.literal("goal"),
    goal: z.string().min(1),
    passingScore: z.number().min(0).max(1).optional(),
  })
  .strict();

const ChecklistSchema = z
  .object({
    ...shared,
    kind: z.literal("checklist"),
    points: z.array(z.string().min(1)).min(1),
    context: z.string().min(1).optional(),
  })
  .strict();

export const MEASURES = ["llmCalls", "costUsd", "agentSeconds", "tokensIn", "tokensOut"] as const;

const NumberSchema = z
  .object({
    ...shared,
    kind: z.literal("number"),
    measure: z.enum(MEASURES),
    full: z.number().finite().optional(),
    zero: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();

export const COUNTS = ["toolCalls", "errors", "llmCalls"] as const;

const CountSchema = z
  .object({
    ...shared,
    kind: z.literal("count"),
    count: z.enum(COUNTS),
    tool: z.string().min(1).optional(),
    repeated: z.boolean().optional(),
    messageStartsWith: z.string().min(1).optional(),
    max: z.number().int().nonnegative(),
  })
  .strict();

const CommandSchema = z
  .object({
    ...shared,
    kind: z.literal("command"),
    command: z.string().min(1),
    timeoutSec: z.number().positive().optional(),
  })
  .strict();

export type GoalSpec = z.infer<typeof GoalSchema>;
export type ChecklistSpec = z.infer<typeof ChecklistSchema>;
export type NumberSpec = z.infer<typeof NumberSchema>;
export type CountSpec = z.infer<typeof CountSchema>;
export type CommandSpec = z.infer<typeof CommandSchema>;
export type GraderSpec = GoalSpec | ChecklistSpec | NumberSpec | CountSpec | CommandSpec;
export type GradersJson = GraderSpec[];

/** One schema per kind, looked up by the element's `kind` so an unknown
 *  kind is reported with its index and name. */
const KIND_SCHEMAS: Record<GraderSpec["kind"], z.ZodTypeAny> = {
  goal: GoalSchema,
  checklist: ChecklistSchema,
  number: NumberSchema,
  count: CountSchema,
  command: CommandSchema,
};

/** Rules that span more than one field. The first that applies is the error. */
type Rule = {
  applies: (spec: GraderSpec) => boolean;
  problem: string | ((spec: GraderSpec) => string);
};

const RULES: Rule[] = [
  {
    applies: (spec) =>
      spec.kind === "goal" && spec.mustPass === true && spec.passingScore === undefined,
    problem: "a must-pass goal grader needs passingScore",
  },
  {
    applies: (spec) =>
      spec.kind === "number" && spec.max !== undefined && (spec.full ?? spec.zero) !== undefined,
    problem: "a number grader has either full and zero or max, not both",
  },
  {
    applies: (spec) => spec.kind === "number" && !hasRange(spec) && spec.max === undefined,
    problem: "a number grader needs full and zero or max",
  },
  {
    applies: (spec) => spec.kind === "number" && spec.mustPass === true && spec.max === undefined,
    problem: "a must-pass number grader needs max",
  },
  {
    applies: (spec) => spec.kind === "number" && hasRange(spec) && spec.full === spec.zero,
    problem: "a number grader needs full and zero to differ",
  },
  {
    applies: (spec) =>
      spec.kind === "checklist" && spec.context !== undefined && !insideGraderFiles(spec.context),
    problem: (spec) =>
      `context must be a path inside graderFiles/, not ${spec.kind === "checklist" ? spec.context : ""}`,
  },
  {
    applies: (spec) =>
      spec.kind === "count" && spec.tool !== undefined && spec.count !== "toolCalls",
    problem: 'tool only applies to count "toolCalls"',
  },
  {
    applies: (spec) =>
      spec.kind === "count" && spec.repeated !== undefined && spec.count !== "toolCalls",
    problem: 'repeated only applies to count "toolCalls"',
  },
  {
    applies: (spec) =>
      spec.kind === "count" && spec.messageStartsWith !== undefined && spec.count !== "errors",
    problem: 'messageStartsWith only applies to count "errors"',
  },
];

function hasRange(spec: NumberSpec): boolean {
  return spec.full !== undefined && spec.zero !== undefined;
}

/** A context is read as `graderFiles/<context>`, so it must stay inside:
 *  relative, and never climbing out with `..`. */
function insideGraderFiles(context: string): boolean {
  if (path.isAbsolute(context)) {
    return false;
  }
  return !path.normalize(context).split(path.sep).includes("..");
}

/** Parse the text of a `graders.json`. Every problem is an `Error` naming
 *  the file, and where it applies the grader's index and name. */
export function parseGradersJson(text: string, filePath: string): GradersJson {
  const list = parseList(text, filePath);
  const specs = list.map((element, index) => parseSpec(element, index, filePath));
  const duplicate = firstDuplicateName(specs);
  if (duplicate !== undefined) {
    throw new Error(`${filePath}: two graders named "${duplicate}"`);
  }
  return specs;
}

function parseList(text: string, filePath: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${filePath}: must be a JSON list of graders`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath}: must be a JSON list of graders`);
  }
  return parsed;
}

/** One grader's first problem, as data: the field it is about (the first
 *  segment of a zod path, `kind` for a missing or unknown kind or a
 *  non-object element) or `null` for a rule that spans fields, and the
 *  message without the file and index prefix. The `eval new` form reads
 *  this to put its cursor on the right row. */
export type GraderProblem = { field: string | null; text: string };

export type CheckedSpec = { spec: GraderSpec } | { problem: GraderProblem };

/** Parse one element of a `graders.json` list, answering with either the
 *  spec or its first problem. The element is parsed once. */
export function checkSpec(element: unknown): CheckedSpec {
  if (typeof element !== "object" || element === null || Array.isArray(element)) {
    return { problem: { field: "kind", text: "must be an object with a kind" } };
  }
  const kind = (element as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.hasOwn(KIND_SCHEMAS, kind)) {
    return { problem: { field: "kind", text: `unknown kind ${JSON.stringify(kind)}` } };
  }
  const result = KIND_SCHEMAS[kind as GraderSpec["kind"]].safeParse(element);
  if (!result.success) {
    const issue = result.error.issues[0];
    // An unrecognized key has an empty path; it is about the object, so it
    // lands with the kind.
    const field = issue.path.length === 0 ? "kind" : String(issue.path[0]);
    return { problem: { field, text: `${issue.path.join(".")}: ${issue.message}` } };
  }
  const spec = result.data as GraderSpec;
  const broken = RULES.find((rule) => rule.applies(spec));
  if (broken !== undefined) {
    const text = typeof broken.problem === "string" ? broken.problem : broken.problem(spec);
    return { problem: { field: null, text } };
  }
  return { spec };
}

export function graderProblem(element: unknown): GraderProblem | null {
  const checked = checkSpec(element);
  return "problem" in checked ? checked.problem : null;
}

function parseSpec(element: unknown, index: number, filePath: string): GraderSpec {
  const checked = checkSpec(element);
  if ("spec" in checked) {
    return checked.spec;
  }
  const where = `${filePath}: grader ${index}`;
  if (checked.problem.field !== null) {
    throw new Error(`${where}: ${checked.problem.text}`);
  }
  const name = (element as { name: string }).name;
  throw new Error(`${where} (${name}): ${checked.problem.text}`);
}

function firstDuplicateName(specs: GraderSpec[]): string | undefined {
  const names = specs.map((spec) => spec.name);
  return names.find((name, index) => names.indexOf(name) !== index);
}
