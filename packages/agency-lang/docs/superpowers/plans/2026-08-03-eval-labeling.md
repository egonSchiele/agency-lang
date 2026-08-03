# Eval Labeling Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, append-only store of human judgements about agent outputs, plus an `agency eval label` command with a terminal checklist UI for producing them.

**Architecture:** Pure domain functions own `SessionState`, reducer events, effective-answer folding, item status, and scoring. One import-safe labeling-session controller owns capture, locking, drafts, checklist reconciliation/publication, annotation commits, recovery, and active-time accounting. The TUI sees only the controller's declarative `snapshot()`, `dispatch(action)`, and `close()` API plus renderer helpers; raw JSONL and filesystem writers remain private below the store/controller boundary. JSONL files are parsed and indexed once when the store opens, so sign-off replay checks and appends stay O(1).

**Tech Stack:** TypeScript, Node `fs`, Zod 4 for durable schemas, `nanoid` for random ids, Vitest, and Commander. No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-08-02-eval-labeling-design.md` (revision 2).
**Prototype to consult, not copy:** branch `adit/proto-eval-label`, worktree `worktree-label-prototype`, files `packages/agency-lang/lib/eval/label/labelSession.ts` and `PROTOTYPE-labelTui.ts`.

## Global Constraints

- Do not edit `docs/site/**` or `CHANGELOG.md`.
- Use types, plain objects, arrays, static imports, descriptive names, block-form conditionals, and functions under 100 lines.
- Do not use nested ternaries, conditional object spreads, silent catches, one-line `if` statements, single-character variables, or magic numeric id lengths.
- Every production snippet in this plan follows `docs/dev/anti-patterns.md`; the final audit is a backstop, not the first enforcement point.
- Imperative loops are appropriate inside JSONL parsing, validation, state machines, and terminal I/O. Keep them private behind declarative domain/controller operations.
- Every durable object uses `schemaVersion: z.literal(1)` and a strict Zod 4 schema. Use `z.record(z.string(), valueSchema)`.
- Validate every durable value before writing. On opening a store, verify hashes, path identity, revision lineage/current pointers, exact answer coverage, all snapshots, corpus hashes, and references.
- A missing answer means “not judged.” A stale item's score is `null`.
- Run focused tests after each task. The broader checks in Task 12 are explicitly allowed; do not run the full Agency execution suite.
- Write each commit message to `/tmp/msg.txt`, then use `git commit -F /tmp/msg.txt`. Never force-push or amend.
- Task 12 stops for owner approval before any push or PR creation.

## File Structure and Boundaries

| File | Responsibility and visibility |
|---|---|
| `lib/utils/canonicalize.ts` | Neutral canonical JSON utility lifted from trace runtime |
| `lib/runtime/trace/canonicalize.ts` | Re-export neutral canonicalizer for compatibility |
| `lib/eval/label/types.ts` | Extracted durable/domain types and strict schemas |
| `lib/eval/label/ids.ts` | Stable occurrence/session ids, hashes, random entity ids |
| `lib/eval/label/jsonl.ts` | Private opened JSONL log: validate/index once, then exact O(1) replay/append |
| `lib/eval/label/checklist.ts` | Private checklist revision validation/publication state machine |
| `lib/eval/label/corpus.ts` | Private corpus validation and append primitives |
| `lib/eval/label/capture.ts` | Strict source-occurrence capture state machine and shared final selector |
| `lib/eval/label/annotations.ts` | Pure effective-answer fold, status, and score; private append helper |
| `lib/eval/label/lock.ts` | Exclusive ownership-token lock |
| `lib/eval/label/store.ts` | Validated store facade; never exposes mutable raw arrays or raw writers |
| `lib/eval/label/session.ts` | Pure `SessionState`, reducer/actions/selectors, draft overlay |
| `lib/eval/label/draft.ts` | Strict draft schema and private atomic draft persistence |
| `lib/eval/label/controller.ts` | Only imperative application API: open, snapshot, dispatch, close, recovery |
| `lib/eval/label/labelTui.ts` | Import-safe terminal adapter and pure render helpers |
| `lib/cli/eval/label.ts` | CLI command implementation, matching existing `lib/cli/eval/` layout |
| `lib/config.ts` | `eval.labelStore` type and schema |
| `scripts/agency.ts` | Commander registration |
| `docs/dev/eval-labeling.md` | Developer protocol and recovery documentation |

Only `controller.ts` may compose capture, store writes, drafts, checklist publication, annotation publication, timing, and recovery. `labelTui.ts` must not import `draft.ts`, `checklist.ts`, `corpus.ts`, `capture.ts`, `lock.ts`, `store.ts`, or raw append functions. The final `openStore` facade returns deep-readonly session/checklist projections and exact domain operations (`captureSource`, `prepareChecklist`, `syncChecklistDefinition`, `publishRevision`, `appendAnnotation`, `saveDraft`), not mutable arrays, raw file handles, or unrestricted append functions.

---

### Task 1: Strict durable values, canonical hashes, and identities

**Files:**
- Create: `lib/utils/canonicalize.ts`
- Modify: `lib/runtime/trace/canonicalize.ts`
- Create: `lib/eval/label/types.ts`
- Create: `lib/eval/label/ids.ts`
- Test: `lib/eval/label/ids.test.ts`

**Interfaces:**
- Produces `JsonValue`, recursive `DeepReadonly<Value>`, `CorpusInput`, `CorpusProvenance`, `CorpusRow`, `ChecklistDefinition`, `ChecklistCurrent`, `ChecklistQuestion`, `ChecklistRevision`, `AnnotationRow`, `Manifest`, `Annotator`, and their strict schemas.
- Produces `ExecutionIdentity` and `SessionIdentity`, plus `canonicalize(value: JsonValue): string`, `makeOutputId(identity: ExecutionIdentity): string`, `contentHashOf(input: CorpusInput, value: JsonValue): string`, and `makeSessionId(identity: SessionIdentity): string`.
- Entity id lengths use named constants such as `QUESTION_ID_RANDOM_LENGTH`; path ids match anchored filesystem-safe regexes.

- [ ] **Step 1: Write failing schema and identity tests**

Test exact `schemaVersion: 1`, unknown-key rejection at every nested level, JSON values only, safe path ids, two traces with the same run-directory basename, moved sources retaining identity, selected output index changing identity, canonical object key order, and stable session ids whose inputs include ordered output ids, checklist lineage, and annotator.

```ts
const firstIdentity: ExecutionIdentity = {
  traceId: "trace-one",
  inputId: "summary",
  finalOutputIndex: 2,
};
const secondIdentity: ExecutionIdentity = {
  traceId: "trace-two",
  inputId: "summary",
  finalOutputIndex: 2,
};

expect(makeOutputId(firstIdentity)).not.toBe(makeOutputId(secondIdentity));
expect(ManifestSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
expect(ManifestSchema.safeParse({ schemaVersion: 1, extra: true }).success).toBe(false);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/ids.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Lift canonicalization and define strict schemas**

Move the implementation from `lib/runtime/trace/canonicalize.ts` to `lib/utils/canonicalize.ts`, improve its input/output types to JSON values, and re-export it from the old path. Do not maintain two canonical JSON implementations.

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

const OUTPUT_ID_PATTERN = /^out_[a-f0-9]{64}$/;
export const OutputIdSchema = z.string().regex(OUTPUT_ID_PATTERN);

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
}).strict();
```

Define each nested durable object as a named type and `.strict()` schema. `CorpusRowSchema` requires raw JSON `value`, selected final-output index, trace id, input id/task, hashes, and provenance. `AnnotationRowSchema` requires exact checklist binding, finite nonnegative `activeMs`, unique covered ids, and a two-argument boolean record. Cross-field exact answer coverage remains a store invariant in Task 6.

`ChecklistDefinition` is the editable `--checklist` file, separate from immutable store snapshots. It carries `checklistId`, `version`, and `hash` after first publication, so opening can distinguish an exact current definition, a stale unedited parent that should be refreshed, and a legal user weight edit that should become the next revision. `ChecklistCurrent` is a strict `{ schemaVersion, checklistId, version, hash }` pointer, not a copied revision. Initial definitions may omit lineage and question ids; the controller allocates them once, publishes version 1, and atomically writes the normalized definition back to the same file.

`makeOutputId` hashes a length-safe canonical object containing persisted `traceId`, `inputId`, and `finalOutputIndex`. It never reads a path or run-directory basename. `SessionIdentity` contains ordered output ids, checklist id, and annotator kind/id. `makeSessionId` hashes that object and returns `session_<hex digest>`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/ids.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: define strict labeling identities' > /tmp/msg.txt
git add lib/utils/canonicalize.ts lib/runtime/trace/canonicalize.ts lib/eval/label/types.ts lib/eval/label/ids.ts lib/eval/label/ids.test.ts
git commit -F /tmp/msg.txt
```

### Task 2: Strict private JSONL and atomic file primitives

**Files:**
- Create: `lib/eval/label/jsonl.ts`
- Test: `lib/eval/label/jsonl.test.ts`

**Interfaces:**
- Produces private `openJsonlStrict(args): OpenedJsonl<Value>` and `atomicWriteValidated(args)` for store internals.
- `OpenedJsonl` parses and validates once, owns an identity-to-canonical-row object index, and performs O(1) exact replay/conflict checks and appends thereafter.

- [ ] **Step 1: Write failing integrity tests**

Cover empty/missing files, malformed lines with line numbers, malformed tails, a valid nonempty file without a terminal newline, exact replay, conflicting duplicate ids, schema rejection before writes, temp cleanup after rename/write failures, and multiple appends after one open without another file read. Search first for an existing atomic-write helper; the current search is expected to find none. If one exists when this plan runs, reuse it rather than adding another.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/jsonl.test.ts`
Expected: FAIL because `jsonl.ts` does not exist.

- [ ] **Step 3: Implement the shared primitives**

```ts
type AtomicWriteArgs<Value> = {
  targetPath: string;
  value: Value;
  schema: z.ZodType<Value>;
};

function atomicWriteValidated<Value>(args: AtomicWriteArgs<Value>): void {
  const validated = args.schema.parse(args.value);
  const temporaryPath = `${args.targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    flag: "wx",
  });
  fs.renameSync(temporaryPath, args.targetPath);
}
```

```ts
type OpenedJsonl<Value> = {
  rows(): readonly DeepReadonly<Value>[];
  appendExact(value: Value): "appended" | "replayed";
};
```

Use a `try`/`catch` only where cleanup is required. Cleanup errors must be included in the thrown error rather than swallowed. On open, inspect the final byte of an existing nonempty file and refuse unless it is newline, parse every row, and build the object index. `appendExact` validates and canonicalizes the candidate, checks the in-memory index, appends one line, then updates the index. It never rescans the file.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/jsonl.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: add strict labeling file primitives' > /tmp/msg.txt
git add lib/eval/label/jsonl.ts lib/eval/label/jsonl.test.ts
git commit -F /tmp/msg.txt
```

### Task 3: Source occurrence capture state machine

**Files:**
- Create: `lib/eval/label/corpus.ts`
- Create: `lib/eval/label/capture.ts`
- Test: `lib/eval/label/capture.test.ts`

**Interfaces:**
- Produces `FinalOutputSelection`, `CaptureSkip`, `CaptureResult`, and `selectLabelingFinalOutput(record)`.
- Internal `captureSourceOccurrences(args)` returns `{ rows, newlyCaptured, skipped }`; `rows` always follows source order and includes exact already-captured rows.
- Corpus append remains internal and validates `CorpusRowSchema` before writing.

```ts
export type CaptureSourceArgs = {
  sourceDir: string;
  reportWarning(message: string): void;
};
```

- [ ] **Step 1: Write failing capture-transition tests**

Test these transitions: eligible source to newly captured; exact existing occurrence to ordered replay; same output id with changed task/value/provenance fingerprint to hard failure; failed/missing/no-output/truncated/invalid-task sources to visible skips; warning propagation; structured output projection; duplicate basenames with different trace ids; copied run with the same trace id; identical content from separate executions; and selection of raw value/text/index from one helper.

```ts
expect(result.rows.map((row) => row.outputId)).toEqual([
  existingFirst.outputId,
  newlyCapturedSecond.outputId,
]);
expect(result.newlyCaptured).toEqual([newlyCapturedSecond]);
expect(result.skipped).toEqual([
  { inputId: "truncated", reason: "truncated-output" },
]);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/capture.test.ts`
Expected: FAIL because capture modules do not exist.

- [ ] **Step 3: Implement strict capture**

```ts
export type FinalOutputSelection =
  | { kind: "missing" }
  | { kind: "truncated"; index: number }
  | { kind: "selected"; value: JsonValue; text: string; index: number };

export type CaptureResult = {
  rows: CorpusRow[];
  newlyCaptured: CorpusRow[];
  skipped: CaptureSkip[];
};
```

Wrap existing run artifact readers with capture-specific strict checks. Require a current readable `EvalRecord`, valid `input.json` task, persisted `traceId`, and `evalOutputs`; reject the legacy `finalResponse` shape rather than inventing a nullable output index. Forward warnings to the supplied reporter; do not pass an empty callback. Call one selector once and use its selected raw value, projected text, and index for identity, storage, and display. Reject truncation with a skip reason that names `STATELOG_EVAL_MAX_VALUE_BYTES`.

When an output id exists, compare the complete persisted execution identity and corpus content. Return the existing row only after exact match; conflicting reuse throws. Append all new rows before returning any rows to the controller.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/capture.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: capture strict output occurrences' > /tmp/msg.txt
git add lib/eval/label/corpus.ts lib/eval/label/capture.ts lib/eval/label/capture.test.ts
git commit -F /tmp/msg.txt
```

### Task 4: Pure annotation fold, status, and score

**Files:**
- Create: `lib/eval/label/annotations.ts`
- Test: `lib/eval/label/annotations.test.ts`

**Interfaces:**
- Produces `effectiveAnswers(rows, key)`, `itemStatus(args)`, and `score(args)` as pure functions.
- Annotation append remains private for Task 6's transaction operations.

- [ ] **Step 1: Write failing domain tests**

Cover per-question folding, full annotator/checklist key isolation, delete/restore, uncovered questions, no live questions, weighted scoring, a later JSONL row with an earlier timestamp, tied timestamps, and notes selected by full key in append order.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/annotations.test.ts`
Expected: FAIL because `annotations.ts` does not exist.

- [ ] **Step 3: Implement append-order folding**

```ts
export function effectiveAnswers(
  rows: readonly AnnotationRow[],
  key: AnnotationFoldKey,
): Record<string, boolean> {
  const answers: Record<string, boolean> = {};
  for (const row of rows) {
    if (!matchesFoldKey(row, key)) {
      continue;
    }
    for (const questionId of row.coveredQuestionIds) {
      answers[questionId] = row.answers[questionId];
    }
  }
  return answers;
}
```

Do not sort by `createdAt`. Derive staleness from live question coverage. Return `null` for stale items and for checklists with no live questions.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/annotations.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: fold labeling history by question' > /tmp/msg.txt
git add lib/eval/label/annotations.ts lib/eval/label/annotations.test.ts
git commit -F /tmp/msg.txt
```

### Task 5: Checklist revision publication state machine

**Files:**
- Create: `lib/eval/label/checklist.ts`
- Test: `lib/eval/label/checklist.test.ts`

**Interfaces:**
- Produces `/** @internal */` exported `PendingRevision`, `PublishRevisionResult`, `prepareRevision`, `publishPendingRevision`, and `validateChecklistLineage` for the store/controller modules; none are application APIs.
- `PendingRevision` contains the complete validated snapshot and expected parent/current binding.
- External checklist definitions create version 1 when lineage is absent, refresh from current when they are an exact stale parent, or create one legal next revision when lineage matches and only allowed fields change. Conflicting ids, text edits, invalid weights, skipped versions, ambiguous stale edits, or stale parents fail explicitly.

- [ ] **Step 1: Write failing state-machine tests**

Cover initial publication with nullable parent, add/delete/restore/weight-change publication, forbidden text edits, immutable question ids, exact replay, conflicting existing version, exact stale external definitions being refreshed, and stale edited definitions being rejected. At this pure/store-independent layer, test the prepared state and lineage rules; Task 8 fault-tests the complete draft/store publication protocol.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/checklist.test.ts`
Expected: FAIL because `checklist.ts` does not exist.

