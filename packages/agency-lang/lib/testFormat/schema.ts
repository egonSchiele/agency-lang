/**
 * The one owner of the `.test.json` format, in two profiles:
 *
 * - FULL (the `agency test` CLI runner): every field the runner supports,
 *   validated instead of the previous unchecked TypeScript casts.
 * - SANDBOX (`std::agency`'s `testFile()`): the deliberate subset that makes
 *   sense inside the run() sandbox. Anything else is refused BY NAME —
 *   a silently ignored mock would make a test pass for the wrong reason.
 *
 * Both profiles are pure text-to-data functions: no reads, writes, globals,
 * or clocks. Callers own file access.
 */
import { z } from "zod";
import * as path from "path";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The sandbox profile allows exactly these; `modify` and `resolve` are
 *  full-profile-only (they need the CLI runner's authoritative answering). */
const sandboxInterruptSchema = z
  .strictObject({
    action: z.enum(["approve", "reject"], {
      error: (issue) =>
        issue.code === "invalid_value"
          ? `interrupt action '${issue.input}' is not supported in the sandbox profile (only approve and reject)`
          : undefined,
    }),
    value: z.unknown().optional(),
    expectedMessage: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if ("modifiedArgs" in (val as Record<string, unknown>)) {
      ctx.addIssue({ code: "custom", message: "modifiedArgs is not supported" });
    }
  });

const fullInterruptSchema = z.object({
  action: z.enum(["approve", "reject", "modify", "resolve"]),
  expectedMessage: z.string().optional(),
  modifiedArgs: z.record(z.string(), z.unknown()).optional(),
  value: z.unknown().optional(),
});

const positiveMs = (field: string) =>
  z.number().positive({ message: `${field} must be a positive number of milliseconds` });

// ---------------------------------------------------------------------------
// Sandbox profile
// ---------------------------------------------------------------------------

export type InterruptAction = "approve" | "reject";
export type ParsedInterrupt = {
  action: InterruptAction;
  value?: unknown;
  expectedMessage?: string;
};

export type ParsedTestCase = {
  nodeName: string;
  /** Raw argument-expression string; binding happens at the conversion
   *  boundary (lib/testFormat/inputArgs.ts). */
  input: string;
  /** JSON.parse of expectedOutput — parsed at parse time so a malformed
   *  expectation is a whole-file error before anything runs. */
  expected: unknown;
  criteria: "exact";
  interrupts: ParsedInterrupt[];
  timeoutMs?: number;
  description?: string;
};

export type ParsedTestFile = {
  sourceFile: string;
  defaultTimeoutMs?: number;
  description?: string;
  cases: ParsedTestCase[];
};

// Fields the full format has that the sandbox profile deliberately refuses.
// Listed explicitly so the error can name the field; z.strictObject would
// only say "unrecognized key".
const SANDBOX_REFUSED_FILE_FIELDS = [
  "expectedCompileError",
  "fetchMocks",
  "skip",
  "skipOnCI",
  "skipReason",
] as const;
const SANDBOX_REFUSED_CASE_FIELDS = [
  "llmMocks",
  "fetchMocks",
  "fakeClock",
  "argv",
  "retry",
  "skip",
  "skipOnCI",
  "useTestLLMProvider",
] as const;

const sandboxCriteriaSchema = z
  .array(z.unknown())
  .superRefine((criteria, ctx) => {
    if (criteria.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `evaluationCriteria must be exactly [{ "type": "exact" }] in the sandbox profile (got ${criteria.length} entries)`,
      });
      return;
    }
    const only = criteria[0];
    if (
      typeof only !== "object" ||
      only === null ||
      (only as Record<string, unknown>).type !== "exact"
    ) {
      ctx.addIssue({
        code: "custom",
        message: `evaluationCriteria must be exactly [{ "type": "exact" }] in the sandbox profile`,
      });
    }
  });

const sandboxCaseSchema = z
  .strictObject({
    nodeName: z.string({ message: "nodeName must be a string" }).min(1),
    input: z.string({ message: "input must be a string" }),
    expectedOutput: z.string({ message: "expectedOutput must be a string" }),
    evaluationCriteria: sandboxCriteriaSchema,
    interruptHandlers: z.array(sandboxInterruptSchema).optional(),
    timeoutMs: positiveMs("timeoutMs").optional(),
    description: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    for (const field of SANDBOX_REFUSED_CASE_FIELDS) {
      if (field in (val as Record<string, unknown>)) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is not supported in sandboxed test files`,
        });
      }
    }
  });

const sandboxFileSchema = z
  .strictObject({
    sourceFile: z.string().optional(),
    description: z.string().optional(),
    defaultTimeoutMs: positiveMs("defaultTimeoutMs").optional(),
    tests: z.array(sandboxCaseSchema).min(1, { message: "tests must be a non-empty array" }),
  })
  .superRefine((val, ctx) => {
    for (const field of SANDBOX_REFUSED_FILE_FIELDS) {
      if (field in (val as Record<string, unknown>)) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is not supported in sandboxed test files`,
        });
      }
    }
  });

