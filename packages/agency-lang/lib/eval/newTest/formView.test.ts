import { describe, expect, it } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { Screen } from "@/tui/screen.js";

import {
  editingForm,
  FIELDS,
  initialForm,
  reduceForm,
  type FormAction,
  type FormState,
} from "./form.js";
import type { Answers } from "./graders.js";
import {
  bodyLines,
  cursorRows,
  LABEL_WIDTH,
  renderForm,
  scrolledToCursor,
  wroteSummary,
} from "./formView.js";

const HINTS = "↑↓ move   Enter next   Ctrl+S save   Ctrl+C quit";
/** Two of indent, then the label column: where values start. */
const VALUE_COLUMN = 2 + LABEL_WIDTH;
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

/** The lines after `at` that continue its value under the value column. */
function continuation(lines: string[], at: number): string[] {
  const found: string[] = [];
  for (let i = at + 1; i < lines.length && lines[i].startsWith(" ".repeat(VALUE_COLUMN)); i += 1) {
    found.push(lines[i]);
  }
  return found;
}

const COUNT_EXAMPLE: Answers = {
  kind: "count",
  count: "toolCalls",
  tool: "fetchMarkdown",
  repeated: "yes",
  max: "0",
  name: "no-repeated-fetches",
  mustPass: "yes",
};

function withGraders(state: FormState, graders: Answers[]): FormState {
  return { ...state, graders: graders.map((answers) => ({ answers })) };
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
    expect(
      continuation(lines, goalRow)
        .map((row) => row.trim())
        .join(" "),
    ).toContain("must not give any other name");
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
    expect(continuation(lines, goalRow).at(-1)).toMatch(/other name\.█$/);
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

  it("shows the no-graders line under the heading when there are none", () => {
    const lines = rows(frame(filled()));
    const heading = lines.findIndex((row) => row === "  graders");
    expect(heading).toBeGreaterThan(0);
    expect(lines[heading + 1]).toContain(
      "no graders: the goal above is judged by the bundled goal judge",
    );
  });

  it("draws the count example from the spec", () => {
    const text = frame(withGraders(filled(), [COUNT_EXAMPLE]));
    const expected = [
      /1\. what to check\s+count things in the trace/,
      /\n\s{4}count\s+tool calls/,
      /which tool\s+fetchMarkdown/,
      /only repeats\s+yes/,
      /at most\s+0/,
      /name\s+no-repeated-fetches/,
      /must pass\s+yes/,
    ];
    const positions = expected.map((pattern) => text.search(pattern));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).not.toContain("no graders:");
  });

  it("the cursor on a choice row shows the pick help while unanswered", () => {
    const state = reduceForm(filled(), { kind: "addGrader" });
    const text = frame(state);
    expect(text).toMatch(/1\. what to check\s+pick with ← →/);
    expect(text).not.toContain("█");
  });

  it("bodyLines gives a wrapped row more than one line, all tagged with the row", () => {
    const goalLines = bodyLines(filled(), 80).filter(
      (line) => line.row?.kind === "field" && line.row.name === "goal",
    );
    expect(goalLines.length).toBeGreaterThan(1);
  });

  it("the typed cursor row is one-line elements with the text input last", () => {
    const state = { ...filled(), cursor: { kind: "field", name: "goal" } as const };
    const goalLines = bodyLines(state, 80).filter(
      (line) => line.row?.kind === "field" && line.row.name === "goal",
    );
    expect(goalLines.length).toBeGreaterThan(1);
    expect(goalLines.every((line) => line.element.style?.height === 1)).toBe(true);
    expect(frame(state)).toMatch(/other name\.█/);
  });

  it("scrolledToCursor keeps the cursor row's last line inside a short terminal and goes back up for a field", () => {
    const state = withGraders(filled(), [COUNT_EXAMPLE, COUNT_EXAMPLE]);
    const onLast = { ...state, cursor: { kind: "grader", index: 1, question: "weight" } as const };
    const scrolled = scrolledToCursor(onLast, 80, 10);
    expect(scrolled.scrollTop).toBeGreaterThan(0);
    const lines = bodyLines(scrolled, 80);
    const last = lines
      .map(
        (line) =>
          line.row?.kind === "grader" && line.row.question === "weight" && line.row.index === 1,
      )
      .lastIndexOf(true);
    expect(last).toBeGreaterThanOrEqual(scrolled.scrollTop);
    expect(last).toBeLessThan(scrolled.scrollTop + 10 - 3);
    const back = scrolledToCursor({ ...scrolled, cursor: { kind: "field", name: "id" } }, 80, 10);
    expect(back.scrollTop).toBe(0);
  });

  it("the frame shows only the lines from scrollTop", () => {
    const state = { ...withGraders(filled(), [COUNT_EXAMPLE]), scrollTop: 8 };
    const text = frame(state, 80, 12);
    expect(text).not.toContain("folder name");
    expect(text).toContain("NEW TEST");
    expect(rows(text).at(-1)).toBe(HINTS);
  });

  it("the goal row says it is not judged while the test has graders", () => {
    const note = "not judged while the test has graders; add a goal grader to judge it";
    expect(frame(filled())).not.toContain(note);
    const lines = rows(frame(withGraders(filled(), [COUNT_EXAMPLE])));
    const goalRow = lines.findIndex((row) => row.startsWith("  goal"));
    const noteRow = lines.findIndex((row) => row.includes(note));
    expect(noteRow).toBeGreaterThan(goalRow);
    expect(lines[noteRow + 1]).toBe("");
  });
});

describe("an editing form on screen", () => {
  function editing(gradersLock: string | null = null): FormState {
    return editingForm({
      testDir: "bar-evals/says-its-name",
      base: {},
      values: { ...filled().values, id: "" },
      graders: [],
      locks: { id: "says-its-name", files: "files/ (2 files)" },
      gradersLock,
      harnessGraded: false,
    });
  }

  it("is titled EDIT TEST with the folder", () => {
    expect(frame(editing())).toContain("EDIT TEST  bar-evals/says-its-name");
    expect(frame(editing())).not.toContain("NEW TEST");
  });

  it("a locked row shows its text dim and no cursor", () => {
    const text = frame(editing());
    expect(text).toMatch(/folder name\s+says-its-name\n/);
    expect(text).toMatch(/files\s+files\/ \(2 files\)/);
    expect(text).not.toContain("says-its-name█");
    expect(text).not.toContain("letters, digits, - and _");
    expect(text).toContain("asked for it.█");
  });

  it("a locked section shows graders.ts: edit the file", () => {
    const text = frame(editing("graders.ts: edit the file"));
    expect(text).toContain("graders.ts: edit the file");
    expect(text).not.toContain("no graders:");
  });
});
