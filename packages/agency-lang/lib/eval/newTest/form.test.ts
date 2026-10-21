import { describe, expect, it } from "vitest";

import {
  EDITOR_EXITED_MESSAGE,
  editActionFor,
  FIELDS,
  initialForm,
  isDirty,
  isLastRow,
  reduceForm,
  rowsOf,
  type FieldName,
  type FormAction,
  type FormState,
  type Row,
} from "./form.js";

function run(actions: FormAction[], from: FormState = initialForm("suite")): FormState {
  return actions.reduce(reduceForm, from);
}

function field(name: FieldName): Row {
  return { kind: "field", name };
}

function grader(index: number, question: string): Row {
  return { kind: "grader", index, question };
}

function repeat(action: FormAction, times: number): FormAction[] {
  return Array.from({ length: times }, () => action);
}

/** A form with one grader whose answers are typed in, cursor on its kind row. */
function withGrader(answers: Record<string, string>): FormState {
  const added = run([{ kind: "addGrader" }]);
  return { ...added, graders: [{ answers }] };
}

function cursorOn(state: FormState, row: Row): FormState {
  return { ...state, cursor: row };
}

function typed(text: string): FormAction[] {
  return [...text].map((c): FormAction => ({ kind: "appendText", text: c }));
}

describe("reduceForm", () => {
  it("moves the cursor through the fields and stops at the ends", () => {
    const names = FIELDS.map((field) => field.name);
    expect(run([{ kind: "moveUp" }]).cursor).toEqual(field(names[0]));
    expect(run([{ kind: "moveDown" }]).cursor).toEqual(field(names[1]));
    const downs: FormAction[] = Array.from({ length: names.length + 3 }, () => ({
      kind: "moveDown",
    }));
    expect(run(downs).cursor).toEqual(field(names[names.length - 1]));
  });

  it("typing lands in the field under the cursor at once, and stays when the cursor moves", () => {
    const edited = run(typed("says-its-name"));
    expect(edited.values.id).toBe("says-its-name");
    const moved = run([{ kind: "moveDown" }, ...typed("x"), { kind: "moveUp" }], edited);
    expect(moved.values.id).toBe("says-its-name");
    expect(moved.values.description).toBe("x");
  });

  it("backspace and paste work on the value", () => {
    const state = run([
      { kind: "appendText", text: "ab" },
      { kind: "backspace" },
      { kind: "appendText", text: "pasted text" },
    ]);
    expect(state.values.id).toBe("apasted text");
  });

  it("a keystroke clears the footer message", () => {
    const failed = run([
      { kind: "saveFailed", problems: [{ row: field("id"), text: "id is required" }] },
    ]);
    expect(failed.message).toBe("id is required");
    expect(run(typed("t"), failed).message).toBe("");
  });

  it("is dirty after a change, not after movement", () => {
    expect(isDirty(run([{ kind: "moveDown" }, { kind: "moveDown" }]))).toBe(false);
    expect(isDirty(run(typed("x")))).toBe(true);
  });

  it("quits at once when clean, asks when dirty, and n returns to the form", () => {
    expect(run([{ kind: "requestQuit" }]).done).toBe(true);
    const asked = run([...typed("x"), { kind: "requestQuit" }]);
    expect(asked.mode).toEqual({ kind: "confirmQuit" });
    expect(asked.done).toBe(false);
    expect(run([{ kind: "cancelQuit" }], asked).mode).toEqual({ kind: "form" });
    expect(run([{ kind: "confirmQuit" }], asked).done).toBe(true);
  });

  it("a failed save shows the first problem and moves the cursor to its field", () => {
    const state = run([
      {
        kind: "saveFailed",
        problems: [
          { row: field("goal"), text: "goal is required" },
          { row: field("id"), text: "id is required" },
        ],
      },
    ]);
    expect(state.message).toBe("goal is required");
    expect(state.cursor).toEqual(field("goal"));
  });

  it("the external editor replaces the value, or leaves it with a message", () => {
    const at = run([{ kind: "moveDown" }, { kind: "moveDown" }]);
    expect(at.cursor).toEqual(field("input"));
    const replaced = run([{ kind: "editorReturned", text: "Two\nparagraphs" }], at);
    expect(replaced.values.input).toBe("Two\nparagraphs");
    const kept = run([{ kind: "editorReturned", text: null }], replaced);
    expect(kept.values.input).toBe("Two\nparagraphs");
    expect(kept.message).toBe(EDITOR_EXITED_MESSAGE);
    expect(run([{ kind: "editInEditor" }], kept).message).toBe("");
  });

  it("an editor that could not run leaves the value and says why", () => {
    const state = run([...typed("x"), { kind: "editorFailed", text: "spawn vim ENOENT" }]);
    expect(state.values.id).toBe("x");
    expect(state.message).toBe("could not run the editor: spawn vim ENOENT");
  });

  it("a save is asked about first, and n returns to the form", () => {
    const asked = run([{ kind: "askSave" }]);
    expect(asked.mode).toEqual({ kind: "confirmSave" });
    expect(run([{ kind: "cancelSave" }], asked).mode).toEqual({ kind: "form" });
  });

  it("saved finishes the form and records the folder for the command to print", () => {
    const wrote = run([{ kind: "askSave" }, { kind: "saved", testDir: "suite/says-its-name" }]);
    expect(wrote.done).toBe(true);
    expect(wrote.written).toBe("suite/says-its-name");
    expect(initialForm("suite").written).toBeNull();
  });

  it("a save that fails after the question returns to the form with the problem", () => {
    const failed = run([
      { kind: "askSave" },
      { kind: "saveFailed", problems: [{ row: field("id"), text: "suite/t already exists" }] },
    ]);
    expect(failed.mode).toEqual({ kind: "form" });
    expect(failed.message).toBe("suite/t already exists");
    expect(failed.done).toBe(false);
  });
});