- [ ] **Step 3: Implement atomic idempotent publication**

```ts
/** @internal */
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
```

Before session identity is derived, normalize a new `ChecklistDefinition` by allocating its checklist/question ids and atomically writing those ids back to the external file. This one-time identity write is safe without a draft: a crash leaves either the old unowned definition or the complete normalized definition, and no annotation can exist yet. It makes the checklist id stable across a crash before version 1 publication.

`prepareRevision` parses the normalized definition. For a new lineage it prepares version 1 with null parent. For an existing lineage it compares the definition's recorded version/hash and question content against current. An exact current definition is a no-op. An exact unedited parent is refreshed from current. Legal changes against current prepare exactly one next revision. A definition based on an older revision and also edited is ambiguous and fails rather than overwriting newer criteria.

The controller first stores `pendingRevision` in the draft. The store's single `publishRevision(pending, definitionPath)` operation validates the complete revision, atomically writes a uniquely named temp, and renames it to immutable `<version>.json`. An existing final file is accepted only when canonical content and hash match exactly. It then atomically replaces the strict `ChecklistCurrent` pointer and synchronizes the normalized external definition before returning. Finally the controller atomically updates the draft's checklist binding and clears `pendingRevision`. `syncChecklistDefinition()` is used only for the no-publication `refresh-definition` result. Annotation construction cannot occur before that final draft transition.

