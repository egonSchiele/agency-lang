import {
  effectiveAnswers,
  itemStatus as itemStatusOf,
  latestNote,
  liveQuestions,
  score as scoreOf,
  type AnnotationFoldKey,
  type EffectiveAnswers,
  type ItemStatus,
} from "./annotations.js";
import type {
  AnnotationRow,
  Annotator,
  ChecklistQuestion,
  ChecklistRevision,
  CorpusRow,
  DeepReadonly,
} from "./types.js";

/** One thing being judged, projected for display. */
export type SessionItem = {
  outputId: string;
  task: string;
  text: string;
};

export type SessionEditor =
  | { kind: "none" }
  | { kind: "question"; draft: string }
  | { kind: "note"; draft: string };

/**
 * What a person can ask for. `submitEditor` and `signOff` are intents rather
 * than state transitions: the first has to allocate a question id and the
 * second has to write files, and a pure reducer does neither. The controller
 * turns them into the deterministic events below.
 */
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

/** What actually moves the state. Every one is deterministic: no clocks, no
 *  random ids, no filesystem. */
export type SessionEvent =
  | Exclude<SessionAction, { kind: "submitEditor" } | { kind: "signOff" }>
  | { kind: "questionAdded"; question: ChecklistQuestion }
  | { kind: "noteSaved"; outputId: string; note: string }
  | { kind: "revisionAdopted"; revision: ChecklistRevision }
  | { kind: "annotationCommitted"; row: AnnotationRow };

export type SessionState = {
  items: SessionItem[];
  revision: ChecklistRevision;
  /** Question edits staged but not yet published. The controller turns these
   *  into a revision; the reducer never writes one. */
  stagedQuestions: ChecklistQuestion[] | null;
  answersByOutputId: Record<string, Record<string, boolean>>;
  notesByOutputId: Record<string, string>;
  /** outputId → the question ids it was signed off against. */
  reviewedByOutputId: Record<string, string[]>;
  itemIndex: number;
  questionIndex: number;
  editor: SessionEditor;
  annotator: Annotator;
};

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
  scores: Readonly<Record<string, number | null>>;
  progress: { reviewed: number; total: number; stale: number };
  canSignOff: boolean;
  hasStagedQuestions: boolean;
};

export type InitSessionArgs = {
  corpus: readonly DeepReadonly<CorpusRow>[];
  revision: ChecklistRevision;
  annotations: readonly AnnotationRow[];
  annotator: Annotator;
};

/** Questions in play right now: the staged edit if there is one, else the
 *  published revision. */
export function questionsOf(state: SessionState): ChecklistQuestion[] {
  return state.stagedQuestions ?? state.revision.questions;
}

function liveOf(state: SessionState): ChecklistQuestion[] {
  return questionsOf(state).filter((question) => !question.deleted);
}

function foldKey(state: SessionState, outputId: string): AnnotationFoldKey {
  return { outputId, checklistId: state.revision.checklistId, annotator: state.annotator };
}

export function initSession(args: InitSessionArgs): SessionState {
  const items: SessionItem[] = args.corpus.map((row) => ({
    outputId: row.outputId,
    task: typeof row.input.task === "string" ? row.input.task : JSON.stringify(row.input.task),
    text: row.text,
  }));

  const answersByOutputId: Record<string, Record<string, boolean>> = {};
  const notesByOutputId: Record<string, string> = {};
  const reviewedByOutputId: Record<string, string[]> = {};

  for (const item of items) {
    const key: AnnotationFoldKey = {
      outputId: item.outputId,
      checklistId: args.revision.checklistId,
      annotator: args.annotator,
    };
    const answers: EffectiveAnswers = effectiveAnswers(args.annotations, key);
    answersByOutputId[item.outputId] = { ...answers };
    const note = latestNote(args.annotations, key);
    if (note.length > 0) {
      notesByOutputId[item.outputId] = note;
    }
    const judged = Object.keys(answers);
    if (judged.length > 0) {
      reviewedByOutputId[item.outputId] = judged;
    }
  }

  return {
    items,
    revision: args.revision,
    stagedQuestions: null,
    answersByOutputId,
    notesByOutputId,
    reviewedByOutputId,
    itemIndex: 0,
    questionIndex: 0,
    editor: { kind: "none" },
    annotator: args.annotator,
  };
}

// --- selectors -----------------------------------------------------------

export function currentItem(state: SessionState): SessionItem | undefined {
  return state.items[state.itemIndex];
}

export function currentQuestion(state: SessionState): ChecklistQuestion | undefined {
  return questionsOf(state)[state.questionIndex];
}

export function itemStatus(state: SessionState, outputId: string): ItemStatus {
  const signedOff = state.reviewedByOutputId[outputId];
  if (signedOff === undefined) {
    return "untouched";
  }
  const missing = liveOf(state).some((question) => !signedOff.includes(question.id));
  return missing ? "stale" : "reviewed";
}

