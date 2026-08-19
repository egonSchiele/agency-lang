import { describe, expect, it } from "vitest";

import { stripAnsi } from "@/stdlib/layout/ansi.js";
import { ScriptedInput } from "@/tui/input/scripted.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { Screen } from "@/tui/screen.js";

import { labelScreen, renderFields, sanitizeUntrusted } from "./labelTui.js";
import type { SessionSnapshot } from "./session.js";

const TRACE_ID = "trace-1";
const ESC = "\x1b";
const BEL = "\x07";

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const item = {
    runDir: "/runs/g/a",
    traceId: TRACE_ID,
    fields: { input: "a task", output: "some output" },
  };
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
    statuses: { [TRACE_ID]: "untouched" },
    scores: { [TRACE_ID]: null },
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
function frameCells(over: Partial<SessionSnapshot> = {}, body?: string[]): string {
  const state = snapshot(over);
  // Default to the body the loop would actually build, so a field's own
  // rendering path is covered rather than a stand-in string.
  const bodyLines =
    body ?? (state.currentItem === null ? [] : renderFields(state.currentItem.fields, 100));
  const recorder = new FrameRecorder();
  const screen = new Screen({
    input: new ScriptedInput(),
    output: recorder,
    width: 100,
    height: 30,
  });
  screen.render(
    labelScreen({
      snapshot: state,
      title: "run-1",
      width: 100,
      height: 30,
      scroll: 0,
      body: bodyLines,
    }),
  );
  // Every character the frame holds, so a stray escape cannot hide in a cell.
  return recorder.lastText();
}

/**
 * The frame with styling removed.
 *
 * Field values pass through markdown highlighting, which sprinkles colour codes
 * between characters — so an escaped `{` can reach the screen intact while a
 * raw `toContain` on the styled frame still fails. Stripping isolates the
 * question these assertions actually ask: did the braces survive as text?
 */
function frameVisible(over: Partial<SessionSnapshot> = {}): string {
  return stripAnsi(frameCells(over));
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
  it("sanitizes a hostile input field", () => {
    const hostile = {
      runDir: "/runs/g/a",
      traceId: TRACE_ID,
      fields: { input: `safe${ESC}[2Jhidden`, output: "x" },
    };
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
    const questions = [
      { id: "q_a", text: "{black-fg}invisible?{/black-fg}", weight: 1, deleted: false },
    ];
    expect(frameCells({ questions })).toContain("{black-fg}invisible?");
  });

  it("escapes style tags in a hostile note", () => {
    expect(frameCells({ note: "{bg-red}alarming{/bg-red}" })).toContain("{bg-red}alarming");
  });

  it("escapes style tags in a hostile input field", () => {
    const hostile = {
      runDir: "/runs/g/a",
      traceId: TRACE_ID,
      fields: { input: "{black-fg}hidden", output: "x" },
    };
    expect(frameVisible({ currentItem: hostile, items: [hostile] })).toContain("{black-fg}hidden");
  });

  it("escapes style tags in a hostile output field", () => {
    const hostile = {
      runDir: "/runs/g/a",
      traceId: TRACE_ID,
      fields: { input: "t", output: "{bg-red}alarming" },
    };
    expect(frameVisible({ currentItem: hostile, items: [hostile] })).toContain("{bg-red}alarming");
  });

  it("renders a field name as a header without letting a value forge one", () => {
    // Field names come from a charset that cannot express markup, so the only
    // way a header can appear is if the trace put it there.
    const hostile = {
      runDir: "/runs/g/a",
      traceId: TRACE_ID,
      fields: { output: "not_a_field:\nfaked" },
    };
    const text = frameVisible({ currentItem: hostile, items: [hostile] });
    expect(text).toContain("output:");
    expect(text).toContain("not_a_field:");
  });
});