Importing an edited external checklist computes the legal delta against current. Weight changes are finite and positive and create the next revision; do not silently return current while discarding changes.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/checklist.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: publish recoverable checklist revisions' > /tmp/msg.txt
git add lib/eval/label/checklist.ts lib/eval/label/checklist.test.ts
git commit -F /tmp/msg.txt
```

### Task 6: Validated store facade and exclusive lock

**Files:**
- Create: `lib/eval/label/lock.ts`
- Create: `lib/eval/label/store.ts`
- Test: `lib/eval/label/lock.test.ts`
- Test: `lib/eval/label/store.test.ts`

**Interfaces:**
- Produces `openStore(args: OpenStoreArgs): LabelStore` with read-only snapshots and narrow idempotent transaction methods used only by the controller.
- Produces `acquireStoreLock(args: AcquireStoreLockArgs): StoreLock`, where `StoreLock.release()` checks an ownership token.
- `openStore` never returns mutable raw arrays or public raw append functions.

- [ ] **Step 1: Write failing lock and invariant tests**

Lock tests cover `wx` exclusion, holder reporting, no automatic stale takeover, ownership-token mismatch on release, `EPERM` treated as alive, release after errors, and removal of the exit listener. Use only temporary test directories.

Store tests corrupt each invariant separately: manifest version/unknown keys; every snapshot schema/hash/path id/version; duplicate question ids; parent lineage/current pointer; corpus content hash; output id reuse; annotation output/revision/hash/question references; duplicate covered ids; missing or extra answer keys; duplicate annotation/revision exact replay versus conflict; and malformed/non-newline JSONL tails.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run lib/eval/label/lock.test.ts lib/eval/label/store.test.ts`
Expected: FAIL because store and lock modules do not exist.

