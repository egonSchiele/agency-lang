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

// Presence means "check the message"; an empty expectation could never be
// checked against a real interrupt, so it is a mistake, not a wildcard.
const expectedMessageSchema = z
  .string()
  .min(1, { message: "expectedMessage must not be empty (omit it to skip the check)" });

/** The sandbox profile allows exactly these; `resolve` is
 *  full-profile-only (it needs the CLI runner's authoritative answering). */
const sandboxInterruptSchema = z
  .strictObject({
    action: z.enum(["approve", "reject"], {
      error: (issue) =>
        issue.code === "invalid_value"
          ? `interrupt action '${issue.input}' is not supported in the sandbox profile (only approve and reject)`
          : undefined,
    }),
    value: z.unknown().optional(),
    expectedMessage: expectedMessageSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if ("modifiedArgs" in (val as Record<string, unknown>)) {
      ctx.addIssue({ code: "custom", message: "modifiedArgs is not supported" });
    }
  });

// `modify` is deliberately absent: the runtime interrupt-response API has
// only approve/reject, and both execution templates throw on it — a config
// declaring it could never run.
const fullInterruptSchema = z.strictObject({
  action: z.enum(["approve", "reject", "resolve"]),
  expectedMessage: expectedMessageSchema.optional(),
  value: z.unknown().optional(),
  /** The answer a `resolve` action responds with. */
  resolvedValue: z.unknown().optional(),
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
  /** Named arguments, exactly as run() takes them. */
  args: Record<string, unknown>;
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

// Strict: `{ type: "exact", judgePrompt: "…" }` must fail rather than
// silently dropping the extra configuration.
const exactCriterionSchema = z.strictObject({ type: z.literal("exact") });

const sandboxCriteriaSchema = z.array(z.unknown()).superRefine((criteria, ctx) => {
  if (criteria.length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: `evaluationCriteria must be exactly [{ "type": "exact" }] in the sandbox profile (got ${criteria.length} entries)`,
    });
    return;
  }
  if (!exactCriterionSchema.safeParse(criteria[0]).success) {
    ctx.addIssue({
      code: "custom",
      message: `evaluationCriteria must be exactly [{ "type": "exact" }] in the sandbox profile`,
    });
  }
});

const sandboxCaseSchema = z
  .strictObject({
    nodeName: z.string({ message: "nodeName must be a string" }).min(1),
    args: z.record(z.string(), z.unknown()).optional(),
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
      args: testCase.args ?? {},
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
// Full profile — the complete field set the CLI runner supports, strict at
// every level so a typo'd field name fails loudly instead of silently
// falling back to a default. Mock and clock ENTRY internals are validated
// by their owners (deterministicClient, fetchMock) at use time; here they
// are shape-checked as arrays/records.
// ---------------------------------------------------------------------------

const fullCriteriaSchema = z
  .array(
    z.union([
      exactCriterionSchema,
      z.strictObject({
        type: z.literal("llmJudge"),
        judgePrompt: z.string(),
        // The judge returns a 0–100 score; desiredAccuracy is compared
        // against it, so a fraction like 0.9 would pass vacuously.
        desiredAccuracy: z
          .number()
          .min(0)
          .max(100, { message: "desiredAccuracy is a 0–100 judge-score threshold" }),
      }),
    ]),
  )
  .min(1, { message: "evaluationCriteria must name at least one criterion" });

const fullCaseSchema = z.strictObject({
  nodeName: z.string().min(1),
  /** A JavaScript argument list pasted into the generated runner (#881).
   *  Optional so a no-argument case can omit it and stay valid in the
   *  sandbox profile too, which refuses this field. */
  input: z.string().optional(),
  expectedOutput: z.string(),
  evaluationCriteria: fullCriteriaSchema,
  interruptHandlers: z.array(fullInterruptSchema).optional(),
  description: z.string().optional(),
  retry: z.number().optional(),
  skip: z.boolean().optional(),
  skipOnCI: z.boolean().optional(),
  /** Documentation beside a per-case `skip`; only the file-level
   *  skipReason is printed by the runner. */
  skipReason: z.string().optional(),
  timeoutMs: z.number().optional(),
  llmMocks: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  useTestLLMProvider: z.boolean().optional(),
  argv: z.array(z.string()).optional(),
  fetchMocks: z.array(z.unknown()).optional(),
  fakeClock: z.boolean().optional(),
});

const fullFileSchema = z.strictObject({
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
        // The CLI's `input` string is the one field people will reach for.
        const hint = issue.keys.includes("input")
          ? ' (input is not supported in sandboxed test files; pass named arguments as args: { "n": 10 })'
          : "";
        return `${where}unsupported field(s): ${issue.keys.join(", ")}${hint}`;
      }
      return `${where}${issue.message}`;
    })
    .join("; ");
}
