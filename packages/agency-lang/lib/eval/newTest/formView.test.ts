import { describe, expect, it } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { Screen } from "@/tui/screen.js";

import { FIELDS, initialForm, reduceForm, type FormAction, type FormState } from "./form.js";
import { cursorRows, renderForm, wroteSummary } from "./formView.js";

const HINTS = "↑↓ move   Enter next   Ctrl+S save   Ctrl+C quit";
/** Two of indent, the widest label, three of gap: where values start. */
const VALUE_COLUMN = 2 + Math.max(...FIELDS.map((field) => field.label.length)) + 3;
const NEXT = [
  "agency eval run <agent> --suite bar-evals --test says-its-name",
  "agency eval grade runs/<name>",
];

function frame(state: FormState, width = 80, height = 24): string {
  const recorder = new FrameRecorder();
  const screen = new Screen({ input: new ScriptedInput(), output: recorder, width, height });
  screen.render(renderForm({ state, width, height, hints: HINTS }));
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
    expect(text).toContain(`  ${"folder name".padEnd(VALUE_COLUMN - 2)}says-its-name█`);
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

  it("shows a field's help while it is empty, after the cursor on the cursor row", () => {
    const text = frame(initialForm("suite"));
    expect(text).toContain("instructions for the LLM judge");
    expect(text).toContain(`  ${"folder name".padEnd(VALUE_COLUMN - 2)}█ letters, digits, - and _`);
  });

  it("wraps a long value on the cursor row and puts the cursor at its end", () => {
    const state = { ...filled(), cursor: { kind: "field", name: "goal" } as const };
    const lines = rows(frame(state));
    const goalRow = lines.findIndex((row) => row.startsWith("  goal"));
    expect(lines[goalRow + 1]).toMatch(new RegExp(`^ {${VALUE_COLUMN}}\\S`));
    expect(lines[goalRow + 1]).toMatch(/other name\.█$/);
    expect(lines[goalRow]).not.toContain("█");
  });

  it("a value that fills its last row puts the cursor on the row after it", () => {
    const valueWidth = 80 - VALUE_COLUMN;
    const state = { ...filled(), cursor: { kind: "field", name: "goal" } as const };
    state.values = { ...state.values, goal: "x".repeat(valueWidth) };
    const lines = rows(frame(state));
    const goalRow = lines.findIndex((row) => row.startsWith("  goal"));
    expect(lines[goalRow]).toContain("x".repeat(valueWidth));
    expect(lines[goalRow + 1]).toBe(`${" ".repeat(VALUE_COLUMN)}█`);
  });

  it("the printed summary keeps braces, since it goes to the terminal, and drops control characters", () => {
    expect(wroteSummary("evals/{v2}/t", NEXT)).toEqual([
      "wrote evals/{v2}/t",
      "",
      "run it with:",
      `  ${NEXT[0]}`,
      `  ${NEXT[1]}`,
    ]);
    const stripped = wroteSummary("evals\x1b[2J/t", ["run\x07"]).join("\n");
    expect(stripped).not.toContain("\x1b");
    expect(stripped).not.toContain("\x07");
  });

  it("a trailing space typed into a wrapped value stays on the last row", () => {
    const wide = "word ".repeat(10).trimEnd();
    expect(cursorRows(wide, 30).length).toBeGreaterThan(1);
    expect(cursorRows(`${wide} `, 30).at(-1)).toMatch(/word $/);
    expect(cursorRows(`${wide}  `, 30).at(-1)).toMatch(/word {2}$/);
    expect(cursorRows("a ", 80)).toEqual(["a "]);
  });

  it("a last row that fills the width gets a row for the cursor", () => {
    const full = "x".repeat(20);
    expect(cursorRows(full, 20)).toEqual([full, ""]);
    expect(cursorRows(full, 21)).toEqual([full]);
    // Trailing spaces fill a row too.
    expect(cursorRows("x".repeat(18) + "  ", 20)).toEqual(["x".repeat(18) + "  ", ""]);
  });

  it("the footer asks before writing", () => {
    const asking = reduceForm(filled(), { kind: "askSave" });
    expect(rows(frame(asking)).at(-1)).toBe("write this test?  y / n");
  });

  it("draws the cursor row as a text input with a cursor, and no other row", () => {
    const text = frame(reduceForm(filled(), { kind: "moveDown" }));
    expect(text).toContain("asked for it.█");
    expect(text).not.toContain("says-its-name█");
    expect(text.split("█").length).toBe(2);
  });

  it("uses the footer for the hints, then for a message, then for the discard question", () => {
    expect(rows(frame(filled())).at(-1)).toBe(HINTS);
    const failed = reduceForm(filled(), {
      kind: "saveFailed",
      problems: [{ row: { kind: "field", name: "goal" }, text: "goal is required" }],
    });
    expect(rows(frame(failed)).at(-1)).toBe("goal is required");
    const asking: FormAction[] = [{ kind: "requestQuit" }];
    expect(rows(frame(asking.reduce(reduceForm, filled()))).at(-1)).toBe(
      "discard this test?  y / n",
    );
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
  });

  it("shows a brace typed into a field as it is", () => {
    const braced = reduceForm(initialForm("suite"), { kind: "appendText", text: "a {b}" });
    expect(frame(braced)).toContain("a {b}█");
  });
});
