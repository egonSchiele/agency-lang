import { describe, expect, it } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { Screen } from "@/tui/screen.js";

import { FIELDS, initialForm, reduceForm, type FormAction, type FormState } from "./form.js";
import { renderForm } from "./formView.js";

const HINTS = "↑↓ move   Enter edit   s save   q quit";
/** Two of indent, the widest label, three of gap: where values start. */
const VALUE_COLUMN = 2 + Math.max(...FIELDS.map((field) => field.label.length)) + 3;
const NEXT = [
  "agency eval run <agent> --suite bar-evals --test says-its-name",
  "agency eval grade runs/<name>",
];

function frame(state: FormState, width = 80, height = 24): string {
  const recorder = new FrameRecorder();
  const screen = new Screen({ input: new ScriptedInput(), output: recorder, width, height });
  screen.render(renderForm({ state, width, height, hints: HINTS, nextCommands: NEXT }));
  return recorder.lastText();
}

function rows(text: string): string[] {
  return text.split("\n").map((row) => row.trimEnd());
}

function filled(): FormState {
  const base = initialForm("bar-evals/");
  const values = {
    id: "says-its-name",
    description: "The script is told its name and asked for it.",
    input: "What's your name?",
    files: "",
    goal: "The reply says its name is 'the amazing Agency language'. It may add a greeting, but it must not give any other name.",
  };
  return { ...base, values };
}

describe("renderForm", () => {
  it("shows the five labels in order with their values", () => {
    const text = frame(filled());
    const labels = FIELDS.map((field) => field.label);
    const positions = labels.map((label) => text.indexOf(`  ${label}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain(`  ${"id".padEnd(VALUE_COLUMN - 2)}says-its-name`);
    expect(text).toContain(`  ${"input".padEnd(VALUE_COLUMN - 2)}What's your name?`);
    expect(text).toContain("NEW TEST  bar-evals/");
  });

  it("wraps a long value under the value column", () => {
    const lines = rows(frame(filled()));
    const goalRow = lines.findIndex((row) => row.startsWith("  goal"));
    expect(goalRow).toBeGreaterThan(0);
    expect(lines[goalRow + 1]).toMatch(new RegExp(`^ {${VALUE_COLUMN}}\\S`));
    expect(lines[goalRow] + lines[goalRow + 1]).toContain("must not give any other name");
  });

  it("shows a field's help while it is empty", () => {
    const text = frame(initialForm("suite"));
    expect(text).toContain("empty for an agent that takes no input");
  });

  it("draws the field being edited as a text input with a cursor", () => {
    const state = reduceForm(filled(), { kind: "beginEdit" });
    const text = frame(state);
    expect(text).toContain("says-its-name█");
  });

  it("uses the footer for the hints, then for a message, then for the discard question", () => {
    expect(rows(frame(filled())).at(-1)).toBe(HINTS);
    const failed = reduceForm(filled(), {
      kind: "saveFailed",
      problems: [{ field: "goal", text: "goal is required" }],
    });
    expect(rows(frame(failed)).at(-1)).toBe("goal is required");
    const asking: FormAction[] = [{ kind: "requestQuit" }];
    expect(rows(frame(asking.reduce(reduceForm, filled()))).at(-1)).toBe(
      "discard this test?  y / n",
    );
  });

  it("the wrote screen names the folder and the commands to run, wrapping a long one", () => {
    const wrote = reduceForm(filled(), { kind: "saved", testDir: "bar-evals/says-its-name" });
    const text = frame(wrote);
    expect(text).toContain("wrote bar-evals/says-its-name");
    expect(text).toContain(NEXT[0]);
    expect(text).toContain(NEXT[1]);
    expect(text).not.toContain("NEW TEST");
    const narrow = rows(frame(wrote, 40));
    const start = narrow.findIndex((row) => row.startsWith("  agency eval run"));
    expect(narrow[start + 1]).toMatch(/^ {4}\S/);
  });

  it("neutralizes control characters and style tags in a value, the suite path, and the message", () => {
    const hostile = { ...filled(), values: { ...filled().values, input: "safe\x1b[2Jhidden" } };
    expect(frame(hostile)).not.toContain("\x1b[2J");
    const styled = { ...initialForm("evals\x1b[2J{red-fg}"), message: "bad {bold}path\x07" };
    const text = frame(styled);
    expect(text).not.toContain("\x1b[2J");
    expect(text).not.toContain("\x07");
    expect(text).toContain("{red-fg}");
    expect(text).toContain("bad {bold}path");
    const wrote = reduceForm(filled(), { kind: "saved", testDir: "evals\x1b[2J/t" });
    expect(frame(wrote)).not.toContain("\x1b[2J");
  });

  it("shows a brace typed into a field as it is", () => {
    const state = reduceForm(filled(), { kind: "beginEdit" });
    const braced = { ...state, editor: { ...state.editor, draft: "a {b}" } } as FormState;
    expect(frame(braced)).toContain("a {b}█");
  });
});
