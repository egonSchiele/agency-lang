import * as fs from "fs";

import { completeAnnotation, type AnnotationDraft } from "@/runDirectory/annotations.js";
import { atomicWriteValidated } from "@/runDirectory/durableWrite.js";
import { openLabelStore, type LabelStore } from "@/runDirectory/labelStore.js";

import {
  normalizeDefinition,
  syncChecklistDefinition,
  type NormalizedDefinition,
  type PendingRevision,
  type PrepareChecklistResult,
} from "./checklist.js";
import { assertBindingIsCoherent, assertDraftMatches, type Draft } from "./draft.js";
import type { LabelingGroup } from "./group.js";
import { own } from "@/utils/ownProperty.js";

import { makeQuestionId, makeSessionId } from "./ids.js";
import {
  initSession,
  reduceSession,
  sessionSnapshot,
  signOffPayload,
  type ChecklistAnnotation,
  type SessionAction,
  type SessionItem,
  type SessionSnapshot,
  type SessionState,
} from "./session.js";
import {
  ChecklistDefinitionSchema,
  type Annotator,
  type ChecklistRevision,
  type FaultHook,
  type LabelStoreFaultPoint,
} from "./types.js";

export type MonotonicClock = { elapsedMs(): number };
export type WallClock = { nowIso(): string };
export type EntityIds = { questionId(): string };

export type OpenLabelingSessionArgs = {
  /** The runs being labelled, already resolved (`resolveLabelingGroup`). */
  group: LabelingGroup;
  checklistFile: string;
  annotator: Annotator;
  /** Start the cursor on this trace when present; an id that is not in the
   *  group is ignored. */
  focusTraceId?: string;
  reportWarning(message: string): void;
};

/** @internal */
export type ControllerFaultPoint =
  | LabelStoreFaultPoint
  | "after-pending-revision-save"
  | "after-draft-rebind"
  | "after-pending-annotation-save"
  | "after-annotation-commit-save";

/** @internal */
export type ControllerDependencies = {
  monotonicClock: MonotonicClock;
  wallClock: WallClock;
  ids: EntityIds;
  fault?(point: ControllerFaultPoint): void;
};

export type LabelingSessionController = {
  snapshot(): SessionSnapshot;
  dispatch(action: SessionAction): Promise<SessionSnapshot>;
  close(): Promise<void>;
};

const defaultDependencies: ControllerDependencies = {
  monotonicClock: { elapsedMs: () => Number(process.hrtime.bigint() / 1_000_000n) },
  wallClock: { nowIso: () => new Date().toISOString() },
  ids: { questionId: makeQuestionId },
};

export async function openLabelingSession(
  args: OpenLabelingSessionArgs,
): Promise<LabelingSessionController> {
  return createLabelingSessionOpener(defaultDependencies)(args);
}

/** @internal Test seam. Fault injection never reaches the application API. */
export function createLabelingSessionOpener(
  dependencies: ControllerDependencies,
): (args: OpenLabelingSessionArgs) => Promise<LabelingSessionController> {
  return async (args) => openSession(args, dependencies);
}

type Lifecycle = "open" | "failed" | "closed";

/**
 * What a brand-new draft is bound to.
 *
 * Unpublished is legal in exactly one case: this session is creating the
 * lineage, so there is no earlier revision to name. A pending revision that
 * expects a parent means the lineage already exists and the draft binds to
 * that parent until publication moves it forward.
 */
function bootstrapBinding(prepared: PrepareChecklistResult): Draft["binding"]["checklist"] {
  if (prepared.kind !== "publish") {
    return { kind: "published", version: prepared.revision.version, hash: prepared.revision.hash };
  }
  const { expectedParentVersion, expectedParentHash } = prepared.pending;
  if (expectedParentVersion === null || expectedParentHash === null) {
    return { kind: "unpublished" };
  }
  return { kind: "published", version: expectedParentVersion, hash: expectedParentHash };
}

