import { describe, expect, it } from "vitest";

import {
  EDITOR_EXITED_MESSAGE,
  editActionFor,
  FIELDS,
  initialForm,
  isDirty,
  reduceForm,
  type FormAction,
  type FormState,
} from "./form.js";

function run(actions: FormAction[], from: FormState = initialForm("suite")): FormState {
  return actions.reduce(reduceForm, from);
}

function typed(text: string): FormAction[] {
  return [
    { kind: "beginEdit" },
    ...[...text].map((c): FormAction => ({ kind: "appendText", text: c })),
    { kind: "submitEdit" },
  ];
}

describe("reduceForm", () => {
  it("moves the cursor through the fields and stops at the ends", () => {
    const names = FIELDS.map((field) => field.name);
    expect(run([{ kind: "moveUp" }]).cursor).toBe(names[0]);
    expect(run([{ kind: "moveDown" }]).cursor).toBe(names[1]);
    const downs: FormAction[] = Array.from({ length: names.length + 3 }, () => ({
      kind: "moveDown",
    }));
    expect(run(downs).cursor).toBe(names[names.length - 1]);
  });

  it("edits a field: Enter, typing, Enter changes the value; Esc restores it", () => {
    const edited = run(typed("says-its-name"));
    expect(edited.values.id).toBe("says-its-name");
    expect(edited.editor.kind).toBe("none");

    const cancelled = run(
      [{ kind: "beginEdit" }, { kind: "appendText", text: "x" }, { kind: "cancelEdit" }],
      edited,
    );
    expect(cancelled.values.id).toBe("says-its-name");
  });

  it("backspace and paste work on the draft", () => {
    const state = run([
      { kind: "beginEdit" },
      { kind: "appendText", text: "ab" },
      { kind: "backspace" },
      { kind: "appendText", text: "pasted text" },
    ]);
    expect(state.editor).toEqual({ kind: "field", field: "id", draft: "apasted text" });
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
          { field: "goal", text: "goal is required" },
          { field: "id", text: "id is required" },
        ],
      },
    ]);
    expect(state.message).toBe("goal is required");
    expect(state.cursor).toBe("goal");
  });

  it("the external editor replaces the value, or leaves it with a message", () => {
    const at = run([{ kind: "moveDown" }, { kind: "moveDown" }]);
    expect(at.cursor).toBe("input");
    const replaced = run([{ kind: "editorReturned", text: "Two\nparagraphs" }], at);
    expect(replaced.values.input).toBe("Two\nparagraphs");
    const kept = run([{ kind: "editorReturned", text: null }], replaced);
    expect(kept.values.input).toBe("Two\nparagraphs");
    expect(kept.message).toBe(EDITOR_EXITED_MESSAGE);
    expect(run([{ kind: "beginEdit" }], kept).message).toBe("");
  });

  it("saved shows the wrote screen and any key dismisses it", () => {
    const wrote = run([{ kind: "saved", testDir: "suite/says-its-name" }]);
    expect(wrote.mode).toEqual({ kind: "wrote", testDir: "suite/says-its-name" });
    expect(run([{ kind: "dismiss" }]).done).toBe(false);
    expect(run([{ kind: "dismiss" }], wrote).done).toBe(true);
  });
});

describe("editActionFor", () => {
  it("maps the line editor's keys onto form actions", () => {
    expect(editActionFor({ key: "a" })).toEqual({ kind: "appendText", text: "a" });
    expect(editActionFor({ key: "backspace" })).toEqual({ kind: "backspace" });
    expect(editActionFor({ key: "escape" })).toEqual({ kind: "cancelEdit" });
    expect(editActionFor({ key: "enter" })).toEqual({ kind: "submitEdit" });
    expect(editActionFor({ key: "up" })).toBeNull();
  });
});