- [ ] **Step 3: Implement safe lock ownership and store validation**

```ts
export type LockHolder = {
  pid: number;
  token: string;
  acquiredAt: string;
};

export type AcquireStoreLockArgs = {
  storeDir: string;
  reportWarning(message: string): void;
};

export type StoreLock = {
  holder: DeepReadonly<LockHolder>;
  release(): void;
};

export type OpenStoreArgs = {
  storeDir: string;
  lock: StoreLock;
  fault?(point: LabelStoreFaultPoint): void;
};

/** @internal */
export type LabelStoreFaultPoint =
  | "after-revision-temp-write"
  | "after-revision-rename"
  | "after-current-update"
  | "after-external-definition-sync"
  | "after-annotation-append";

export type PrepareChecklistResult =
  | { kind: "current"; revision: ChecklistRevision }
  | { kind: "refresh-definition"; revision: ChecklistRevision }
  | { kind: "publish"; pending: PendingRevision };

export type LabelStore = {
  captureSource(args: CaptureSourceArgs): CaptureResult;
  annotationSnapshot(): readonly DeepReadonly<AnnotationRow>[];
  checklistSnapshot(checklistId: string, version?: number): DeepReadonly<ChecklistRevision>;
  prepareChecklist(definitionPath: string, definition: ChecklistDefinition): PrepareChecklistResult;
  syncChecklistDefinition(definitionPath: string, revision: ChecklistRevision): void;
  publishRevision(pending: PendingRevision, definitionPath: string): PublishRevisionResult;
  appendAnnotation(row: AnnotationRow): "appended" | "replayed";
  close(): void;
};
```

These are the complete persistence operations used by the controller. Normal execution and recovery call the same idempotent `publishRevision` and `appendAnnotation` methods; there are no separate recovery writers. `captureSource` performs source validation, exact occurrence replay/conflict checks, corpus appends, and ordered-result construction as one high-level operation. The facade does not expose file paths, mutable rows, JSONL handles, checklist raw publication, or unrestricted corpus/annotation append.

Build the annotation-id index once when opening the store. The index makes annotation replay detection O(1) after open; status and scoring still fold the loaded ordered rows. Every method either returns after its promised durable boundary or throws; no method swallows cleanup or fsync errors. Task 7 replaces the temporary annotation query with the final draft-aware session projection once the `Draft` type exists, so each task remains independently type-checkable.