async function openSession(
  args: OpenLabelingSessionArgs,
  dependencies: ControllerDependencies,
): Promise<LabelingSessionController> {
  // Parse the external file before touching the group: a malformed
  // checklist should not leave a lock behind or a half-created lineage.
  const rawDefinition = ChecklistDefinitionSchema.parse(
    JSON.parse(fs.readFileSync(args.checklistFile, "utf8")),
  );

  // Allocate lineage ids once, and write them back, before the session id is
  // derived from the checklist. A crash here leaves a complete definition
  // nobody has published, which the next open simply publishes.
  const definition = normalizeDefinition(rawDefinition);
  if (rawDefinition.checklistId === undefined) {
    syncChecklistDefinitionIds(args.checklistFile, definition);
  }

  const items: SessionItem[] = args.group.runs.map((run) => ({
    runDir: run.dir,
    traceId: run.traceId,
    fields: run.fields,
  }));
  const traceIds = items.map((item) => item.traceId);
  const sessionId = makeSessionId({
    traceIds,
    checklistId: definition.checklistId,
    annotator: args.annotator,
  });

  // The store owns every lock this session holds; it releases them itself
  // when opening fails, and `close()` releases them afterwards.
  const store = openLabelStore({
    group: args.group,
    identity: { sessionId, checklistId: definition.checklistId, annotator: args.annotator },
    reportWarning: args.reportWarning,
    fault: dependencies.fault as FaultHook | undefined,
  });
  try {
    const session = new LabelingSession({
      args,
      dependencies,
      store,
      sessionId,
      traceIds,
      definition,
      items,
    });
    session.open();
    const controller = session.controller();
    // Focus a specific example after recovery, so the draft cursor is durably
    // updated before the caller sees the controller.
    if (args.focusTraceId !== undefined) {
      await controller.dispatch({ kind: "focusItem", traceId: args.focusTraceId });
    }
    return controller;
  } catch (error) {
    // Any opening failure closes the store (idempotent), so a group that
    // cannot be opened does not stay locked against the next attempt.
    store.close();
    throw error;
  }
}

/**
 * Write the allocated identities back to the checklist file.
 *
 * This must be atomic even though nothing durable references the file yet.
 * The next open parses this file *before* it inspects the directory, so a
 * truncated half-write here is unrecoverable by the recovery path — and it
 * would have destroyed the only copy of the questions the author wrote.
 */
function syncChecklistDefinitionIds(checklistFile: string, definition: NormalizedDefinition): void {
  atomicWriteValidated({
    targetPath: checklistFile,
    value: definition,
    schema: ChecklistDefinitionSchema,
  });
}

type SessionConstruction = {
  args: OpenLabelingSessionArgs;
  dependencies: ControllerDependencies;
  store: LabelStore;
  sessionId: string;
  traceIds: string[];
  definition: NormalizedDefinition;
  items: SessionItem[];
};

/**
 * The one imperative boundary.
 *
 * Everything below it is pure or a narrow durable operation; everything above
 * it sees only `snapshot`, `dispatch` and `close`. Sequencing lives here so no
 * other caller can reproduce — or mis-reproduce — the order in which a
 * sign-off touches the draft, the checklist and the annotation log.
 */
class LabelingSession {
  private state!: SessionState;
  private draft!: Draft;
  private lifecycle: Lifecycle = "open";
  private intervalStartMs: number;
  private activeTraceId: string | null = null;

  constructor(private readonly parts: SessionConstruction) {
    this.intervalStartMs = parts.dependencies.monotonicClock.elapsedMs();
  }

  open(): void {
    const { store, definition } = this.parts;
    const snapshot = store.readSession();

    this.draft = (snapshot.draft as Draft | null) ?? this.bootstrapDraft();
    assertDraftMatches(this.draft, {
      traceIds: this.parts.traceIds,
      checklistId: definition.checklistId,
      annotator: this.parts.args.annotator,
    });
    assertBindingIsCoherent(this.draft);

    const revision = this.recoverChecklist();
    this.recoverAnnotation();

    this.state = initSession({
      items: this.parts.items,
      revision,
      judgements: store.readSession().judgements,
      annotator: this.parts.args.annotator,
    });
    this.overlayDraft();
    this.startInterval();
  }

