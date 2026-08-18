import * as fs from "fs";

import { z } from "zod";

import { canonicalize, type JsonValue } from "@/utils/canonicalize.js";
import { sha256Text } from "@/utils/hash.js";

/**
 * Annotations: every opinion anyone or anything forms about a trace — a note, a
 * checklist answer, a grader score, an LLM judgement, or the eval harness's own
 * record of what it launched. One append-only `annotations.jsonl` per run
 * directory; this module owns the row shapes, the deterministic ids, and the
 * pure fold from rows to effective state. It does no locking and no writing:
 * `mutations.ts` owns those.
 */

// --- row shapes -----------------------------------------------------------

export type AnnotatorKind = "human" | "grader" | "judge" | "harness";
export type Annotator = { kind: AnnotatorKind; id: string };

export type Score = { kind: "binary"; pass: boolean } | { kind: "scalar"; value: number };

export type NotePayload = { kind: "note"; text: string };

export type ChecklistPayload = {
  kind: "checklist";
  checklist: string;
  version: number;
  hash: string;
  answers: Record<string, boolean>;
  note: string;
};

/** One grader's verdict on one trace in one grading pass. A pass is `passSize`
 *  rows sharing a `passId`, the last of which carries `completesPass: true`;
 *  the fold counts a pass only when it is complete, so a crash mid-pass can
 *  never move effective scores. */
export type ScorePayload = {
  kind: "score";
  passId: string;
  passSize: number;
  completesPass: boolean;
  name: string;
  score: Score;
  weight: number;
  mustPass: boolean;
  feedback?: string;
  gradersModule?: string;
};

export type SuiteIdentity = { source: string; sha?: string };
export type RunOutcome = "ok" | "error" | "timeout" | "cost-cap" | "killed";

/** The eval harness's own row for a trace it launched: which test, which
 *  suite, how the run ended, which flags. The one place harness knowledge
 *  ("I killed it at the cost cap") lives. */
export type RunPayload = {
  kind: "run";
  test: JsonValue;
  suite: SuiteIdentity | null;
  ended: RunOutcome;
  flags: Record<string, JsonValue>;
};

export type AnnotationPayload = NotePayload | ChecklistPayload | ScorePayload | RunPayload;

/** What a writer supplies; `v`, `id` and `createdAt` are filled at append. */
export type AnnotationDraft = {
  traceId: string;
  annotator: Annotator;
  sessionId?: string;
} & AnnotationPayload;

export type Annotation = { v: 1; id: string; createdAt: string } & AnnotationDraft;

// --- schemas --------------------------------------------------------------

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const AnnotatorSchema = z
  .object({ kind: z.enum(["human", "grader", "judge", "harness"]), id: z.string().min(1) })
  .strict();

const ScoreSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("binary"), pass: z.boolean() }).strict(),
  z.object({ kind: z.literal("scalar"), value: z.number().finite() }).strict(),
]);

const common = {
  v: z.literal(1),
  id: z.string().regex(/^ann_[0-9a-f]{64}$/),
  traceId: z.string().min(1),
  createdAt: z.string().min(1),
  annotator: AnnotatorSchema,
  sessionId: z.string().min(1).optional(),
};

export const AnnotationSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("note"), text: z.string() }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("checklist"),
      checklist: z.string().min(1),
      version: z.number().int().positive(),
      hash: z.string().min(1),
      answers: z.record(z.string(), z.boolean()),
      note: z.string(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("score"),
      passId: z.string().min(1),
      passSize: z.number().int().positive(),
      completesPass: z.boolean(),
      name: z.string().min(1),
      score: ScoreSchema,
      weight: z.number().finite().nonnegative(),
      mustPass: z.boolean(),
      feedback: z.string().optional(),
      gradersModule: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("run"),
      test: JsonValueSchema,
      suite: z.object({ source: z.string(), sha: z.string().optional() }).strict().nullable(),
      ended: z.enum(["ok", "error", "timeout", "cost-cap", "killed"]),
      flags: z.record(z.string(), JsonValueSchema),
    })
    .strict(),
]);

// --- identity -------------------------------------------------------------

/** The same opinion always gets the same id, so a retried append rewrites
 *  nothing and doubles nothing. Score rows carry their `passId`, which makes
 *  the id per pass: a second pass with the same verdict is a new row. */