Do not automatically delete a stale lock. Report the holder and require explicit operator action. On release, read and validate the lock, compare the token, remove the registered exit listener, then unlink only the known `<configured-store>/.lock` path. This is a narrow contained lock-file exception to `safeDelete`: `safeDelete` is project-root-oriented and must not be used blindly for a configured store outside the project. Test containment and exact basename before unlinking. Propagate `EPERM`; interpret only `ESRCH` as absent when probing a process.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/lock.test.ts lib/eval/label/store.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: validate and lock labeling stores' > /tmp/msg.txt
git add lib/eval/label/lock.ts lib/eval/label/store.ts lib/eval/label/lock.test.ts lib/eval/label/store.test.ts
git commit -F /tmp/msg.txt
```

### Task 7: Pure session domain and strict drafts

**Files:**
- Create: `lib/eval/label/session.ts`
- Create: `lib/eval/label/draft.ts`
- Modify: `lib/eval/label/store.ts`
- Test: `lib/eval/label/session.test.ts`
- Test: `lib/eval/label/draft.test.ts`
- Modify/Test: `lib/eval/label/store.test.ts`

**Interfaces:**
- Produces public `SessionAction`, internal `SessionEvent`, `SessionState`, `SessionSnapshot`, `reduceSession(state, event)`, `sessionSnapshot(state)`, and `overlayDraft`.
- Produces strict `Draft`, `DraftSchema`, `SessionBinding`, and internal atomic draft load/save. The durable pending annotation is consistently an `AnnotationRow`; there is no second wrapper type.
- Replaces `LabelStore.annotationSnapshot()` with `readSession(sessionId)` and `saveDraft(draft)` now that the store can depend on the strict draft schema.

- [ ] **Step 1: Write failing reducer and draft tests**

Reducer tests cover navigation, toggles, note editing, add/delete/restore, adopting a published revision, applying an annotation commit, and selectors delegated to Task 4. Test the public `signOff` intent only through controller dispatch in Task 8 because it is deliberately not a reducer event. External weight changes are reconciled only when opening a session, not by a reducer action.

Draft tests require exact ordered output ids, checklist identity and publication binding, annotator kind/id, staged changes, pending revision, pending annotation, current navigation, answers, notes, reviewed state, and active timing. Test unknown fields, unsafe session ids, output reordering, changed checklist hash, changed annotator, version-1 bootstrap/recovery, and overlay precedence over completed annotations.

Store tests require `readSession()` to return a newly frozen deep-readonly projection rather than mutable internal references, and `saveDraft()` to be an atomic validated replacement rather than a general file writer:

```ts
export type LabelStoreSnapshot = {
  draft: DeepReadonly<Draft> | null;
  annotations: readonly DeepReadonly<AnnotationRow>[];
  annotationIds: Readonly<Record<AnnotationId, true>>;
};
```

The final `LabelStore` replaces `annotationSnapshot()` with `readSession(sessionId: SessionId): DeepReadonly<LabelStoreSnapshot>` and adds `saveDraft(draft: Draft): void`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run lib/eval/label/session.test.ts lib/eval/label/draft.test.ts lib/eval/label/store.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the pure domain and complete draft**

```ts
export type SessionAction =
  | { kind: "nextItem" }
  | { kind: "previousItem" }
  | { kind: "nextQuestion" }
  | { kind: "previousQuestion" }
  | { kind: "toggleAnswer" }
  | { kind: "beginQuestion" }
  | { kind: "beginNote" }
  | { kind: "appendEditorText"; text: string }
  | { kind: "backspaceEditor" }
  | { kind: "cancelEditor" }
  | { kind: "submitEditor" }
  | { kind: "toggleQuestionDeleted" }
  | { kind: "signOff" };

export type SessionEvent =
  | Exclude<SessionAction, { kind: "submitEditor" } | { kind: "signOff" }>
  | { kind: "questionAdded"; question: ChecklistQuestion }
  | { kind: "noteSaved"; outputId: string; note: string }
  | { kind: "revisionAdopted"; revision: ChecklistRevision }
  | { kind: "annotationCommitted"; row: AnnotationRow };

export type SessionSnapshot = {
  items: readonly DeepReadonly<SessionItem>[];
  itemIndex: number;
  questionIndex: number;
  currentItem: DeepReadonly<SessionItem> | null;
  currentQuestion: DeepReadonly<ChecklistQuestion> | null;
  questions: readonly DeepReadonly<ChecklistQuestion>[];
  answers: Readonly<Record<string, boolean>>;
  note: string;
  editor: DeepReadonly<SessionEditor>;
  statuses: Readonly<Record<string, ItemStatus>>;
  progress: { reviewed: number; total: number; stale: number };
  canSignOff: boolean;
};

export type DraftTiming = {
  activeMsByOutputId: Record<string, number>;
};

export type ChecklistBinding =
  | { kind: "unpublished" }
  | { kind: "published"; version: number; hash: string };

export type SessionBinding = {
  outputIds: string[];
  checklistId: string;
  checklist: ChecklistBinding;
  annotator: Annotator;
};

export type Draft = {
  schemaVersion: 1;
  sessionId: string;
  binding: SessionBinding;
  currentIndex: number;
  answersByOutputId: Record<string, Record<string, boolean>>;
  notesByOutputId: Record<string, string>;
  reviewedOutputIds: string[];
  stagedChanges: ChecklistChange[];
  pendingRevision: PendingRevision | null;
  pendingAnnotation: AnnotationRow | null;
  timing: DraftTiming;
};
```

Initialize domain state from completed annotations in append order, then overlay the validated draft. Reject a draft unless every binding field and the exact output order match. Keep reducer events declarative: `reduceSession` returns only new state and does not write files, allocate ids, or read clocks.

The strict bootstrap rule is: `binding.checklist.kind` may be `"unpublished"` only while `pendingRevision.expectedParentVersion` and `expectedParentHash` are both null. Opening a new lineage creates and saves that bootstrap draft before publishing version 1. Every noninitial pending revision requires a `"published"` binding equal to its expected parent. After publication, replace the bootstrap/parent binding with the new published version/hash before clearing `pendingRevision`. No active session without a pending initial revision may retain an unpublished binding.

`reduceSession` accepts deterministic events and returns only new state. It never allocates random ids or reads time. The controller handles `submitEditor` for a new question by allocating the id and reducing `questionAdded`; it handles note submission with `noteSaved`; it handles `signOff` through the commit protocol and reduces `annotationCommitted` only after durable append/replay succeeds. `SessionSnapshot` contains every field the renderer needs, so the TUI never inspects internal draft or persistence state.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/session.test.ts lib/eval/label/draft.test.ts lib/eval/label/store.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: model resumable labeling sessions' > /tmp/msg.txt
git add lib/eval/label/session.ts lib/eval/label/draft.ts lib/eval/label/store.ts lib/eval/label/session.test.ts lib/eval/label/draft.test.ts lib/eval/label/store.test.ts
git commit -F /tmp/msg.txt
```

