/**
 * The wrapper's report envelope: the ONLY data channel between the shipped
 * agency-test wrapper (lib/agents/eval/agencyTestWrapper.agency) and the
 * AgencyTestGrader. It travels as a file the wrapper writes with its own
 * approved write — never stdout, which the tested subprocess shares and
 * could forge. Validated strictly before scoring.
 */
import { z } from "zod";

const caseReportSchema = z.strictObject({
  node: z.string(),
  pass: z.boolean(),
  feedback: z.string(),
});

const envelopeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("tested"),
    report: z.strictObject({
      pass: z.boolean(),
      cases: z.array(caseReportSchema),
    }),
  }),
  z.strictObject({
    status: z.literal("could-not-test"),
    // A wrapper-owned presentation value: string failures verbatim,
    // structured limit failures rendered — never the serialized runtime
    // failure object (checkpoint metadata, non-JSON values).
    feedback: z.string(),
  }),
]);

export type EnvelopeCaseReport = z.infer<typeof caseReportSchema>;
export type ReportEnvelope = z.infer<typeof envelopeSchema>;
export type TestedEnvelope = Extract<ReportEnvelope, { status: "tested" }>;
export type CouldNotTestEnvelope = Extract<ReportEnvelope, { status: "could-not-test" }>;

export function parseReportEnvelope(text: string): ReportEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`report envelope is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = envelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `report envelope is malformed: ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
}
