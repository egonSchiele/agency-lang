import { z } from "zod";

import type { JsonValue } from "@/utils/canonicalize.js";

export type { JsonValue };

/** Recursively readonly. The store hands these out so a caller cannot mutate
 *  loaded rows and silently desynchronise them from what is on disk. */
export type DeepReadonly<Value> =
  Value extends (infer Element)[] ? readonly DeepReadonly<Element>[] :
  Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> } :
  Value;

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

// --- identifier shapes ---------------------------------------------------

/** Digest length for hashed identities, in hex characters (sha256). */
const DIGEST_HEX_LENGTH = 64;
/** Random suffix length for entity ids that are allocated, not derived. */
export const QUESTION_ID_RANDOM_LENGTH = 10;
export const CHECKLIST_ID_RANDOM_LENGTH = 10;
export const ANNOTATION_ID_RANDOM_LENGTH = 12;

const hexDigest = `[a-f0-9]{${DIGEST_HEX_LENGTH}}`;
/** Anchored and filesystem-safe: these ids become path segments and file names. */
export const OutputIdSchema = z.string().regex(new RegExp(`^out_${hexDigest}$`));
export const SessionIdSchema = z.string().regex(new RegExp(`^session_${hexDigest}$`));
export const ContentHashSchema = z.string().regex(new RegExp(`^sha256:${hexDigest}$`));
export const ChecklistIdSchema = z.string().regex(/^cl_[A-Za-z0-9_-]+$/);
export const QuestionIdSchema = z.string().regex(/^q_[A-Za-z0-9_-]+$/);
export const AnnotationIdSchema = z.string().regex(/^ann_[A-Za-z0-9_-]+$/);

// --- identities ----------------------------------------------------------

/** What makes one captured output distinct. Deliberately excludes any path or
 *  directory name: a run directory can be renamed, copied, or share a basename
 *  with an unrelated run, and none of that changes which execution this was. */
export type ExecutionIdentity = {
  traceId: string;
  inputId: string;
  finalOutputIndex: number;
};

export const ExecutionIdentitySchema = z.object({
  traceId: z.string().min(1),
  inputId: z.string().min(1),
  finalOutputIndex: z.number().int().nonnegative(),
}).strict();

export type Annotator = {
  kind: "human" | "llm" | "code";
  id: string;
};

export const AnnotatorSchema = z.object({
  kind: z.enum(["human", "llm", "code"]),
  id: z.string().min(1),
}).strict();

/** Everything a resumable session is bound to. Order of `outputIds` is part of
 *  the identity: a draft resumed against a differently ordered source would
 *  attach answers to the wrong outputs. */
export type SessionIdentity = {
  outputIds: string[];
  checklistId: string;
  annotator: Annotator;
};

// --- durable rows --------------------------------------------------------

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
}).strict();

export type Manifest = z.infer<typeof ManifestSchema>;

export const ChecklistQuestionSchema = z.object({
  id: QuestionIdSchema,
  text: z.string().min(1),
  weight: z.number().finite().positive(),
  deleted: z.boolean(),
}).strict();

export type ChecklistQuestion = z.infer<typeof ChecklistQuestionSchema>;

const uniqueQuestionIds = (questions: { id: string }[]) =>
  new Set(questions.map((question) => question.id)).size === questions.length;

export const ChecklistRevisionSchema = z.object({
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
}).strict();

export type ChecklistRevision = z.infer<typeof ChecklistRevisionSchema>;

/** The pointer file. Deliberately not a copy of the revision: two copies of the
 *  same content eventually disagree, and the revision file is the truth. */
export const ChecklistCurrentSchema = z.object({
  schemaVersion: z.literal(1),
  checklistId: ChecklistIdSchema,
  version: z.number().int().positive(),
  hash: ContentHashSchema,
}).strict();

export type ChecklistCurrent = z.infer<typeof ChecklistCurrentSchema>;

/** The editable file the user points `--checklist` at. Lineage fields are
 *  absent before first publication and written back afterwards, so a later
 *  open can tell an exact current definition from a stale one from a legal
 *  edit. */
export const ChecklistDefinitionSchema = z.object({
  name: z.string().min(1),
  checklistId: ChecklistIdSchema.optional(),
  version: z.number().int().positive().optional(),
  hash: ContentHashSchema.optional(),
  questions: z.array(z.object({
    id: QuestionIdSchema.optional(),
    text: z.string().min(1),
    weight: z.number().finite().positive().optional(),
    deleted: z.boolean().optional(),
  }).strict()).min(1),
}).strict();

export type ChecklistDefinition = z.infer<typeof ChecklistDefinitionSchema>;

export const CorpusInputSchema = z.object({
  inputId: z.string().min(1),
  task: JsonValueSchema,
}).strict();

export type CorpusInput = z.infer<typeof CorpusInputSchema>;

export const CorpusProvenanceSchema = z.object({
  runStartedAtMs: z.number().finite().nullable(),
  agent: JsonValueSchema,
  models: z.array(z.string()),
}).strict();

export type CorpusProvenance = z.infer<typeof CorpusProvenanceSchema>;

export const CorpusRowSchema = z.object({
  schemaVersion: z.literal(1),
  outputId: OutputIdSchema,
  contentHash: ContentHashSchema,
  capturedAt: z.string().min(1),
  execution: ExecutionIdentitySchema,
  input: CorpusInputSchema,
  value: JsonValueSchema,
  /** The display projection. Always present so the labelled artifact is
   *  exactly what was shown, even if the projection rule changes later. */
  text: z.string(),
  provenance: CorpusProvenanceSchema,
}).strict();

export type CorpusRow = z.infer<typeof CorpusRowSchema>;

export const AnnotationRowSchema = z.object({
  schemaVersion: z.literal(1),
  annotationId: AnnotationIdSchema,
  outputId: OutputIdSchema,
  annotator: AnnotatorSchema,
  checklistId: ChecklistIdSchema,
  checklistVersion: z.number().int().positive(),
  checklistHash: ContentHashSchema,
  createdAt: z.string().min(1),
  activeMs: z.number().finite().nonnegative(),
  coveredQuestionIds: z.array(QuestionIdSchema).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: "coveredQuestionIds must not repeat a question" },
  ),
  /** An explicit boolean per covered question. A missing key means "not
   *  judged" and is rejected as a store invariant, not here, because that
   *  check is cross-field. */
  answers: z.record(QuestionIdSchema, z.boolean()),
  note: z.string(),
}).strict();

export type AnnotationRow = z.infer<typeof AnnotationRowSchema>;

/** @internal Named durable boundaries inside the store's multi-file
 *  operations. Tests interrupt execution at one of these and reopen, so
 *  recovery is exercised at every point a crash could actually land. Declared
 *  here rather than in store.ts because checklist publication needs to signal
 *  them and must not import the store that imports it. */
export type LabelStoreFaultPoint =
  | "after-revision-temp-write"
  | "after-revision-rename"
  | "after-current-update"
  | "after-external-definition-sync"
  | "after-annotation-append";

export type FaultHook = (point: LabelStoreFaultPoint) => void;