describe("editActionFor", () => {
  it("maps the typing keys onto form actions and leaves the rest to the key table", () => {
    expect(editActionFor({ key: "a" })).toEqual({ kind: "appendText", text: "a" });
    expect(editActionFor({ key: "backspace" })).toEqual({ kind: "backspace" });
    expect(editActionFor({ key: "escape" })).toBeNull();
    expect(editActionFor({ key: "enter" })).toBeNull();
    expect(editActionFor({ key: "up" })).toBeNull();
    expect(editActionFor({ key: "s", ctrl: true })).toBeNull();
    expect(editActionFor({ key: "b", alt: true })).toBeNull();
    expect(editActionFor({ key: "backspace", alt: true })).toEqual({ kind: "backspaceWord" });
  });
});

describe("isLastRow", () => {
  it("is true for the last field when there are no graders", () => {
    const state = initialForm("suite");
    expect(isLastRow(state, field(FIELDS[FIELDS.length - 1].name))).toBe(true);
    expect(isLastRow(state, field(FIELDS[0].name))).toBe(false);
  });

  it("the last row is the last grader's last question when there is one", () => {
    const state = withGrader({ kind: "command" });
    expect(isLastRow(state, field("goal"))).toBe(false);
    expect(isLastRow(state, grader(0, "weight"))).toBe(true);
  });
});

