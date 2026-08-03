import * as fs from "fs";
import * as path from "path";

import { canonicalize } from "@/utils/canonicalize.js";

import { checklistHashOf, makeChecklistId, makeQuestionId } from "./ids.js";
import { atomicWriteValidated } from "./jsonl.js";
import {
  ChecklistCurrentSchema,
  ChecklistDefinitionSchema,
  ChecklistRevisionSchema,
  type ChecklistCurrent,
  type ChecklistDefinition,
  type ChecklistQuestion,
  type ChecklistRevision,
} from "./types.js";

const DEFAULT_QUESTION_WEIGHT = 1;

/** A definition with every optional field filled in. Not a separate schema:
 *  it is a `ChecklistDefinition` whose optional fields are all present. */
export type NormalizedDefinition = ChecklistDefinition & {
  checklistId: string;
  questions: (ChecklistQuestion)[];
};

/** @internal Prepared but not yet durable. Carries the parent it was computed
 *  against so publication can refuse to land on a lineage that moved. */
export type PendingRevision = {
  revision: ChecklistRevision;
  expectedParentVersion: number | null;
  expectedParentHash: string | null;
};

/** @internal */
export type PublishRevisionResult = {
  revision: ChecklistRevision;
  replayed: boolean;
};

export type PrepareChecklistResult =
  | { kind: "current"; revision: ChecklistRevision }
  | { kind: "refresh-definition"; revision: ChecklistRevision }
  | { kind: "publish"; pending: PendingRevision };

// --- paths ---------------------------------------------------------------

function lineageDir(storeDir: string, checklistId: string): string {
  return path.join(storeDir, "checklists", checklistId);
}

function revisionPath(storeDir: string, checklistId: string, version: number): string {
  return path.join(lineageDir(storeDir, checklistId), `${version}.json`);
}

function currentPath(storeDir: string, checklistId: string): string {
  return path.join(lineageDir(storeDir, checklistId), "current.json");
}

// --- normalization -------------------------------------------------------

/**
 * Fill in the identities and defaults a definition may omit.
 *
 * Allocating ids is separated from publishing so it can happen once, before a
 * session id is derived from the checklist lineage. A crash after this write
 * leaves a complete definition nobody has published yet, which the next open
 * simply publishes.
 */
export function normalizeDefinition(definition: ChecklistDefinition): NormalizedDefinition {
  const parsed = ChecklistDefinitionSchema.parse(definition);
  const seen: Record<string, true> = Object.create(null);
  const questions = parsed.questions.map((question) => {
    const id = question.id ?? makeQuestionId();
    if (seen[id] === true) {
      throw new Error(`Checklist "${parsed.name}" repeats question id "${id}"; ids must be unique`);
    }
    seen[id] = true;
    return {
      id,
      text: question.text,
      weight: question.weight ?? DEFAULT_QUESTION_WEIGHT,
      deleted: question.deleted ?? false,
    };
  });
  return { ...parsed, checklistId: parsed.checklistId ?? makeChecklistId(), questions };
}

/** Build the revision a definition describes, sealed with its content hash. */
export function revisionFromDefinition(args: {
  definition: NormalizedDefinition;
  version: number;
  parentVersion: number | null;
  createdAt: string;
}): ChecklistRevision {
  const base = {
    schemaVersion: 1 as const,
    checklistId: args.definition.checklistId,
    name: args.definition.name,
    version: args.version,
    parentVersion: args.parentVersion,
    createdAt: args.createdAt,
    questions: args.definition.questions,
  };
  const hash = checklistHashOf({
    checklistId: base.checklistId,
    version: base.version,
    questions: base.questions,
  });
  return ChecklistRevisionSchema.parse({ ...base, hash });
}

// --- the state machine ---------------------------------------------------

/**
 * Decide what an external definition means relative to the published lineage.
 *
 * Four outcomes, and the interesting one is the refusal. A definition based on
 * an older revision AND edited is ambiguous: publishing it would silently
 * discard whatever changed in between. There is no safe automatic answer, so
 * it stops.
 */
