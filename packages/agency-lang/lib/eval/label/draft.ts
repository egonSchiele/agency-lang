import * as fs from "fs";
import * as path from "path";

import { z } from "zod";

import { ChecklistAnnotationSchema } from "@/runDirectory/annotations.js";
import { atomicWriteValidated } from "@/runDirectory/durableWrite.js";
import { runDirPaths } from "@/runDirectory/runDir.js";

import {
  AnnotatorSchema,
  ChecklistIdSchema,
  ChecklistQuestionSchema,
  ChecklistRevisionSchema,
  ContentHashSchema,
  QuestionIdSchema,
  SessionIdSchema,
  TraceIdSchema,
} from "./types.js";

/** Where a session's checklist stands. `unpublished` is legal only while the
 *  session is still carrying its own version-1 pending revision — an active
 *  session can never be bound to nothing. */
export const ChecklistBindingSchema = z.union([
  z.object({ kind: z.literal("unpublished") }).strict(),
  z
    .object({
      kind: z.literal("published"),
      version: z.number().int().positive(),
      hash: ContentHashSchema,
    })
    .strict(),
]);

export type ChecklistBinding = z.infer<typeof ChecklistBindingSchema>;

export const SessionBindingSchema = z
  .object({
    traceIds: z.array(TraceIdSchema),
    checklistId: ChecklistIdSchema,
    checklist: ChecklistBindingSchema,
    annotator: AnnotatorSchema,
  })
  .strict();

export type SessionBinding = z.infer<typeof SessionBindingSchema>;

export const PendingRevisionSchema = z
  .object({
    revision: ChecklistRevisionSchema,
    expectedParentVersion: z.number().int().positive().nullable(),
    expectedParentHash: ContentHashSchema.nullable(),
  })
  .strict();

export const DraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdSchema,
    binding: SessionBindingSchema,
    currentIndex: z.number().int().nonnegative(),
    answersByTraceId: z.record(TraceIdSchema, z.record(QuestionIdSchema, z.boolean())),
    notesByTraceId: z.record(TraceIdSchema, z.string()),
    reviewedByTraceId: z.record(TraceIdSchema, z.array(QuestionIdSchema)),
    stagedQuestions: z.array(ChecklistQuestionSchema).nullable(),
    pendingRevision: PendingRevisionSchema.nullable(),
    /** The complete annotation, written here before it is appended, so a crash
     *  between the two is repaired by replaying the same id. */
    pendingAnnotation: ChecklistAnnotationSchema.nullable(),
    /** Accumulated interaction time per trace. Never a monotonic anchor: a
     *  stored anchor would count the hours a paused session spent closed. */
    activeMsByTraceId: z.record(TraceIdSchema, z.number().finite().nonnegative()),
  })
  .strict();

export type Draft = z.infer<typeof DraftSchema>;

/** A draft lives beside the checklist it is bound to, so a run directory shows
 *  which checklists have labeling in flight: `checklists/<id>/drafts/<session>.json`. */
export function draftPath(dir: string, checklistId: string, sessionId: string): string {
  return path.join(runDirPaths(dir).checklistsDir, checklistId, "drafts", `${sessionId}.json`);
}

export function saveDraftFile(dir: string, draft: Draft): void {
  atomicWriteValidated({
    targetPath: draftPath(dir, draft.binding.checklistId, draft.sessionId),
    value: draft,
    schema: DraftSchema,
  });
}

export function loadDraftFile(
  dir: string,
  checklistId: string,
  sessionId: string,
): Draft | undefined {
  const file = draftPath(dir, checklistId, sessionId);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parsed = DraftSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid labelling draft: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export type DraftBindingCheck = {
  traceIds: string[];
  checklistId: string;
  annotator: { kind: string; id: string };
};

/**
 * A draft may only be resumed against exactly the session it was made for.
 *
 * Trace ORDER is part of that: answers are stored by trace id, but the
 * cursor is an index, so resuming against a reordered source would put a
 * person in front of a different trace than the one their position implies.
 */
export function assertDraftMatches(draft: Draft, expected: DraftBindingCheck): void {
  if (draft.binding.checklistId !== expected.checklistId) {
    throw new Error(
      `Draft ${draft.sessionId} belongs to checklist "${draft.binding.checklistId}", not ` +
        `"${expected.checklistId}".`,
    );
  }
  if (
    draft.binding.annotator.kind !== expected.annotator.kind ||
    draft.binding.annotator.id !== expected.annotator.id
  ) {
    throw new Error(
      `Draft ${draft.sessionId} belongs to ${draft.binding.annotator.kind} ` +
        `"${draft.binding.annotator.id}", not ${expected.annotator.kind} "${expected.annotator.id}".`,
    );
  }
  const sameOrder =
    draft.binding.traceIds.length === expected.traceIds.length &&
    draft.binding.traceIds.every((traceId, index) => traceId === expected.traceIds[index]);
  if (!sameOrder) {
    throw new Error(
      `Draft ${draft.sessionId} was made against a different set or order of traces. ` +
        `Resuming it would attach answers to the wrong traces.`,
    );
  }
}

/** The bootstrap rule, stated once. An unpublished binding is only ever legal
 *  while the session still holds its own version-1 pending revision. */
export function assertBindingIsCoherent(draft: Draft): void {
  if (draft.binding.checklist.kind === "published") {
    return;
  }
  const pending = draft.pendingRevision;
  if (
    pending === null ||
    pending.expectedParentVersion !== null ||
    pending.expectedParentHash !== null
  ) {
    throw new Error(
      `Draft ${draft.sessionId} has an unpublished checklist binding without a version-1 pending ` +
        `revision. Only a session that has not yet published its first revision may be unbound.`,
    );
  }
}