  /** A fresh session begins bound to nothing only when its own version-1
   *  revision is still pending; that pairing is enforced on every load. */
  private bootstrapDraft(): Draft {
    const prepared = this.parts.store.prepareChecklist(this.parts.definition);
    const pendingRevision: PendingRevision | null =
      prepared.kind === "publish" ? prepared.pending : null;

    return {
      schemaVersion: 1,
      sessionId: this.parts.sessionId,
      binding: {
        traceIds: this.parts.traceIds,
        checklistId: this.parts.definition.checklistId,
        checklist: bootstrapBinding(prepared),
        annotator: this.parts.args.annotator,
      },
      currentIndex: 0,
      answersByTraceId: {},
      notesByTraceId: {},
      reviewedByTraceId: {},
      stagedQuestions: null,
      pendingRevision,
      pendingAnnotation: null,
      activeMsByTraceId: {},
    };
  }

  /**
   * Publish anything the draft still owes, then bind to the result.
   *
   * The order is revision first, then annotation, because an annotation names
   * the revision it was made against and must never reference one that is not
   * durable yet.
   */
  private recoverChecklist(): ChecklistRevision {
    const { store, definition } = this.parts;
    const pending = this.draft.pendingRevision;

    if (pending !== null) {
      this.saveDraft();
      this.fault("after-pending-revision-save");
      const published = store.publishRevision(pending, this.parts.args.checklistFile);
      this.draft = {
        ...this.draft,
        binding: {
          ...this.draft.binding,
          checklist: {
            kind: "published",
            version: published.revision.version,
            hash: published.revision.hash,
          },
        },
        pendingRevision: null,
        stagedQuestions: null,
      };
      this.saveDraft();
      this.fault("after-draft-rebind");
      return published.revision;
    }

    // Nothing owed: reconcile whatever the external file now says against the
    // published lineage.
    const prepared = store.prepareChecklist(definition);
    if (prepared.kind === "current") {
      return prepared.revision;
    }
    if (prepared.kind === "refresh-definition") {
      store.syncChecklistDefinition(this.parts.args.checklistFile, prepared.revision);
      return prepared.revision;
    }
    this.draft = { ...this.draft, pendingRevision: prepared.pending };
    return this.recoverChecklist();
  }

  /**
   * Finish a sign-off that was interrupted, all the way.
   *
   * Appending the row and clearing the pending marker is not enough: a normal
   * sign-off also advances the cursor, records what was reviewed, and resets
   * that trace's timer. Stopping halfway leaves the person back on an item
   * they already judged, with its old accumulated time still running — so
   * recovery applies the same post-append transition the live path does.
   */
  private recoverAnnotation(): ChecklistAnnotation | undefined {
    const pending = this.draft.pendingAnnotation;
    if (pending === null) {
      return undefined;
    }
    this.parts.store.appendAnnotation(pending);
    this.draft = {
      ...this.draft,
      pendingAnnotation: null,
      reviewedByTraceId: {
        ...this.draft.reviewedByTraceId,
        [pending.traceId]: Object.keys(pending.answers),
      },
      answersByTraceId: {
        ...this.draft.answersByTraceId,
        [pending.traceId]: {
          ...own(this.draft.answersByTraceId, pending.traceId),
          ...pending.answers,
        },
      },
      notesByTraceId: { ...this.draft.notesByTraceId, [pending.traceId]: pending.note },
      activeMsByTraceId: { ...this.draft.activeMsByTraceId, [pending.traceId]: 0 },
      currentIndex: Math.min(
        this.draft.currentIndex + 1,
        Math.max(this.parts.traceIds.length - 1, 0),
      ),
    };
    this.saveDraft();
    this.fault("after-annotation-commit-save");
    return pending;
  }

