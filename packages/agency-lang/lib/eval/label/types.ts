import { z } from "zod";

import type { Annotator } from "@/runDirectory/annotations.js";

export type { Annotator };

/** Recursively readonly. The store hands these out so a caller cannot mutate
 *  loaded rows and silently desynchronise them from what is on disk. */
export type DeepReadonly<Value> = Value extends (infer Element)[]
  ? readonly DeepReadonly<Element>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

// --- identifier shapes ---------------------------------------------------

/** Digest length for hashed identities, in hex characters (sha256). */
const DIGEST_HEX_LENGTH = 64;
/** Random suffix length for entity ids that are allocated, not derived. */
export const QUESTION_ID_RANDOM_LENGTH = 10;
export const CHECKLIST_ID_RANDOM_LENGTH = 10;

const hexDigest = `[a-f0-9]{${DIGEST_HEX_LENGTH}}`;
/** Anchored and filesystem-safe: these ids become path segments and file names. */
export const SessionIdSchema = z.string().regex(new RegExp(`^session_${hexDigest}$`));
export const ContentHashSchema = z.string().regex(new RegExp(`^sha256:${hexDigest}$`));
export const ChecklistIdSchema = z.string().regex(/^cl_[A-Za-z0-9_-]+$/);
export const QuestionIdSchema = z.string().regex(/^q_[A-Za-z0-9_-]+$/);
/** A trace id is whatever the statelog says it is; it only has to be present. */
export const TraceIdSchema = z.string().min(1);

// --- items ---------------------------------------------------------------

/** Field names are display-safe and stable: they become headers on the screen.
 *  The charset also means a name can never carry a control character or a
 *  `{style-tag}`. */
export const FieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

/** What the screen shows for one trace: named text, e.g. `input` and `output`. */
export const FieldsSchema = z.record(FieldNameSchema, z.string());

export type Fields = z.infer<typeof FieldsSchema>;

// --- identities ----------------------------------------------------------

export const AnnotatorSchema = z
  .object({
    kind: z.enum(["human", "grader", "judge", "harness"]),
    id: z.string().min(1),
  })
  .strict();

/** Everything a resumable session is bound to. Order of `traceIds` is part of
 *  the identity: a draft resumed against a differently ordered directory would
 *  attach answers to the wrong traces. */
export type SessionIdentity = {
  traceIds: string[];
  checklistId: string;
  annotator: Annotator;
};

// --- checklists ----------------------------------------------------------

export const ChecklistQuestionSchema = z
  .object({
    id: QuestionIdSchema,
    text: z.string().min(1),
    weight: z.number().finite().positive(),
    deleted: z.boolean(),
  })
  .strict();

export type ChecklistQuestion = z.infer<typeof ChecklistQuestionSchema>;

const uniqueQuestionIds = (questions: { id: string }[]) =>
  new Set(questions.map((question) => question.id)).size === questions.length;

export const ChecklistRevisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    checklistId: ChecklistIdSchema,
    name: z.string().min(1),
    version: z.number().int().positive(),
    parentVersion: z.number().int().positive().nullable(),
    createdAt: z.string().min(1),
    hash: ContentHashSchema,
    questions: z.array(ChecklistQuestionSchema).refine(uniqueQuestionIds, {
      message: "question ids must be unique within a revision",
    }),
  })
  .strict();

export type ChecklistRevision = z.infer<typeof ChecklistRevisionSchema>;

/** The pointer file. Deliberately not a copy of the revision: two copies of the
 *  same content eventually disagree, and the revision file is the truth. */
export const ChecklistCurrentSchema = z
  .object({
    schemaVersion: z.literal(1),
    checklistId: ChecklistIdSchema,
    version: z.number().int().positive(),
    hash: ContentHashSchema,
  })
  .strict();

export type ChecklistCurrent = z.infer<typeof ChecklistCurrentSchema>;

/** The editable file the user points `--checklist` at. Lineage fields are
 *  absent before first publication and written back afterwards, so a later
 *  open can tell an exact current definition from a stale one from a legal
 *  edit. */
export const ChecklistDefinitionSchema = z
  .object({
    name: z.string().min(1),
    checklistId: ChecklistIdSchema.optional(),
    version: z.number().int().positive().optional(),
    hash: ContentHashSchema.optional(),
    questions: z
      .array(
        z
          .object({
            id: QuestionIdSchema.optional(),
            text: z.string().min(1),
            weight: z.number().finite().positive().optional(),
            deleted: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ChecklistDefinition = z.infer<typeof ChecklistDefinitionSchema>;

/** @internal Named durable boundaries inside the store's multi-file
 *  operations. Tests interrupt execution at one of these and reopen, so
 *  recovery is exercised at every point a crash could actually land. Declared
 *  here rather than in labelStore.ts because checklist publication needs to
 *  signal them and must not import the store that imports it. */
export type LabelStoreFaultPoint =
  | "after-revision-temp-write"
  | "after-revision-rename"
  | "after-current-update"
  | "after-external-definition-sync"
  | "after-annotation-append";

export type FaultHook = (point: LabelStoreFaultPoint) => void;