export function annotationId(draft: AnnotationDraft): string {
  const { traceId, annotator, sessionId, ...payload } = draft;
  return `ann_${sha256Text(canonicalize({ traceId, annotator, payload, sessionId: sessionId ?? null }))}`;
}

/** Complete a draft into a row: validated, with `v`, `id` and `createdAt`. */
export function completeAnnotation(draft: AnnotationDraft, createdAt: string): Annotation {
  const row = { v: 1 as const, id: annotationId(draft), createdAt, ...draft };
  return AnnotationSchema.parse(row) as Annotation;
}

// --- reading --------------------------------------------------------------

/** @internal Used by readRunDirectory and the mutation owners, not by feature
 *  callers. Tolerant: a malformed row is reported and skipped (grading has
 *  already been paid for; one bad line must not hide the rest); a final line
 *  without its newline is a torn write and is ignored. */
export function readAnnotations(
  annotationsPath: string,
  reportWarning: (message: string) => void,
): Annotation[] {
  if (!fs.existsSync(annotationsPath)) return [];
  const text = fs.readFileSync(annotationsPath, "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const rows: Annotation[] = [];
  const lines = complete.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "") continue;
    const parsed = parseRow(raw);
    if (parsed === undefined) {
      reportWarning(`${annotationsPath}:${index + 1}: skipping malformed annotation row`);
      continue;
    }
    rows.push(parsed);
  }
  return rows;
}

function parseRow(raw: string): Annotation | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = AnnotationSchema.safeParse(value);
  return result.success ? (result.data as Annotation) : undefined;
}

// --- effective state ------------------------------------------------------

export type EffectiveChecklistJudgement = {
  annotator: Annotator;
  answers: Record<string, boolean>;
  note: string;
};

export type EffectiveTraceAnnotations = {
  notes: Annotation[];
  /** Keyed by `${annotator.kind}:${annotator.id}:${name}`; the latest row from
   *  the latest COMPLETE pass wins. */
  scores: Record<string, Annotation>;
  /** Keyed by `${checklist}:${annotator.kind}:${annotator.id}`, answers folded
   *  per question in append order so a restored question keeps its answer. */
  checklists: Record<string, EffectiveChecklistJudgement>;
  run: Annotation | null;
};

/** @internal Pure fold from rows to effective state, in append order. Feature
 *  callers read `snapshot.effectiveAnnotations`; this is exposed for focused
 *  tests. */
export function foldAnnotations(
  rows: readonly Annotation[],
): Record<string, EffectiveTraceAnnotations> {
  const byTrace: Record<string, EffectiveTraceAnnotations> = Object.create(null);
  const completePasses = completedPassIds(rows);
  for (const row of rows) {
    const trace = (byTrace[row.traceId] ??= { notes: [], scores: {}, checklists: {}, run: null });
    if (row.kind === "note") {
      trace.notes.push(row);
    } else if (row.kind === "checklist") {
      const key = `${row.checklist}:${row.annotator.kind}:${row.annotator.id}`;
      const existing = trace.checklists[key];
      trace.checklists[key] = {
        annotator: row.annotator,
        answers: { ...(existing?.answers ?? {}), ...row.answers },
        note: row.note,
      };
    } else if (row.kind === "score") {
      if (completePasses[row.passId]) {
        trace.scores[`${row.annotator.kind}:${row.annotator.id}:${row.name}`] = row;
      }
    } else {
      trace.run = row;
    }
  }
  return byTrace;
}

/** A pass is complete when exactly `passSize` distinct rows carry its id and
 *  one of them says `completesPass`. Anything else is a crash's leftovers. */
function completedPassIds(rows: readonly Annotation[]): Record<string, true> {
  const seen: Record<string, { ids: Record<string, true>; size: number; completed: boolean }> =
    Object.create(null);
  for (const row of rows) {
    if (row.kind !== "score") continue;
    const pass = (seen[row.passId] ??= {
      ids: Object.create(null),
      size: row.passSize,
      completed: false,
    });
    pass.ids[row.id] = true;
    if (row.completesPass) pass.completed = true;
  }
  const complete: Record<string, true> = Object.create(null);
  for (const [passId, pass] of Object.entries(seen)) {
    if (pass.completed && Object.keys(pass.ids).length === pass.size) complete[passId] = true;
  }
  return complete;
}