  private overlayDraft(): void {
    this.state = {
      ...this.state,
      answersByTraceId: { ...this.state.answersByTraceId, ...this.draft.answersByTraceId },
      notesByTraceId: { ...this.state.notesByTraceId, ...this.draft.notesByTraceId },
      reviewedByTraceId: { ...this.state.reviewedByTraceId, ...this.draft.reviewedByTraceId },
      stagedQuestions: this.draft.stagedQuestions,
      itemIndex: Math.min(this.draft.currentIndex, Math.max(this.state.items.length - 1, 0)),
    };
  }

  controller(): LabelingSessionController {
    return {
      snapshot: () => sessionSnapshot(this.state),
      dispatch: async (action) => this.dispatch(action),
      close: async () => this.close(),
    };
  }

  private async dispatch(action: SessionAction): Promise<SessionSnapshot> {
    this.assertUsable();
    try {
      if (action.kind === "signOff") {
        this.signOff();
      } else if (action.kind === "submitEditor") {
        this.submitEditor();
      } else {
        this.flushTiming();
        this.state = reduceSession(this.state, action);
        this.persistState();
      }
      this.startInterval();
      return sessionSnapshot(this.state);
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  private submitEditor(): void {
    const editor = this.state.editor;
    if (editor.kind === "none") {
      return;
    }
    this.flushTiming();
    if (editor.kind === "question") {
      const text = editor.draft.trim();
      this.state =
        text.length === 0
          ? reduceSession(this.state, { kind: "cancelEditor" })
          : reduceSession(this.state, {
              kind: "questionAdded",
              question: {
                id: this.parts.dependencies.ids.questionId(),
                text,
                weight: 1,
                deleted: false,
              },
            });
    } else {
      const item = this.state.items[this.state.itemIndex];
      this.state =
        item === undefined
          ? reduceSession(this.state, { kind: "cancelEditor" })
          : reduceSession(this.state, {
              kind: "noteSaved",
              traceId: item.traceId,
              note: editor.draft,
            });
    }
    this.persistState();
  }

  /**
   * The commit protocol, in the one place that may run it.
   *
   * Timing is flushed first so a crash cannot lose it; the revision is
   * published before the annotation because the annotation names it; and the
   * complete annotation is written to the draft before it is appended, so a
   * crash between the two replays the same row rather than writing a second
   * judgement. The id is derived from the row's content, so even a replay
   * that rebuilt the row would land on the same id.
   */
  private signOff(): void {
    this.flushTiming();
    this.persistState();

    if (this.state.stagedQuestions !== null) {
      this.publishStagedQuestions();
    }

    const payload = signOffPayload(this.state);
    if (payload === undefined) {
      return;
    }
    const draft: AnnotationDraft = {
      traceId: payload.traceId,
      annotator: this.parts.args.annotator,
      sessionId: this.parts.sessionId,
      kind: "checklist",
      checklist: this.state.revision.checklistId,
      version: this.state.revision.version,
      hash: this.state.revision.hash,
      answers: payload.answers,
      note: payload.note,
      activeMs: own(this.draft.activeMsByTraceId, payload.traceId) ?? 0,
    };
    const row = completeAnnotation(
      draft,
      this.parts.dependencies.wallClock.nowIso(),
    ) as ChecklistAnnotation;

    this.draft = { ...this.draft, pendingAnnotation: row };
    this.saveDraft();
    this.fault("after-pending-annotation-save");

    this.parts.store.appendAnnotation(row);

    this.state = reduceSession(this.state, { kind: "annotationCommitted", row });
    this.draft = {
      ...this.draft,
      pendingAnnotation: null,
      // A later relabel of this trace starts its own clock.
      activeMsByTraceId: { ...this.draft.activeMsByTraceId, [payload.traceId]: 0 },
    };
    this.persistState();
    this.fault("after-annotation-commit-save");
  }

  private publishStagedQuestions(): void {
    const staged = this.state.stagedQuestions;
    if (staged === null) {
      return;
    }
    const definition: NormalizedDefinition = {
      name: this.state.revision.name,
      checklistId: this.state.revision.checklistId,
      version: this.state.revision.version,
      hash: this.state.revision.hash,
      questions: staged,
    };
    const prepared = this.parts.store.prepareChecklist(definition);
    if (prepared.kind !== "publish") {
      this.state = reduceSession(this.state, {
        kind: "revisionAdopted",
        revision: prepared.revision,
      });
      return;
    }
    this.draft = { ...this.draft, pendingRevision: prepared.pending };
    this.saveDraft();
    this.fault("after-pending-revision-save");

    const published = this.parts.store.publishRevision(
      prepared.pending,
      this.parts.args.checklistFile,
    );
    this.state = reduceSession(this.state, {
      kind: "revisionAdopted",
      revision: published.revision,
    });
    this.draft = {
      ...this.draft,
      binding: {
        ...this.draft.binding,
        checklist: {
          kind: "published",
          version: published.revision.version,
          hash: published.revision.hash,
        },
      },
      pendingRevision: null,
      stagedQuestions: null,
    };
    this.saveDraft();
    this.fault("after-draft-rebind");
  }

  /** Accumulate the time since the last dispatch against the item that was
   *  active for it. Only elapsed milliseconds are persisted: storing a
   *  monotonic anchor would count the hours a paused session spent closed. */
  private flushTiming(): void {
    const now = this.parts.dependencies.monotonicClock.elapsedMs();
    const traceId = this.activeTraceId;
    if (traceId !== null) {
      const previous = own(this.draft.activeMsByTraceId, traceId) ?? 0;
      this.draft = {
        ...this.draft,
        activeMsByTraceId: {
          ...this.draft.activeMsByTraceId,
          [traceId]: previous + Math.max(0, now - this.intervalStartMs),
        },
      };
    }
    this.intervalStartMs = now;
  }

  private startInterval(): void {
    this.intervalStartMs = this.parts.dependencies.monotonicClock.elapsedMs();
    this.activeTraceId = this.state.items[this.state.itemIndex]?.traceId ?? null;
  }

  /** Fold the live state back into the draft and write it. */
  private persistState(): void {
    this.draft = {
      ...this.draft,
      currentIndex: this.state.itemIndex,
      answersByTraceId: this.state.answersByTraceId,
      notesByTraceId: this.state.notesByTraceId,
      reviewedByTraceId: this.state.reviewedByTraceId,
      stagedQuestions: this.state.stagedQuestions,
    };
    this.saveDraft();
  }

  private saveDraft(): void {
    this.parts.store.saveDraft(this.draft);
  }

  private fault(point: ControllerFaultPoint): void {
    this.parts.dependencies.fault?.(point);
  }

  private assertUsable(): void {
    if (this.lifecycle === "closed") {
      throw new Error("This labelling session is closed");
    }
    if (this.lifecycle === "failed") {
      throw new Error("This labelling session failed and can no longer be used");
    }
  }

  /** A persistence failure makes further dispatches unsafe: the draft and the
   *  live state may disagree, and writing more would compound it. */
  private fail(): void {
    this.lifecycle = "failed";
    this.parts.store.close();
  }

  private async close(): Promise<void> {
    if (this.lifecycle === "closed") {
      return;
    }
    const wasOpen = this.lifecycle === "open";
    this.lifecycle = "closed";
    let primary: unknown;
    try {
      if (wasOpen) {
        this.flushTiming();
        this.persistState();
      }
    } catch (error) {
      primary = error;
    }
    try {
      this.parts.store.close();
    } catch (error) {
      if (primary === undefined) {
        primary = error;
      } else {
        (primary as Error).message +=
          `; also failed to close the label store: ${(error as Error).message}`;
      }
    }
    if (primary !== undefined) {
      throw primary;
    }
  }
}