### Task 8: Import-safe labeling-session controller and recovery state machine

**Files:**
- Create: `lib/eval/label/controller.ts`
- Test: `lib/eval/label/controller.test.ts`

**Interfaces:**
- Produces the sole application boundary `openLabelingSession(args): Promise<LabelingSessionController>`.
- `dispatch(action)` owns timing, draft persistence, staged revision publication, sign-off commit, and recovery. The controller lifecycle is `open | failed | closed`.

- [ ] **Step 1: Write failing controller tests**

Use temporary stores, injected wall and monotonic clocks, deterministic id factories, and named fault hooks. Cover: ordered capture with zero new rows; matching resume; source-order/checklist/annotator corruption; draft overlay; recovery-aware parent/current binding; recovery order (revision before annotation, then external definition reconciliation); all revision fault boundaries from Task 5; pending annotation before append and after append; exact replay/conflict; every state-changing dispatch saving a draft; active timing across item switches, crash/reopen, sign-off, relabel, and close; and lock release when opening, capture, dispatch, or close fails. Import the module and assert no filesystem, terminal, listener, or process-exit side effects.

Pin these fault postconditions rather than asserting only that recovery eventually returns:

| Fault point | State before reopen | Required state after one reopen |
|---|---|---|
| `after-pending-revision-save` | Draft has pending revision; immutable/current unchanged; version 1 uses unpublished binding | One immutable revision; current/external/draft published binding; pending cleared |
| `after-revision-temp-write` | Valid owned temp exists; immutable/current/external unchanged | Temp validated then completed or safely discarded; one immutable revision; no publication temp remains |
| `after-revision-rename` | Immutable revision exists; current and draft still on parent | Existing revision replayed; current/external/draft rebound; no duplicate |
| `after-current-update` | Immutable/current advanced; draft still on parent with pending | Draft rebound; external synchronized; pending cleared |
| `after-external-definition-sync` | Immutable/current/external advanced; draft still on parent with pending | Draft rebound; pending cleared; external content unchanged |
| `after-draft-rebind` | Revision fully committed; no annotation pending | Reconciliation is a no-op; labeling resumes on new revision |
| `after-pending-annotation-save` | Draft has annotation; log unchanged; item not advanced | One log row; `annotationCommitted` applied; item advanced; pending cleared |
| `after-annotation-append` | Log has row; draft still pending; item not advanced | Exact replay; item advanced once; pending cleared |
| `after-annotation-commit-save` | Log and post-commit draft complete | No replay side effect; next item remains current |

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/controller.test.ts`
Expected: FAIL because `controller.ts` does not exist.

- [ ] **Step 3: Implement the declarative controller contract**

```ts
export type MonotonicClock = {
  elapsedMs(): number;
};

export type WallClock = {
  nowIso(): string;
};

export type EntityIds = {
  questionId(): string;
  annotationId(): string;
};

export type OpenLabelingSessionArgs = {
  sourceDir: string;
  storeDir: string;
  checklistFile: string;
  annotator: Annotator;
  reportWarning(message: string): void;
};

/** @internal */
export type ControllerDependencies = {
  monotonicClock: MonotonicClock;
  wallClock: WallClock;
  ids: EntityIds;
  fault?(point: ControllerFaultPoint): void;
};

/** @internal */
export type ControllerFaultPoint =
  | LabelStoreFaultPoint
  | "after-pending-revision-save"
  | "after-draft-rebind"
  | "after-pending-annotation-save"
  | "after-annotation-commit-save";

export type LabelingSessionController = {
  snapshot(): SessionSnapshot;
  dispatch(action: SessionAction): Promise<SessionSnapshot>;
  close(): Promise<void>;
};

export async function openLabelingSession(
  args: OpenLabelingSessionArgs,
): Promise<LabelingSessionController>;

