import * as fs from "fs";

import { z } from "zod";

import { canonicalize, type JsonValue } from "@/utils/canonicalize.js";
import { sha256Text } from "@/utils/hash.js";

/**
 * Annotations: every structured opinion anyone or anything forms about a trace
 * — a checklist answer, a grader score, an LLM judgement, or the eval harness's
 * own record of what it launched. (A person's free-form note is not a row; it
 * is the run directory's `notes.md`.) One append-only `annotations.jsonl` per
 * run directory; this module owns the row shapes, the deterministic ids, and
 * the pure fold from rows to effective state. It does no locking and no
 * writing: `mutations.ts` owns those.
 */

// --- row shapes -----------------------------------------------------------

export type AnnotatorKind = "human" | "grader" | "judge" | "harness";
export type Annotator = { kind: AnnotatorKind; id: string };

export type Score = { kind: "binary"; pass: boolean } | { kind: "scalar"; value: number };

export type ChecklistPayload = {
  kind: "checklist";
  checklist: string;
  version: number;
  hash: string;
  answers: Record<string, boolean>;
  note: string;
  /** Milliseconds a person spent on this trace before signing off. */
  activeMs?: number;
};

/** One grader's verdict on one trace in one grading pass. A pass is `passSize`
 *  rows sharing a `passId`; the fold counts a pass only when all of them are
 *  present, so a crash mid-pass can never move effective scores. */
export type ScorePayload = {
  kind: "score";
  passId: string;
  passSize: number;
  /** @deprecated Legacy field on old rows; accepted and ignored. */
  completesPass?: boolean;
  name: string;
  score: Score;
  weight: number;
  mustPass: boolean;
  feedback?: string;
  gradersModule?: string;
  /** The goal an LLM judge scored against (a test's own, or `eval grade --goal`). */
  goal?: string;
};

export type SuiteIdentity = { source: string; sha?: string };

/** Where a run's graders came from and what the directory's `graders/` holds
 *  for them: the bundled module under `bundleFile`, and each judge file the
 *  graders read by path under its stored name. Grading prefers this
 *  snapshot, so a copied run grades the same anywhere. */
export type GradersIdentity = {
  source: string;
  bundleFile: string;
  judgeFiles: Record<string, string>;
  /** "test": the test's own module. "config": the former `eval.graders`
   *  fallback, which runs written before it was removed may still carry;
   *  `--goal` sets those aside but never a test's own. */
  origin: "test" | "config";
};
/** A harness pair stored under `graders/` as `<sha256 of content><ext>`.
 *  `sha256` covers both files and is the grader's revision. */
export type HarnessRecord = {
  name: string;
  visibility: "visible" | "holdout";
  agency: string;
  json: string;
  sha256: string;
  maxCost?: number;
  mustPass?: boolean;
};

export type RunOutcome = "ok" | "error" | "timeout" | "cost-cap" | "killed";

/** The eval harness's own row for a trace it launched: which test, which
 *  suite, how the run ended, which flags. The one place harness knowledge
 *  ("I killed it at the cost cap") lives. */
export type RunPayload = {
  kind: "run";
  test: JsonValue;
  suite: SuiteIdentity | null;
  /** Absent when the run had no grading module (the goal judge grades it). */
  graders?: GradersIdentity;
  /** The harness pairs this run is graded by. */
  harness?: HarnessRecord[];
  /** The stored copy of the test's `graderFiles/` directory: its name under
   *  `graders/`, a hash over every path and content. */
  graderFiles?: string;
  ended: RunOutcome;
  flags: Record<string, JsonValue>;
  /** The harness's error message when `ended` is not "ok". */
  error?: string;
  /** One invocation of a suite; absent on pre-batch directories. */
  batch?: string;
  /** This test's 1-based repetition within the batch. */
  trial?: number;
};

export type AnnotationPayload = ChecklistPayload | ScorePayload | RunPayload;

/** What a writer supplies; `v`, `id` and `createdAt` are filled at append. */
export type AnnotationDraft = {
  traceId: string;
  annotator: Annotator;
  /** The interactive labeling session (`agency label`) that produced the row,
   *  when there was one. A session is one sitting: one person, one checklist,
   *  one ordered list of traces. Two sittings answering the same questions
   *  the same way are still two rows, because the id hashes this in. */
  sessionId?: string;
} & AnnotationPayload;

export type Annotation = { v: 1; id: string; createdAt: string } & AnnotationDraft;
export type ChecklistAnnotation = Annotation & { kind: "checklist" };

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

export const ChecklistAnnotationSchema = z
  .object({
    ...common,
    kind: z.literal("checklist"),
    checklist: z.string().min(1),
    version: z.number().int().positive(),
    hash: z.string().min(1),
    answers: z.record(z.string(), z.boolean()),
    note: z.string(),
    activeMs: z.number().finite().nonnegative().optional(),
  })
  .strict();

