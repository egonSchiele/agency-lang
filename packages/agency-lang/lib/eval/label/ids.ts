import { createHash } from "crypto";

import { nanoid } from "nanoid";

import { canonicalize, type JsonValue } from "@/utils/canonicalize.js";

import {
  ANNOTATION_ID_RANDOM_LENGTH,
  CHECKLIST_ID_RANDOM_LENGTH,
  QUESTION_ID_RANDOM_LENGTH,
  type Fields,
  type OccurrenceCandidate,
  type SessionIdentity,
} from "./types.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash a structured identity rather than a joined string. Canonical JSON is
 *  already unambiguous about where one field ends and the next begins, so no
 *  separator can be smuggled in through a field value. */
function digestOf(identity: JsonValue): string {
  return sha256(canonicalize(identity));
}

/**
 * Identity of a record: the hash of its fields.
 *
 * Not where it came from. Two runs that emit byte-identical output produced the
 * same training example and should be labelled once; which run emitted it is a
 * fact about the record, recorded in the occurrence log. Canonical JSON sorts
 * keys, so the order fields were added in cannot change an id.
 */
export function makeOutputId(fields: Fields): string {
  return `out_${digestOf({ ...fields })}`;
}

/** Identity of one observation. Deliberately excludes the timestamp: when you
 *  observed something is not part of which observation it is. */
export function makeOccurrenceId(candidate: OccurrenceCandidate): string {
  return `occ_${digestOf({
    outputId: candidate.outputId,
    source: candidate.source,
    origin: { ...candidate.origin },
  })}`;
}

/** Identity of a resumable session. Includes output ORDER, so a draft can
 *  never be resumed against a differently ordered source. */
export function makeSessionId(identity: SessionIdentity): string {
  return `session_${digestOf({
    outputIds: identity.outputIds,
    checklistId: identity.checklistId,
    annotator: { ...identity.annotator },
  })}`;
}

/** Hash of a revision's meaningful content. Excludes the hash field itself,
 *  which cannot contain itself. */
export function checklistHashOf(fields: {
  checklistId: string;
  version: number;
  questions: readonly { id: string; text: string; weight: number; deleted: boolean }[];
}): string {
  return `sha256:${digestOf({
    checklistId: fields.checklistId,
    version: fields.version,
    questions: fields.questions.map((question) => ({ ...question })),
  })}`;
}

export function makeChecklistId(): string {
  return `cl_${nanoid(CHECKLIST_ID_RANDOM_LENGTH)}`;
}

export function makeQuestionId(): string {
  return `q_${nanoid(QUESTION_ID_RANDOM_LENGTH)}`;
}

export function makeAnnotationId(): string {
  return `ann_${nanoid(ANNOTATION_ID_RANDOM_LENGTH)}`;
}