/** @internal */
export function createLabelingSessionOpener(
  dependencies: ControllerDependencies,
): (
  args: OpenLabelingSessionArgs,
) => Promise<LabelingSessionController>;
```

Production calls the public `openLabelingSession(args)`. Tests call the internal exported `createLabelingSessionOpener(dependencies)` factory; fault injection never appears in the application API. The opener forwards the same fault callback into `openStore`, so boundaries inside the deep publication/append operations are injectable without exposing low-level steps to the controller.

Opening follows a recovery-aware order:

1. Parse and schema-validate the external checklist definition before mutating the store.
2. Acquire the lock, open/validate the store, and capture ordered source rows.
3. Normalize initial checklist/question ids atomically when the definition has no lineage.
4. Derive the session id from ordered outputs, normalized checklist id, and annotator.
5. Schema-validate the draft and bind immutable identity only: exact output order, checklist id, and annotator. For a new lineage, create an unpublished bootstrap draft with the complete version-1 `pendingRevision` and save it before publication.
6. If `pendingRevision` exists, require an unpublished binding exactly for its null-parent version-1 case; otherwise require the published binding to match its expected parent. Permit store current to be absent/the parent or the exact pending revision as appropriate, replay publication, and rebind the draft to the published revision.
7. Replay `pendingAnnotation`, reduce `annotationCommitted`, and save the post-commit draft.
8. Reconcile the external checklist definition against current, publishing one legal revision if needed.
9. Require the resulting checklist version/hash, initialize from completed annotations, and overlay the draft.

Any opening failure releases the lock.

For an ordinary state-changing dispatch, flush elapsed time for the previously active item using the process-local monotonic clock, reduce the pure event, atomically save the draft, and start a new process-local interval for the active item. Persist only accumulated milliseconds, never a monotonic anchor. On reopen, start a fresh interval after recovery; a crash may lose only the unflushed tail since the last dispatch and must never count downtime. V1 has no automatic idle detection.

`signOff` bypasses the generic reduce/save path and follows this exact sequence:

1. Flush and persist accumulated timing without marking the item reviewed or advancing.
2. Save the complete pending checklist revision in the draft when staged changes exist.
3. Call the one deep `publishRevision(pending, checklistFile)` store operation, which publishes/replays the immutable revision, current pointer, and normalized external definition before returning.
4. Save the new checklist version/hash binding and clear `pendingRevision`.
5. Build and validate `AnnotationRow` against that durable revision, covering every live question and writing an untouched checkbox as explicit `false`.
6. Save the complete row as `pendingAnnotation`.
7. Append/replay the annotation through the store facade.
8. Reduce deterministic `annotationCommitted`, which marks reviewed, advances, clears pending state, and resets this output's active-time accumulator for a later relabel.
9. Atomically save that post-commit draft.

Recovery executes the same idempotent operations in that order before draft overlay. The controller sequences these intent-level store operations, but `publishRevision` alone encapsulates the order of temp write, immutable rename, current update, and external-definition synchronization; no controller or TUI caller may reproduce those filesystem steps. A persistence failure during `dispatch` moves the controller to `failed`, releases the lock, and makes later dispatches reject. `close()` flushes/saves when still open, always attempts release in `finally`, becomes closed even if save fails, and is idempotent. Preserve the primary error and attach any release failure rather than replacing it.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/eval/label/controller.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: coordinate labeling session recovery' > /tmp/msg.txt
git add lib/eval/label/controller.ts lib/eval/label/controller.test.ts
git commit -F /tmp/msg.txt
```

### Task 9: Import-safe terminal adapter over the controller

**Files:**
- Create: `lib/eval/label/labelTui.ts`
- Test: `lib/eval/label/labelTui.test.ts`

**Interfaces:**
- Consumes only `LabelingSessionController`, `SessionSnapshot`, `SessionAction`, and renderer dependencies.
- Produces `runLabelTui(args): Promise<void>` and pure `renderLabelScreen`, `stripAnsi`, and `renderMarkdownSafely`.

- [ ] **Step 1: Write failing renderer and terminal-lifecycle tests**

Test checkbox/status rendering, ANSI stripping, Markdown fallback preserving exact content, key-to-action mapping, add-question prompt default weight 1, navigation, sign-off, clean quit, non-TTY rejection, raw-mode/listener restoration after renderer/controller errors, and import with no side effects. Use a fake controller and fake terminal streams; do not import store internals.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/eval/label/labelTui.test.ts`
Expected: FAIL because `labelTui.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

```ts
export type RunLabelTuiArgs = {
  controller: LabelingSessionController;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

export async function runLabelTui(args: RunLabelTuiArgs): Promise<void> {
  assertInteractiveTerminal(args.input, args.output);
  const terminal = enterTerminalMode(args.input);
  try {
    await runInputLoop(args.controller, args.input, args.output);
  } finally {
    terminal.restore();
  }
}
```

Translate keys to domain actions and call `controller.dispatch`. Render only controller snapshots. Do not call `process.exit`, execute `main()` at import time, or perform persistence in the TUI. Keep terminal loops imperative and small. Call `controller.close()` from the CLI's `finally`, not from rendering helpers.

- [ ] **Step 4: Run tests and type-check, then commit**

Run: `npx vitest run lib/eval/label/labelTui.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

```bash
printf '%s\n' 'feat: add labeling terminal interface' > /tmp/msg.txt
git add lib/eval/label/labelTui.ts lib/eval/label/labelTui.test.ts
git commit -F /tmp/msg.txt
```

### Task 10: CLI command, config, and error lifecycle

**Files:**
- Create: `lib/cli/eval/label.ts`
- Test: `lib/cli/eval/label.test.ts`
- Modify/Test: `scripts/agency.test.ts` (existing side-effect-free command-tree registration test)
- Modify: `lib/config.ts` (add `eval.labelStore` to the type near line 100 and `AgencyConfigSchema` near line 419)
- Modify: `scripts/agency.ts` (register `agency eval label` beside existing eval subcommands)

**Interfaces:**
- Produces `evalLabel(options)` and Commander registration for `agency eval label <source> --checklist <file> [--store <dir>] [--annotator <id>]`.
- Resolves a relative store from the invoking working directory. Default is config `eval.labelStore`, then `labels/`.

- [ ] **Step 1: Write failing command tests**

Test config schema acceptance/rejection, option precedence, cwd-relative resolution, registered Commander command/options, missing/invalid checklist, the `$USER` → OS account → `"human"` annotator fallback order, source errors, non-TTY input/output, controller errors, user-facing error formatting, and controller/lock close in `finally` when TUI throws. Inject controller/TUI and annotator-lookup dependencies rather than touching a real terminal.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run lib/cli/eval/label.test.ts scripts/agency.test.ts`
Expected: FAIL because the command does not exist.

