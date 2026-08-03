import { describe, expect, it } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { Screen } from "@/tui/screen.js";

import { labelScreen, sanitizeUntrusted } from "./labelTui.js";
import type { SessionSnapshot } from "./session.js";

const OUTPUT_ID = `out_${"a".repeat(64)}`;
const ESC = "\x1b";
const BEL = "\x07";

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const item = { outputId: OUTPUT_ID, task: "a task", text: "some output" };
  return {
    items: [item],
    itemIndex: 0,
    questionIndex: 0,
    currentItem: item,
    currentQuestion: { id: "q_a", text: "Accurate?", weight: 1, deleted: false },
    questions: [{ id: "q_a", text: "Accurate?", weight: 1, deleted: false }],
    answers: {},
    note: "",
    editor: { kind: "none" },
    statuses: { [OUTPUT_ID]: "untouched" },
    scores: { [OUTPUT_ID]: null },
    progress: { reviewed: 0, total: 1, stale: 0 },
    canSignOff: true,
    hasStagedQuestions: false,
    ...over,
  };
}

/**
 * Render through the real layout engine and read back what the terminal would
 * receive, escapes included. Asserting on the frame rather than on a string
 * this module built is the point: it proves nothing hostile survives all the
 * way to the output target.
 */
function frameCells(over: Partial<SessionSnapshot> = {}, body: string[] = ["output"]): string {
  const recorder = new FrameRecorder();
  const screen = new Screen({
    input: new ScriptedInput(),
    output: recorder,
    width: 100,
    height: 30,
  });
  screen.render(labelScreen({
    snapshot: snapshot(over),
    storeLabel: "labels",
    width: 100,
    height: 30,
    scroll: 0,
    body,
  }));
  // Every character the frame holds, so a stray escape cannot hide in a cell.
  return recorder.lastText();
}

describe("sanitizeUntrusted", () => {
  it("neutralizes cursor movement and clear-screen", () => {
    expect(sanitizeUntrusted(`before${ESC}[2J${ESC}[Hafter`)).not.toContain(ESC);
  });

  it("neutralizes an OSC 52 clipboard write", () => {
    expect(sanitizeUntrusted(`${ESC}]52;c;cGF5bG9hZA==${BEL}`)).not.toContain(ESC);
  });

  it("neutralizes C1 controls, which are a single byte each", () => {
    expect(sanitizeUntrusted("ac")).not.toContain("");
  });

  it("neutralizes a bare carriage return, which would overwrite the line", () => {
    expect(sanitizeUntrusted("visible\rhidden")).not.toContain("\r");
  });

  it("keeps newlines and tabs, which the layout uses", () => {
    expect(sanitizeUntrusted("a\nb\tc")).toBe("a\nb\tc");
  });

  it("leaves ordinary text, including punctuation and emoji, alone", () => {
    const text = "Here are today's top stories — 3 of them 📰";
    expect(sanitizeUntrusted(text)).toBe(text);
  });
});

describe("untrusted content never reaches the frame raw", () => {
  it("sanitizes a hostile task", () => {
    const hostile = { outputId: OUTPUT_ID, task: `safe${ESC}[2Jhidden`, text: "x" };
    expect(frameCells({ currentItem: hostile, items: [hostile] })).not.toContain(ESC);
  });

  it("sanitizes a hostile question", () => {
    const questions = [{ id: "q_a", text: `ok${ESC}[2Jgone`, weight: 1, deleted: false }];
    expect(frameCells({ questions })).not.toContain(ESC);
  });

  it("sanitizes a hostile note", () => {
    expect(frameCells({ note: `note${ESC}[2Jgone` })).not.toContain(ESC);
  });

  it("sanitizes a hostile editor draft", () => {
    // A draft is untrusted after a round trip: beginNote seeds it from a
    // stored note, which came from this same input.
    expect(frameCells({ editor: { kind: "note", draft: `typed${ESC}[2J` } })).not.toContain(ESC);
  });

  it("sanitizes hostile output body text", () => {
    expect(frameCells({}, [sanitizeUntrusted(`body${ESC}[2Jgone`)])).not.toContain(ESC);
  });

  it("escapes style tags in a hostile question, which are markup to the parser", () => {
    // Control characters are not the only way in: {black-fg} is markup, so
    // text alone could restyle or hide the evidence being judged.
    const questions = [{ id: "q_a", text: "{black-fg}invisible?{/black-fg}", weight: 1, deleted: false }];
    expect(frameCells({ questions })).toContain("{black-fg}invisible?");
  });

  it("escapes style tags in a hostile note", () => {
    expect(frameCells({ note: "{bg-red}alarming{/bg-red}" })).toContain("{bg-red}alarming");
  });

  it("escapes style tags in a hostile task", () => {
    const hostile = { outputId: OUTPUT_ID, task: "{black-fg}hidden", text: "x" };
    expect(frameCells({ currentItem: hostile, items: [hostile] })).toContain("{black-fg}hidden");
  });

  it("shows only the first line of a multi-line task, so the layout cannot be broken", () => {
    const multiline = { outputId: OUTPUT_ID, task: "first line\nsecond line", text: "x" };
    const text = frameCells({ currentItem: multiline, items: [multiline] });
    expect(text).toContain("first line");
    expect(text).not.toContain("second line");
  });
});
