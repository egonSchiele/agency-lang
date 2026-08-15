import * as fs from "fs";
import * as path from "path";

import { z } from "zod";

import { atomicWriteValidated } from "./jsonl.js";
import {
  AnnotationRowSchema,
  AnnotatorSchema,
  ChecklistIdSchema,
  ChecklistQuestionSchema,
  ChecklistRevisionSchema,
  ContentHashSchema,
  OutputIdSchema,
  QuestionIdSchema,
  SessionIdSchema,
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
    outputIds: z.array(OutputIdSchema),
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
    answersByOutputId: z.record(OutputIdSchema, z.record(QuestionIdSchema, z.boolean())),
    notesByOutputId: z.record(OutputIdSchema, z.string()),
    reviewedByOutputId: z.record(OutputIdSchema, z.array(QuestionIdSchema)),
    stagedQuestions: z.array(ChecklistQuestionSchema).nullable(),
    pendingRevision: PendingRevisionSchema.nullable(),
    /** The complete annotation, written here before it is appended, so a crash
     *  between the two is repaired by replaying the same id. */
    pendingAnnotation: AnnotationRowSchema.nullable(),
    /** Accumulated interaction time per output. Never a monotonic anchor: a
     *  stored anchor would count the hours a paused session spent closed. */
    activeMsByOutputId: z.record(OutputIdSchema, z.number().finite().nonnegative()),
  })
  .strict();

export type Draft = z.infer<typeof DraftSchema>;

export function draftPath(datasetDir: string, sessionId: string): string {
  return path.join(datasetDir, "drafts", `${sessionId}.json`);
}

export function saveDraftFile(datasetDir: string, draft: Draft): void {
  atomicWriteValidated({
    targetPath: draftPath(datasetDir, draft.sessionId),
    value: draft,
    schema: DraftSchema,
  });
}

export function loadDraftFile(datasetDir: string, sessionId: string): Draft | undefined {
  const file = draftPath(datasetDir, sessionId);
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
  outputIds: string[];
  checklistId: string;
  annotator: { kind: string; id: string };
};

/**
 * A draft may only be resumed against exactly the session it was made for.
 *
 * Output ORDER is part of that: answers are stored by output id, but the
 * cursor is an index, so resuming against a reordered source would put a
 * person in front of a different output than the one their position implies.
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
    draft.binding.outputIds.length === expected.outputIds.length &&
    draft.binding.outputIds.every((outputId, index) => outputId === expected.outputIds[index]);
  if (!sameOrder) {
    throw new Error(
      `Draft ${draft.sessionId} was made against a different set or order of outputs. ` +
        `Resuming it would attach answers to the wrong outputs.`,
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