export function sessionSnapshot(state: SessionState): SessionSnapshot {
  const item = currentItem(state);
  const statuses: Record<string, ItemStatus> = {};
  const scores: Record<string, number | null> = {};
  let reviewed = 0;
  let stale = 0;

  const stagedRevision: ChecklistRevision = { ...state.revision, questions: questionsOf(state) };
  for (const entry of state.items) {
    const status = itemStatus(state, entry.outputId);
    statuses[entry.outputId] = status;
    if (status === "reviewed") {
      reviewed += 1;
    }
    if (status === "stale") {
      stale += 1;
    }
    scores[entry.outputId] = status === "reviewed"
      ? scoreOf({ answers: state.answersByOutputId[entry.outputId] ?? {}, revision: stagedRevision })
      : null;
  }

  return {
    items: state.items,
    itemIndex: state.itemIndex,
    questionIndex: state.questionIndex,
    currentItem: item ?? null,
    currentQuestion: currentQuestion(state) ?? null,
    questions: questionsOf(state),
    answers: item === undefined ? {} : state.answersByOutputId[item.outputId] ?? {},
    note: item === undefined ? "" : state.notesByOutputId[item.outputId] ?? "",
    editor: state.editor,
    statuses,
    scores,
    progress: { reviewed, total: state.items.length, stale },
    canSignOff: item !== undefined && liveOf(state).length > 0,
    hasStagedQuestions: state.stagedQuestions !== null,
  };
}

/** The answers a sign-off would record: every live question, with an untouched
 *  box written as an explicit `false` because you looked at it and moved on. */
export function signOffPayload(state: SessionState): {
  outputId: string;
  coveredQuestionIds: string[];
  answers: Record<string, boolean>;
  note: string;
} | undefined {
  const item = currentItem(state);
  if (item === undefined) {
    return undefined;
  }
  const live = liveOf(state);
  const answers: Record<string, boolean> = {};
  for (const question of live) {
    answers[question.id] = state.answersByOutputId[item.outputId]?.[question.id] === true;
  }
  return {
    outputId: item.outputId,
    coveredQuestionIds: live.map((question) => question.id),
    answers,
    note: state.notesByOutputId[item.outputId] ?? "",
  };
}

// --- reducer -------------------------------------------------------------

export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.kind) {
    case "nextItem":
      return moveItem(state, 1);
    case "previousItem":
      return moveItem(state, -1);
    case "nextQuestion":
      return { ...state, questionIndex: clamp(state.questionIndex + 1, questionsOf(state).length) };
    case "previousQuestion":
      return { ...state, questionIndex: clamp(state.questionIndex - 1, questionsOf(state).length) };
    case "toggleAnswer":
      return applyToggle(state);
    case "toggleQuestionDeleted":
      return applyToggleDeleted(state);
    case "beginQuestion":
      return { ...state, editor: { kind: "question", draft: "" } };
    case "beginNote": {
      const item = currentItem(state);
      const draft = item === undefined ? "" : state.notesByOutputId[item.outputId] ?? "";
      return { ...state, editor: { kind: "note", draft } };
    }
    case "appendEditorText":
      return withEditorDraft(state, (draft) => draft + event.text);
    case "backspaceEditor":
      return withEditorDraft(state, (draft) => draft.slice(0, -1));
    case "cancelEditor":
      return { ...state, editor: { kind: "none" } };
    case "questionAdded":
      return {
        ...state,
        stagedQuestions: [...questionsOf(state), event.question],
        editor: { kind: "none" },
      };
    case "noteSaved":
      return {
        ...state,
        notesByOutputId: { ...state.notesByOutputId, [event.outputId]: event.note },
        editor: { kind: "none" },
      };
    case "revisionAdopted":
      return { ...state, revision: event.revision, stagedQuestions: null };
    case "annotationCommitted":
      return applyCommitted(state, event.row);
    default:
      return state;
  }
}

function moveItem(state: SessionState, delta: number): SessionState {
  return {
    ...state,
    itemIndex: clamp(state.itemIndex + delta, state.items.length),
    questionIndex: 0,
  };
}

function withEditorDraft(state: SessionState, update: (draft: string) => string): SessionState {
  if (state.editor.kind === "none") {
    return state;
  }
  return { ...state, editor: { ...state.editor, draft: update(state.editor.draft) } };
}

/** Flip the focused checkbox, then drop to the next question. Without the
 *  advance every tick costs two keystrokes, which is what makes a checklist
 *  feel slower than it is. */
function applyToggle(state: SessionState): SessionState {
  const item = currentItem(state);
  const question = currentQuestion(state);
  if (item === undefined || question === undefined || question.deleted) {
    return state;
  }
  const forItem = state.answersByOutputId[item.outputId] ?? {};
  return {
    ...state,
    answersByOutputId: {
      ...state.answersByOutputId,
      [item.outputId]: { ...forItem, [question.id]: forItem[question.id] !== true },
    },
    questionIndex: clamp(state.questionIndex + 1, questionsOf(state).length),
  };
}

function applyToggleDeleted(state: SessionState): SessionState {
  const question = currentQuestion(state);
  if (question === undefined) {
    return state;
  }
  return {
    ...state,
    stagedQuestions: questionsOf(state).map((entry) =>
      entry.id === question.id ? { ...entry, deleted: !entry.deleted } : entry),
  };
}

/** Sign-off landed durably: mark reviewed, advance, and reset this output's
 *  answers to what was actually recorded, so a later relabel starts from the
 *  truth rather than from unsaved screen state. */
function applyCommitted(state: SessionState, row: AnnotationRow): SessionState {
  return {
    ...state,
    answersByOutputId: {
      ...state.answersByOutputId,
      [row.outputId]: { ...state.answersByOutputId[row.outputId], ...row.answers },
    },
    notesByOutputId: { ...state.notesByOutputId, [row.outputId]: row.note },
    reviewedByOutputId: { ...state.reviewedByOutputId, [row.outputId]: [...row.coveredQuestionIds] },
    itemIndex: clamp(state.itemIndex + 1, state.items.length),
    questionIndex: 0,
    editor: { kind: "none" },
  };
}

function clamp(index: number, length: number): number {
  if (length === 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), length - 1);
}

export { liveQuestions, itemStatusOf, scoreOf };