describe("graders in the form", () => {
  it("addGrader appends a grader and puts the cursor on its kind row", () => {
    const state = run([{ kind: "addGrader" }]);
    expect(state.graders).toEqual([{ answers: {} }]);
    expect(state.cursor).toEqual(grader(0, "kind"));
  });

  it("the rows run fields first, then each grader's questions", () => {
    const state = run([{ kind: "addGrader" }, { kind: "pickNext" }]);
    expect(rowsOf(state)).toEqual([
      ...FIELDS.map((spec) => field(spec.name)),
      grader(0, "kind"),
      grader(0, "goal"),
      grader(0, "name"),
      grader(0, "mustPass"),
      grader(0, "weight"),
    ]);
  });

  it("letters typed on a choice row change nothing", () => {
    const state = cursorOn(withGrader({ kind: "count" }), grader(0, "mustPass"));
    const typedOn = run(
      [...typed("s"), { kind: "backspace" }, { kind: "editorReturned", text: "x" }],
      state,
    );
    expect(typedOn.graders).toEqual(state.graders);
    expect(typedOn.values).toEqual(state.values);
  });

  it("typing on a text question row edits its answer", () => {
    const state = cursorOn(withGrader({ kind: "count" }), grader(0, "name"));
    expect(run(typed("n1"), state).graders[0].answers.name).toBe("n1");
    expect(
      run([{ kind: "editorReturned", text: "from editor" }], state).graders[0].answers.name,
    ).toBe("from editor");
  });

  it("Left and Right pick the previous and next option and stop at the ends", () => {
    const added = run([{ kind: "addGrader" }]);
    expect(run([{ kind: "pickNext" }], added).graders[0].answers.kind).toBe("goal");
    expect(run(repeat({ kind: "pickNext" }, 6), added).graders[0].answers.kind).toBe("command");
    expect(
      run([{ kind: "pickNext" }, { kind: "pickPrevious" }], added).graders[0].answers.kind,
    ).toBe("goal");
    const onText = cursorOn(withGrader({ kind: "count" }), grader(0, "name"));
    expect(run([{ kind: "pickNext" }], onText).graders).toEqual(onText.graders);
  });

  it("changing count to errors hides the tool rows and keeps the typed tool name", () => {
    const state = cursorOn(
      withGrader({ kind: "count", tool: "fetchMarkdown" }),
      grader(0, "count"),
    );
    const errors = run([{ kind: "pickNext" }], state);
    expect(errors.graders[0].answers).toMatchObject({ count: "errors", tool: "fetchMarkdown" });
    expect(rowsOf(errors)).not.toContainEqual(grader(0, "tool"));
    expect(rowsOf(run([{ kind: "pickPrevious" }], errors))).toContainEqual(grader(0, "tool"));
  });

  it("must pass on a goal fills the passing score once", () => {
    const state = cursorOn(withGrader({ kind: "goal" }), grader(0, "mustPass"));
    const yes = run([{ kind: "pickNext" }], state);
    expect(yes.graders[0].answers.passingScore).toBe("0.5");
    const typedScore = {
      ...yes,
      graders: [{ answers: { ...yes.graders[0].answers, passingScore: "0.9" } }],
    };
    const toggled = run([{ kind: "pickPrevious" }, { kind: "pickNext" }], typedScore);
    expect(toggled.graders[0].answers.passingScore).toBe("0.9");
  });

  it("remove asks only on a kind row, and y removes the grader", () => {
    const state = withGrader({ kind: "goal" });
    expect(run([{ kind: "requestRemove" }], cursorOn(state, grader(0, "name"))).mode).toEqual({
      kind: "form",
    });
    const asked = run([{ kind: "requestRemove" }], state);
    expect(asked.mode).toEqual({ kind: "confirmRemove", index: 0 });
    expect(run([{ kind: "cancelRemove" }], asked).mode).toEqual({ kind: "form" });
    const removed = run([{ kind: "confirmRemove" }], asked);
    expect(removed.graders).toEqual([]);
    expect(removed.mode).toEqual({ kind: "form" });
    expect(removed.cursor).toEqual(field("goal"));
  });

  it("a failed save moves the cursor to the problem's row", () => {
    const state = run(
      [{ kind: "saveFailed", problems: [{ row: grader(0, "max"), text: "max: bad" }] }],
      withGrader({ kind: "count" }),
    );
    expect(state.cursor).toEqual(grader(0, "max"));
  });

  it("is dirty with a grader and nothing typed", () => {
    expect(isDirty(run([{ kind: "addGrader" }]))).toBe(true);
  });

  it("movement walks into the grader rows and stops at the last one", () => {
    const state = cursorOn(withGrader({ kind: "command" }), field("goal"));
    expect(run([{ kind: "moveDown" }], state).cursor).toEqual(grader(0, "kind"));
    expect(run(repeat({ kind: "moveDown" }, 20), state).cursor).toEqual(grader(0, "weight"));
  });
});
