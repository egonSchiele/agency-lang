import { describe, expect, it } from "vitest";

import {
  EDITOR_EXITED_MESSAGE,
  editActionFor,
  FIELDS,
  initialForm,
  isDirty,
  isLastField,
  reduceForm,
  type FormAction,
  type FormState,
} from "./form.js";

function run(actions: FormAction[], from: FormState = initialForm("suite")): FormState {
  return actions.reduce(reduceForm, from);
}

function typed(text: string): FormAction[] {
  return [...text].map((c): FormAction => ({ kind: "appendText", text: c }));
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
      { kind: "saveFailed", problems: [{ field: "id", text: "id is required" }] },
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
    expect(run([{ kind: "editInEditor" }], kept).message).toBe("");
  });

  it("an editor that could not run leaves the value and says why", () => {
    const state = run([...typed("x"), { kind: "editorFailed", text: "spawn vim ENOENT" }]);
    expect(state.values.id).toBe("x");
    expect(state.message).toBe("could not run the editor: spawn vim ENOENT");
  });

  it("saved shows the wrote screen and any key dismisses it", () => {
    const wrote = run([{ kind: "saved", testDir: "suite/says-its-name" }]);
    expect(wrote.mode).toEqual({ kind: "wrote", testDir: "suite/says-its-name" });
    expect(run([{ kind: "dismiss" }]).done).toBe(false);
    expect(run([{ kind: "dismiss" }], wrote).done).toBe(true);
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
  });
});

describe("isLastField", () => {
  it("is true for the last row of the table only", () => {
    expect(isLastField(FIELDS[FIELDS.length - 1].name)).toBe(true);
    expect(isLastField(FIELDS[0].name)).toBe(false);
  });
});