/** Default rule shared with the CLI runner: `<basename>.agency` beside the
 *  json when no explicit sourceFile is declared. */
export function resolveSourceFile(declared: string | undefined, jsonFilename: string): string {
  if (declared !== undefined) return declared;
  return path.basename(jsonFilename).replace(/\.test\.json$/, "") + ".agency";
}

export function parseTestFileSandbox(jsonText: string, jsonFilename: string): ParsedTestFile {
  const raw = parseJsonOrThrow(jsonText, jsonFilename);
  const result = sandboxFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${jsonFilename}: ${formatZodError(result.error)}`);
  }
  const file = result.data;
  const cases: ParsedTestCase[] = file.tests.map((testCase, i) => {
    let expected: unknown;
    try {
      expected = JSON.parse(testCase.expectedOutput);
    } catch {
      throw new Error(
        `${jsonFilename}: test ${i + 1} (${testCase.nodeName}): expectedOutput ${JSON.stringify(
          testCase.expectedOutput,
        )} is not valid JSON. A plain string must be quoted: "\\"ok\\"" means the string ok.`,
      );
    }
    const parsed: ParsedTestCase = {
      nodeName: testCase.nodeName,
      input: testCase.input,
      expected,
      criteria: "exact",
      interrupts: (testCase.interruptHandlers ?? []).map((h) => {
        const interrupt: ParsedInterrupt = { action: h.action };
        if (h.value !== undefined) interrupt.value = h.value;
        if (h.expectedMessage !== undefined) interrupt.expectedMessage = h.expectedMessage;
        return interrupt;
      }),
    };
    if (testCase.timeoutMs !== undefined) parsed.timeoutMs = testCase.timeoutMs;
    if (testCase.description !== undefined) parsed.description = testCase.description;
    return parsed;
  });
  const out: ParsedTestFile = {
    sourceFile: resolveSourceFile(file.sourceFile, jsonFilename),
    cases,
  };
  if (file.defaultTimeoutMs !== undefined) out.defaultTimeoutMs = file.defaultTimeoutMs;
  if (file.description !== undefined) out.description = file.description;
  return out;
}

// ---------------------------------------------------------------------------
// Full profile — the complete field set the CLI runner supports. Mock and
// clock internals are validated by their owners (deterministicClient,
// fetchMock) at use time; here they are shape-checked as arrays/records so
// a typo'd field name still fails loudly.
// ---------------------------------------------------------------------------

const fullCriteriaSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("exact") }),
      z.object({
        type: z.literal("llmJudge"),
        judgePrompt: z.string(),
        desiredAccuracy: z.number(),
      }),
    ]),
  )
  .min(1, { message: "evaluationCriteria must name at least one criterion" });

const fullCaseSchema = z.object({
  nodeName: z.string().min(1),
  input: z.string(),
  expectedOutput: z.string(),
  evaluationCriteria: fullCriteriaSchema,
  interruptHandlers: z.array(fullInterruptSchema).optional(),
  description: z.string().optional(),
  retry: z.number().optional(),
  skip: z.boolean().optional(),
  skipOnCI: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  llmMocks: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  useTestLLMProvider: z.boolean().optional(),
  argv: z.array(z.string()).optional(),
  fetchMocks: z.array(z.unknown()).optional(),
  fakeClock: z.boolean().optional(),
});

const fullFileSchema = z.object({
  sourceFile: z.string().optional(),
  tests: z.array(fullCaseSchema).optional(),
  expectedCompileError: z.string().optional(),
  description: z.string().optional(),
  fetchMocks: z.array(z.unknown()).optional(),
  skip: z.boolean().optional(),
  skipOnCI: z.boolean().optional(),
  skipReason: z.string().optional(),
  defaultTimeoutMs: z.number().optional(),
});

export type FullTestCase = z.infer<typeof fullCaseSchema>;
export type FullTestFile = z.infer<typeof fullFileSchema>;

export function parseTestFileFull(jsonText: string, jsonFilename: string): FullTestFile {
  const raw = parseJsonOrThrow(jsonText, jsonFilename);
  const result = fullFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${jsonFilename}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------

function parseJsonOrThrow(jsonText: string, jsonFilename: string): unknown {
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      `${jsonFilename} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      if (issue.code === "unrecognized_keys") {
        return `${where}unsupported field(s): ${issue.keys.join(", ")}`;
      }
      return `${where}${issue.message}`;
    })
    .join("; ");
}