export function prepareRevision(args: {
  definition: NormalizedDefinition;
  current: ChecklistRevision | undefined;
  now?: string;
}): PrepareChecklistResult {
  const createdAt = args.now ?? new Date().toISOString();
  const { definition, current } = args;

  if (current === undefined) {
    assertQuestionsWellFormed(definition.questions);
    return {
      kind: "publish",
      pending: {
        revision: revisionFromDefinition({ definition, version: 1, parentVersion: null, createdAt }),
        expectedParentVersion: null,
        expectedParentHash: null,
      },
    };
  }

  if (definition.checklistId !== current.checklistId) {
    throw new Error(
      `Checklist file names lineage "${definition.checklistId}" but the store holds ` +
      `"${current.checklistId}". A checklist file belongs to one lineage.`,
    );
  }
  if (definition.version === undefined || definition.hash === undefined) {
    throw new Error(
      `Checklist "${definition.checklistId}" has an id but no recorded version. ` +
      `The file is partly written; restore it from the store or start a new checklist.`,
    );
  }
  if (definition.version > current.version) {
    throw new Error(
      `Checklist file claims version ${definition.version} but the store's newest is ` +
      `${current.version}. The store is the record; a file cannot be ahead of it.`,
    );
  }

  const basis = definition.version === current.version ? current : undefined;
  const unchangedFromBasis = basis !== undefined && sameQuestions(definition.questions, basis.questions);

  if (basis !== undefined) {
    if (definition.hash !== basis.hash) {
      throw new Error(
        `Checklist file records version ${definition.version} with hash ${definition.hash}, ` +
        `which does not match the stored revision's hash ${basis.hash}.`,
      );
    }
    if (unchangedFromBasis) {
      return { kind: "current", revision: current };
    }
    assertQuestionsEvolveLegally(current.questions, definition.questions);
    return {
      kind: "publish",
      pending: {
        revision: revisionFromDefinition({
          definition, version: current.version + 1, parentVersion: current.version, createdAt,
        }),
        expectedParentVersion: current.version,
        expectedParentHash: current.hash,
      },
    };
  }

  // The definition is behind current. Only safe if it was not also edited,
  // which we can tell from its own recorded hash.
  const recordedHash = checklistHashOf({
    checklistId: definition.checklistId,
    version: definition.version,
    questions: definition.questions,
  });
  if (recordedHash !== definition.hash) {
    throw new Error(
      `Checklist file is based on version ${definition.version} but has been edited since, ` +
      `while the store has moved on to version ${current.version}. This is ambiguous: ` +
      `publishing it would discard whatever changed in between. Refresh the file from the ` +
      `store and reapply your edit.`,
    );
  }
  return { kind: "refresh-definition", revision: current };
}

function assertQuestionsWellFormed(questions: readonly ChecklistQuestion[]): void {
  const seen: Record<string, true> = Object.create(null);
  for (const question of questions) {
    if (!Number.isFinite(question.weight) || question.weight <= 0) {
      throw new Error(`Question "${question.id}" has weight ${question.weight}; weights must be finite and positive`);
    }
    if (seen[question.id] === true) {
      throw new Error(`Duplicate question id "${question.id}"`);
    }
    seen[question.id] = true;
  }
}

/**
 * A question id names a MEANING. Text may not change under one, and a question
 * may never disappear — removing it would strand every answer recorded against
 * it. Soft-delete instead.
 */
function assertQuestionsEvolveLegally(
  previous: readonly ChecklistQuestion[],
  next: readonly ChecklistQuestion[],
): void {
  assertQuestionsWellFormed(next);
  const nextById: Record<string, ChecklistQuestion> = Object.create(null);
  for (const question of next) {
    nextById[question.id] = question;
  }
  for (const before of previous) {
    const after = nextById[before.id];
    if (after === undefined) {
      throw new Error(
        `Question "${before.id}" ("${before.text}") was removed. Questions are never removed — ` +
        `soft-delete it so its recorded answers keep their meaning.`,
      );
    }
    if (after.text !== before.text) {
      throw new Error(
        `Question "${before.id}" changed text from "${before.text}" to "${after.text}". ` +
        `An id names a meaning; changing the text would silently change what past answers meant. ` +
        `Soft-delete this question and add a new one instead.`,
      );
    }
  }
}

function sameQuestions(left: readonly ChecklistQuestion[], right: readonly ChecklistQuestion[]): boolean {
  return canonicalize(left.map((question) => ({ ...question }))) ===
    canonicalize(right.map((question) => ({ ...question })));
}

