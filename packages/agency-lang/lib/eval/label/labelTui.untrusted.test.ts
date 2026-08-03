import { describe, expect, it } from "vitest";

import {
  parseKeysBuffered,
  renderLabelScreen,
  sanitizeUntrusted,
  stripAnsi,
} from "./labelTui.js";
import type { SessionSnapshot } from "./session.js";

const OUTPUT_ID = `out_${"a".repeat(64)}`;
const ESC = "\x1b";

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

const baseRender = { storeLabel: "labels", columns: 100, rows: 30, scroll: 0, body: [] as string[] };

describe("sanitizeUntrusted", () => {
  it("neutralizes cursor movement and clear-screen", () => {
    expect(sanitizeUntrusted(`before${ESC}[2J${ESC}[Hafter`)).not.toContain(ESC);
  });

  it("neutralizes an OSC 52 clipboard write", () => {
    expect(sanitizeUntrusted(`${ESC}]52;c;cGF5bG9hZA==`)).not.toContain(ESC);
  });

  it("neutralizes C1 controls, which are a single byte each", () => {
    expect(sanitizeUntrusted("ac")).not.toContain("");
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

describe("untrusted content never reaches the terminal raw", () => {
  it("sanitizes a hostile task", () => {
    const hostile = { outputId: OUTPUT_ID, task: `safe${ESC}[2Jhidden`, text: "x" };
    const frame = renderLabelScreen({
      ...baseRender,
      snapshot: snapshot({ currentItem: hostile, items: [hostile] }),
    });
    expect(frame).not.toContain(`${ESC}[2J`);
  });

  it("sanitizes a hostile question", () => {
    const frame = renderLabelScreen({
      ...baseRender,
      snapshot: snapshot({
        questions: [{ id: "q_a", text: `ok${ESC}[2Jgone`, weight: 1, deleted: false }],
      }),
    });
    expect(frame).not.toContain(`${ESC}[2J`);
  });

  it("sanitizes a hostile note", () => {
    const frame = renderLabelScreen({
      ...baseRender,
      snapshot: snapshot({ note: `note${ESC}[2Jgone` }),
    });
    expect(frame).not.toContain(`${ESC}[2J`);
  });

  it("sanitizes a hostile editor draft", () => {
    const frame = renderLabelScreen({
      ...baseRender,
      snapshot: snapshot({ editor: { kind: "note", draft: `typed${ESC}[2J` } }),
    });
    expect(frame).not.toContain(`${ESC}[2J`);
  });

  it("shows only the first line of a multi-line task, so the layout cannot be broken", () => {
    const multiline = { outputId: OUTPUT_ID, task: "first line\nsecond line", text: "x" };
    const frame = stripAnsi(renderLabelScreen({
      ...baseRender,
      snapshot: snapshot({ currentItem: multiline, items: [multiline] }),
    }));
    expect(frame).toContain("first line");
    expect(frame).not.toContain("second line");
  });
});

describe("checklist viewport follows the focused question", () => {
  function manyQuestions(count: number, focusIndex: number): SessionSnapshot {
    const questions = Array.from({ length: count }, (_, index) => ({
      id: `q_${index}`, text: `Question number ${index}`, weight: 1, deleted: false,
    }));
    return snapshot({
      questions, questionIndex: focusIndex, currentQuestion: questions[focusIndex],
    });
  }

  it("keeps a question near the end of a long checklist visible", () => {
    // Without a viewport the right pane always starts at question 0, so Space
    // and Enter would act on a checkbox the reader cannot see.
    const frame = stripAnsi(renderLabelScreen({
      ...baseRender, rows: 20, snapshot: manyQuestions(40, 39),
    }));
    expect(frame).toContain("Question number 39");
  });

  it("still shows the first question when focus is at the top", () => {
    const frame = stripAnsi(renderLabelScreen({
      ...baseRender, rows: 20, snapshot: manyQuestions(40, 0),
    }));
    expect(frame).toContain("Question number 0");
  });

  it("does not scroll a checklist that already fits", () => {
    const frame = stripAnsi(renderLabelScreen({
      ...baseRender, rows: 30, snapshot: manyQuestions(3, 2),
    }));
    expect(frame).toContain("Question number 0");
    expect(frame).toContain("Question number 2");
  });
});

describe("parseKeysBuffered", () => {
  it("holds a split arrow key until the rest arrives", () => {
    const first = parseKeysBuffered(`${ESC}[`);
    expect(first.keys).toEqual([]);
    expect(first.rest).toBe(`${ESC}[`);
    const second = parseKeysBuffered(first.rest + "A");
    expect(second.keys).toEqual([{ kind: "up" }]);
    expect(second.rest).toBe("");
  });

  it("holds a lone escape, which could begin a sequence", () => {
    expect(parseKeysBuffered(ESC)).toEqual({ keys: [], rest: ESC });
  });

  it("holds a partial page-up until its terminator arrives", () => {
    const first = parseKeysBuffered(`${ESC}[5`);
    expect(first.rest).toBe(`${ESC}[5`);
    expect(parseKeysBuffered(first.rest + "~").keys).toEqual([{ kind: "pageUp" }]);
  });

  it("parses every supported sequence split at each byte boundary", () => {
    const sequences: [string, string][] = [
      [`${ESC}[A`, "up"], [`${ESC}[B`, "down"], [`${ESC}[C`, "right"], [`${ESC}[D`, "left"],
      [`${ESC}[5~`, "pageUp"], [`${ESC}[6~`, "pageDown"],
    ];
    for (const [sequence, kind] of sequences) {
      for (let split = 1; split < sequence.length; split += 1) {
        const first = parseKeysBuffered(sequence.slice(0, split));
        const second = parseKeysBuffered(first.rest + sequence.slice(split));
        expect([...first.keys, ...second.keys]).toEqual([{ kind }]);
      }
    }
  });

  it("emits ordinary characters immediately", () => {
    expect(parseKeysBuffered("ab")).toEqual({
      keys: [{ kind: "char", value: "a" }, { kind: "char", value: "b" }],
      rest: "",
    });
  });
});
