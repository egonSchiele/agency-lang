import { createHash } from "crypto";

import { nanoid } from "nanoid";

import { canonicalize, type JsonValue } from "@/utils/canonicalize.js";

import {
  CHECKLIST_ID_RANDOM_LENGTH,
  QUESTION_ID_RANDOM_LENGTH,
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

/** Identity of a resumable session. Includes trace ORDER, so a draft can
 *  never be resumed against a differently ordered directory. */
export function makeSessionId(identity: SessionIdentity): string {
  return `session_${digestOf({
    traceIds: identity.traceIds,
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
