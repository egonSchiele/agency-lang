import { createHash } from "crypto";

import { nanoid } from "nanoid";

import { canonicalize, type JsonValue } from "@/utils/canonicalize.js";

import {
  ANNOTATION_ID_RANDOM_LENGTH,
  CHECKLIST_ID_RANDOM_LENGTH,
  QUESTION_ID_RANDOM_LENGTH,
  type CorpusInput,
  type ExecutionIdentity,
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
 * Identity of one captured output occurrence.
 *
 * Derived from the persisted execution rather than from where the run happens
 * to be stored: a run directory can be renamed or copied, and two unrelated
 * runs can share a basename, none of which changes which execution produced
 * this output. Deterministic, so recapturing the same source is idempotent
 * without consulting the store.
 */
export function makeOutputId(identity: ExecutionIdentity): string {
  return `out_${digestOf({ ...identity })}`;
}

/** Content identity: the input and the value together, because the same text
 *  means different things under different tasks. Used for deduplication and
 *  duplicate warnings — never as an identity. */
export function contentHashOf(input: CorpusInput, value: JsonValue): string {
  return `sha256:${digestOf({ input: { ...input }, value })}`;
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
