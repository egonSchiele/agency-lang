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

/** One schema per kind, looked up by the element's `kind`. A lookup, not a
 *  zod discriminated union, so an unknown kind is reported with its index
 *  and its name instead of "Invalid discriminator value". */
const KIND_SCHEMAS: Record<GraderSpec["kind"], z.ZodTypeAny> = {
  goal: GoalSchema,
  checklist: ChecklistSchema,
  number: NumberSchema,
  count: CountSchema,
  command: CommandSchema,
};

/** Rules that span more than one field. The first that applies is the error. */
type Rule = { applies: (spec: GraderSpec) => boolean; problem: string };

const RULES: Rule[] = [
  {
    applies: (spec) =>
      spec.kind === "goal" && spec.mustPass === true && spec.passingScore === undefined,
    problem: "a must-pass goal grader needs passingScore",
  },
  {
    applies: (spec) => spec.kind === "number" && hasRange(spec) && spec.max !== undefined,
    problem: "a number grader has either full and zero or max, not both",
  },
  {
    applies: (spec) => spec.kind === "number" && !hasRange(spec) && spec.max === undefined,
    problem: "a number grader needs full and zero or max",
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

function parseSpec(element: unknown, index: number, filePath: string): GraderSpec {
  const where = `${filePath}: grader ${index}`;
  if (typeof element !== "object" || element === null || Array.isArray(element)) {
    throw new Error(`${where}: must be an object with a kind`);
  }
  const kind = (element as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(kind in KIND_SCHEMAS)) {
    throw new Error(`${where}: unknown kind ${JSON.stringify(kind)}`);
  }
  const result = KIND_SCHEMAS[kind as GraderSpec["kind"]].safeParse(element);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${where}: ${issue.path.join(".")}: ${issue.message}`);
  }
  const spec = result.data as GraderSpec;
  const broken = RULES.find((rule) => rule.applies(spec));
  if (broken !== undefined) {
    throw new Error(`${where} (${spec.name}): ${broken.problem}`);
  }
  return spec;
}

function firstDuplicateName(specs: GraderSpec[]): string | undefined {
  const names = specs.map((spec) => spec.name);
  return names.find((name, index) => names.indexOf(name) !== index);
}