// --- publication ---------------------------------------------------------

/**
 * Make a prepared revision durable, idempotently.
 *
 * Order matters and is owned here alone: immutable revision file, then the
 * current pointer, then the external definition. Re-running after a crash at
 * any point converges, because each step accepts an identical existing result
 * as a replay.
 */
export function publishPendingRevision(args: {
  storeDir: string;
  pending: PendingRevision;
  definitionPath: string;
}): PublishRevisionResult {
  const revision = ChecklistRevisionSchema.parse(args.pending.revision);
  const existingCurrent = readCurrentPointer(args.storeDir, revision.checklistId);
  assertParentStillMatches(args.pending, existingCurrent, revision);

  const target = revisionPath(args.storeDir, revision.checklistId, revision.version);
  let replayed = false;
  if (fs.existsSync(target)) {
    const stored = readRevision(args.storeDir, revision.checklistId, revision.version);
    if (canonicalize(stored) !== canonicalize(revision)) {
      throw new Error(
        `Revision ${revision.version} of "${revision.checklistId}" already exists with different ` +
        `content. Published revisions are immutable.`,
      );
    }
    replayed = true;
  } else {
    atomicWriteValidated({ targetPath: target, value: revision, schema: ChecklistRevisionSchema });
  }

  const pointer: ChecklistCurrent = {
    schemaVersion: 1,
    checklistId: revision.checklistId,
    version: revision.version,
    hash: revision.hash,
  };
  atomicWriteValidated({
    targetPath: currentPath(args.storeDir, revision.checklistId),
    value: pointer,
    schema: ChecklistCurrentSchema,
  });
  syncChecklistDefinition({ definitionPath: args.definitionPath, revision });

  return { revision, replayed };
}

/** A pending revision computed against a parent that has since moved would
 *  overwrite whatever landed in between. Accept only the parent it expected,
 *  or the already-published result of this same pending revision. */
function assertParentStillMatches(
  pending: PendingRevision,
  current: ChecklistCurrent | undefined,
  revision: ChecklistRevision,
): void {
  if (current === undefined) {
    if (pending.expectedParentVersion === null) {
      return;
    }
    throw new Error(
      `Revision ${revision.version} expects parent ${pending.expectedParentVersion}, but the ` +
      `store has no published revision for "${revision.checklistId}".`,
    );
  }
  const isReplayOfThis = current.version === revision.version && current.hash === revision.hash;
  const isOnExpectedParent = current.version === pending.expectedParentVersion &&
    current.hash === pending.expectedParentHash;
  if (isReplayOfThis || isOnExpectedParent) {
    return;
  }
  throw new Error(
    `Revision ${revision.version} of "${revision.checklistId}" expects to follow version ` +
    `${pending.expectedParentVersion}, but current is version ${current.version}. ` +
    `The lineage moved; recompute the change against current.`,
  );
}

/** Bring the external file in line with a published revision. */
export function syncChecklistDefinition(args: {
  definitionPath: string;
  revision: ChecklistRevision;
}): void {
  const definition: ChecklistDefinition = {
    name: args.revision.name,
    checklistId: args.revision.checklistId,
    version: args.revision.version,
    hash: args.revision.hash,
    questions: args.revision.questions.map((question) => ({ ...question })),
  };
  atomicWriteValidated({
    targetPath: args.definitionPath,
    value: definition,
    schema: ChecklistDefinitionSchema,
  });
}

// --- reading -------------------------------------------------------------

export function readCurrentPointer(storeDir: string, checklistId: string): ChecklistCurrent | undefined {
  const file = currentPath(storeDir, checklistId);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return ChecklistCurrentSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function readRevision(storeDir: string, checklistId: string, version: number): ChecklistRevision {
  const file = revisionPath(storeDir, checklistId, version);
  if (!fs.existsSync(file)) {
    throw new Error(`Checklist revision not found: ${file}`);
  }
  return ChecklistRevisionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Every published revision id for a lineage, ascending. Used by store
 *  validation to check lineage continuity. */
export function listRevisionVersions(storeDir: string, checklistId: string): number[] {
  const dir = lineageDir(storeDir, checklistId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => Number.parseInt(name.replace(".json", ""), 10))
    .sort((left, right) => left - right);
}