const ScoreAnnotationSchema = z
  .object({
    ...common,
    kind: z.literal("score"),
    passId: z.string().min(1),
    passSize: z.number().int().positive(),
    // Written by rows from before pass completeness was passSize-only;
    // accepted so old directories keep their scores, ignored by the fold.
    completesPass: z.boolean().optional(),
    name: z.string().min(1),
    score: ScoreSchema,
    weight: z.number().finite().nonnegative(),
    mustPass: z.boolean(),
    feedback: z.string().optional(),
    gradersModule: z.string().optional(),
    goal: z.string().optional(),
  })
  .strict();

const RunAnnotationSchema = z
  .object({
    ...common,
    kind: z.literal("run"),
    test: JsonValueSchema,
    suite: z.object({ source: z.string(), sha: z.string().optional() }).strict().nullable(),
    graders: z
      .object({
        source: z.string(),
        bundleFile: z.string().min(1),
        judgeFiles: z.record(z.string(), z.string()),
        origin: z.enum(["test", "config"]),
      })
      .strict()
      .optional(),
    harness: z
      .array(
        z
          .object({
            // Plain names: the grader joins them onto directories.
            name: z.string().regex(/^[A-Za-z0-9._-]+$/),
            visibility: z.enum(["visible", "holdout"]),
            agency: z.string().regex(/^[0-9a-f]{64}\.agency$/),
            json: z.string().regex(/^[0-9a-f]{64}\.test\.json$/),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            maxCost: z.number().optional(),
            mustPass: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    graderFiles: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    ended: z.enum(["ok", "error", "timeout", "cost-cap", "killed"]),
    flags: z.record(z.string(), JsonValueSchema),
    error: z.string().optional(),
    batch: z.string().min(1).optional(),
    trial: z.number().int().positive().optional(),
  })
  .strict();

export const AnnotationSchema = z.discriminatedUnion("kind", [
  ChecklistAnnotationSchema,
  ScoreAnnotationSchema,
  RunAnnotationSchema,
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
  /** Keyed by `${annotator.kind}:${lineage}:${name}`, where the lineage is the
   *  annotator id without its `@<revision>` suffix, so every version of one
   *  grader or judge shares a key; the latest row from the latest COMPLETE pass
   *  wins. */
  scores: Record<string, Annotation>;
  /** How many complete grading passes scored this trace. The effective scores
   *  come from the latest; the earlier ones are history, still on disk. */
  gradingPasses: number;
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
  const passesByTrace: Record<string, Record<string, true>> = Object.create(null);
  for (const row of rows) {
    const trace = (byTrace[row.traceId] ??= {
      scores: {},
      gradingPasses: 0,
      checklists: {},
      run: null,
    });
    if (row.kind === "checklist") {
      const key = `${row.checklist}:${row.annotator.kind}:${row.annotator.id}`;
      const existing = trace.checklists[key];
      trace.checklists[key] = {
        annotator: row.annotator,
        answers: { ...(existing?.answers ?? {}), ...row.answers },
        note: row.note,
      };
    } else if (row.kind === "score") {
      if (completePasses[row.passId]) {
        if (!(passesByTrace[row.traceId] ??= Object.create(null))[row.passId]) {
          passesByTrace[row.traceId][row.passId] = true;
          trace.gradingPasses += 1;
        }
        trace.scores[scoreKey(row)] = row;
      }
    } else {
      trace.run = row;
    }
  }
  return byTrace;
}

/** `goal-judge@1` and `goal-judge@2` are one judge at two revisions; the
 *  newer supersedes the older rather than averaging with it. */
export function annotatorLineage(id: string): string {
  const at = id.lastIndexOf("@");
  return at <= 0 ? id : id.slice(0, at);
}

function scoreKey(row: Annotation & { kind: "score" }): string {
  return `${row.annotator.kind}:${annotatorLineage(row.annotator.id)}:${row.name}`;
}

/** A pass is complete when exactly `passSize` distinct rows carry its id.
 *  Fewer is a crash's leftovers. */
function completedPassIds(rows: readonly Annotation[]): Record<string, true> {
  const seen: Record<string, { ids: Record<string, true>; size: number }> = Object.create(null);
  for (const row of rows) {
    if (row.kind !== "score") continue;
    const pass = (seen[row.passId] ??= { ids: Object.create(null), size: row.passSize });
    pass.ids[row.id] = true;
  }
  const complete: Record<string, true> = Object.create(null);
  for (const [passId, pass] of Object.entries(seen)) {
    if (Object.keys(pass.ids).length === pass.size) complete[passId] = true;
  }
  return complete;
}