- [ ] **Step 3: Implement thin CLI composition**

```ts
export type EvalLabelOptions = {
  source: string;
  checklist: string;
  store?: string;
  annotator?: string;
  config?: AgencyConfig;
};

export async function evalLabel(options: EvalLabelOptions): Promise<void> {
  const controller = await openLabelingSession(toSessionArgs(options));
  try {
    await runLabelTui({
      controller,
      input: process.stdin,
      output: process.stdout,
    });
  } finally {
    await controller.close();
  }
}
```

Follow error and registration patterns in `lib/cli/eval/run.ts`, `grade.ts`, and their tests. Keep command logic free of direct store/capture/draft imports.

Resolve an omitted annotator once at the CLI boundary from `$USER`, then the OS account name, then the literal `"human"`; pass the resulting required `Annotator` to the controller. Tests inject environment/account lookup so the fallback order is deterministic. Keep `--annotator` optional in Commander help to match this contract.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run lib/cli/eval/label.test.ts scripts/agency.test.ts`
Expected: PASS.

```bash
printf '%s\n' 'feat: add eval label command' > /tmp/msg.txt
git add lib/cli/eval/label.ts lib/cli/eval/label.test.ts lib/config.ts scripts/agency.ts scripts/agency.test.ts
git commit -F /tmp/msg.txt
```

### Task 11: Protocol documentation

**Files:**
- Create: `docs/dev/eval-labeling.md`
- Modify: `CLAUDE.md` (add the document to “Deeper docs”)

- [ ] **Step 1: Write the developer document**

Document the three state machines with explicit states and transitions:

1. Source occurrence capture: inspect, skip or identify, exact-match replay or conflict, append, ordered result.
2. Checklist publication: staged, pending in draft, immutable snapshot renamed, current advanced, draft rebound, pending cleared.
3. Session recovery: lock, validate, capture, bind draft, recover revision, recover annotation, overlay, active, close.

Also document durable schemas, append-order folding, lock ownership/manual stale-lock removal, strict startup failures, legal external weight changes, controller/TUI boundary, and active-time semantics. State why arbitrary configured-store deletion does not use `safeDelete`, while lock release permits only the verified contained `.lock` file.

- [ ] **Step 2: Review prose and commit**

Read the finished document from top to bottom and remove any placeholder instructions or references to unspecified future implementation.

```bash
printf '%s\n' 'docs: explain eval labeling protocols' > /tmp/msg.txt
git add docs/dev/eval-labeling.md CLAUDE.md
git commit -F /tmp/msg.txt
```

### Task 12: Focused verification and approval checkpoint

- [ ] **Step 1: Run labeling and CLI tests once, saving output**

Run: `npx vitest run lib/eval/label lib/cli/eval/label.test.ts scripts/agency.test.ts > /tmp/eval-label-tests.log 2>&1`
Expected: exit 0. If it fails, inspect `/tmp/eval-label-tests.log` before rerunning a focused failing test.

- [ ] **Step 2: Run the broader eval regression tests once, saving output**

Run: `npx vitest run lib/eval > /tmp/eval-tests.log 2>&1`
Expected: exit 0.

- [ ] **Step 3: Run static checks**

Run: `npx tsc --noEmit -p tsconfig.json > /tmp/eval-label-tsc.log 2>&1 && pnpm run lint:structure > /tmp/eval-label-lint.log 2>&1`
Expected: exit 0.

- [ ] **Step 4: Audit dependency boundaries and forbidden patterns**

Run: `grep -nE 'draft|checklist|corpus|capture|lock|store' lib/eval/label/labelTui.ts`
Expected: no persistence-module import. References to checklist display data in snapshot fields are acceptable.

Run: `grep -RInE 'catch[[:space:]]*\([^)]*\)[[:space:]]*\{[[:space:]]*\}|if[[:space:]]*\([^)]*\)[[:space:]]*[^\{[:space:]]|\.\.\.[[:space:]]*\([^?]+\?' lib/eval/label lib/cli/eval/label.ts`
Expected: no output.

- [ ] **Step 5: Commit verification fixes, if any**

```bash
printf '%s\n' 'test: verify eval labeling workflow' > /tmp/msg.txt
git add lib/eval/label lib/cli/eval/label.ts lib/cli/eval/label.test.ts lib/config.ts scripts/agency.ts scripts/agency.test.ts docs/dev/eval-labeling.md CLAUDE.md
git diff --cached --quiet || git commit -F /tmp/msg.txt
```

- [ ] **Step 6: Stop for owner approval**

Report the commits and verification output. Ask the owner to approve pushing and opening a PR. Do not run a push or PR command without that new approval.

## Self-Review

Before implementation begins, verify that every source-spec requirement maps to a task. In particular, confirm occurrence identity and capture policy in Task 3, immutable revisions and legal weights in Task 5, append-order folds in Task 4, strict invariants and lock safety in Task 6, complete drafts in Task 7, ordered recovery and timing in Task 8, terminal safety in Task 9, and CLI/config behavior in Task 10.

The implementation must preserve these dependency arrows:

```text
TUI -> controller -> store facade -> private persistence modules
TUI -> pure session snapshot/render helpers
controller -> pure session reducer/selectors
store/controller -> pure annotation fold/status/score
```

No caller outside the store/controller boundary may append JSONL, publish a checklist snapshot, save a draft, or append an annotation directly.
