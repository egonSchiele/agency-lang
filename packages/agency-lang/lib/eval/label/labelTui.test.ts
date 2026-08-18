import { describe, expect, it, vi } from "vitest";

import { ScriptedInput } from "@/tui/input/scripted.js";
import type { KeyEvent } from "@/tui/input/types.js";
import { FrameRecorder } from "@/tui/output/recorder.js";
import { Screen } from "@/tui/screen.js";

import type { LabelingSessionController } from "./controller.js";
import {
  actionForKey,
  isQuitKey,
  labelScreen,
  paneHeightFor,
  renderChecklist,
  pastedText,
  renderMarkdownSafely,
  runLabelTui,
  sanitizeUntrusted,
  scrollDelta,
  stripAnsi,
} from "./labelTui.js";
import type { SessionAction, SessionSnapshot } from "./session.js";

const TRACE_ID = "trace-1";

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const item = { traceId: TRACE_ID, fields: { input: "a task", output: "some output" } };
  return {
    items: [item],
    itemIndex: 0,
    questionIndex: 0,
    currentItem: item,
    currentQuestion: { id: "q_a", text: "Accurate?", weight: 1, deleted: false },
    questions: [
      { id: "q_a", text: "Accurate?", weight: 1, deleted: false },
      { id: "q_b", text: "Today?", weight: 1, deleted: true },
    ],
    answers: { q_a: true },
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

const key = (event: Partial<KeyEvent> & { key: string }): KeyEvent => event as KeyEvent;

/** Lay the element tree out through the real engine and read it as plain
 *  text — what the terminal would actually show, rather than a string this
 *  module assembled and this test re-parsed. */
function frameText(over: Partial<SessionSnapshot> = {}, size = { width: 100, height: 30 }): string {
  const recorder = new FrameRecorder();
  const screen = new Screen({
    input: new ScriptedInput(),
    output: recorder,
    width: size.width,
    height: size.height,
  });
  screen.render(
    labelScreen({
      snapshot: snapshot(over),
      title: "run-1",
      width: size.width,
      height: size.height,
      scroll: 0,
      body: ["output line one", "output line two"],
    }),
  );
  return recorder.lastText();
}

describe("frame content", () => {
  it("shows the header with reviewed progress", () => {
    const text = frameText();
    expect(text).toContain("label");
    expect(text).toContain("0/1 reviewed");
  });

  it("shows a ticked box for an answered question", () => {
    expect(frameText()).toContain("[✓] Accurate?");
  });

  it("shows a deleted question with a dot box rather than hiding it", () => {
    const text = frameText();
    expect(text).toContain("[·]");
    expect(text).toContain("Today?");
  });

  it("shows a dash rather than a number for an unscored item", () => {
    expect(frameText()).toMatch(/untouched\s+—/);
  });

  it("reports stale items in the header", () => {
    expect(frameText({ progress: { reviewed: 1, total: 3, stale: 2 } })).toContain("2 stale");
  });

  it("switches the footer to the question editor", () => {
    expect(frameText({ editor: { kind: "question", draft: "Sourced?" } })).toContain(
      "new question Sourced?",
    );
  });

  it("labels d as undelete when the focused question is deleted", () => {
    expect(
      frameText({ currentQuestion: { id: "q_b", text: "Today?", weight: 1, deleted: true } }),
    ).toContain("d undelete");
  });

  it("handles an empty corpus without throwing", () => {
    expect(frameText({ currentItem: null, items: [] })).toContain("nothing to label");
  });

  it("shows the output body in the left pane", () => {
    expect(frameText()).toContain("output line one");
  });

  it("keeps every rendered row within the terminal width", () => {
    for (const row of frameText().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("renderChecklist", () => {
  it("reports the line the focused question starts on", () => {
    expect(renderChecklist(snapshot({ questionIndex: 1 }), 40).focusLine).toBe(1);
  });

  it("accounts for wrapped questions when reporting the focus line", () => {
    const questions = [
      {
        id: "q_a",
        text: "A question long enough that it certainly wraps across several lines",
        weight: 1,
        deleted: false,
      },
      { id: "q_b", text: "Second", weight: 1, deleted: false },
    ];
    expect(
      renderChecklist(snapshot({ questions, questionIndex: 1 }), 24).focusLine,
    ).toBeGreaterThan(1);
  });
});

describe("checklist viewport", () => {
  function manyQuestions(count: number, focusIndex: number): Partial<SessionSnapshot> {
    const questions = Array.from({ length: count }, (_, index) => ({
      id: `q_${index}`,
      text: `Question number ${index}`,
      weight: 1,
      deleted: false,
    }));
    return { questions, questionIndex: focusIndex, currentQuestion: questions[focusIndex] };
  }

  it("keeps a question near the end of a long checklist visible", () => {
    // Without followCursor the pane always starts at question 0, so Space and
    // Enter would act on a checkbox the reader cannot see.
    expect(frameText(manyQuestions(40, 39), { width: 100, height: 20 })).toContain(
      "Question number 39",
    );
  });

  it("still shows the first question when focus is at the top", () => {
    expect(frameText(manyQuestions(40, 0), { width: 100, height: 20 })).toContain(
      "Question number 0",
    );
  });

  it("does not scroll a checklist that already fits", () => {
    const text = frameText(manyQuestions(3, 2), { width: 100, height: 30 });
    expect(text).toContain("Question number 0");
    expect(text).toContain("Question number 2");
  });
});

describe("renderMarkdownSafely", () => {
  it("preserves the content words of a markdown document", () => {
    const source =
      "## Heading\n\n- first bullet about reliability\n- second bullet about latency\n";
    const rendered = stripAnsi(renderMarkdownSafely(source));
    for (const word of ["reliability", "latency", "bullet", "Heading"]) {
      expect(rendered).toContain(word);
    }
  });
});

describe("actionForKey", () => {
  it("maps navigation and toggling while labelling", () => {
    expect(actionForKey(key({ key: " " }), false)).toEqual({ kind: "toggleAnswer" });
    expect(actionForKey(key({ key: "left" }), false)).toEqual({ kind: "previousItem" });
    expect(actionForKey(key({ key: "up" }), false)).toEqual({ kind: "previousQuestion" });
    expect(actionForKey(key({ key: "enter" }), false)).toEqual({ kind: "signOff" });
    expect(actionForKey(key({ key: "d" }), false)).toEqual({ kind: "toggleQuestionDeleted" });
  });

  it("routes printable keys into the editor while editing", () => {
    expect(actionForKey(key({ key: "x" }), true)).toEqual({ kind: "appendEditorText", text: "x" });
    expect(actionForKey(key({ key: "enter" }), true)).toEqual({ kind: "submitEditor" });
    expect(actionForKey(key({ key: "escape" }), true)).toEqual({ kind: "cancelEditor" });
  });

  it("keeps a ctrl chord out of the editor text", () => {
    expect(actionForKey(key({ key: "f", ctrl: true }), true)).toBeNull();
  });

  it("does not treat a ctrl chord as a command while labelling", () => {
    expect(actionForKey(key({ key: "d", ctrl: true }), false)).toBeNull();
  });

  it("treats space as text while editing, not as a toggle", () => {
    expect(actionForKey(key({ key: " " }), true)).toEqual({ kind: "appendEditorText", text: " " });
  });
});

describe("paste in the editor", () => {
  it("appends the whole clipboard in one action", () => {
    expect(actionForKey(key({ key: "paste", text: "some pasted text" }), true)).toEqual({
      kind: "appendEditorText",
      text: "some pasted text",
    });
  });

  it("is ignored outside the editor, where keys are commands", () => {
    expect(actionForKey(key({ key: "paste", text: "x" }), false)).toBeNull();
  });

  it("ignores an empty paste rather than dispatching a no-op", () => {
    expect(actionForKey(key({ key: "paste", text: "" }), true)).toBeNull();
  });

  it("collapses newlines and tabs, because the draft renders on one row", () => {
    expect(pastedText("first\nsecond\tthird")).toBe("first second third");
  });

  it("drops other control characters from pasted text", () => {
    expect(pastedText("safe\x1b[2Jhidden")).toBe("safe[2Jhidden");
  });

  it("leaves ordinary pasted text alone", () => {
    expect(pastedText("Is the information accurate?")).toBe("Is the information accurate?");
  });
});

describe("scrollDelta and isQuitKey", () => {
  it("pages with ctrl-f and ctrl-b", () => {
    expect(scrollDelta(key({ key: "f", ctrl: true }), 20)).toBeGreaterThan(0);
    expect(scrollDelta(key({ key: "b", ctrl: true }), 20)).toBeLessThan(0);
  });

  it("half-pages with ctrl-d and ctrl-u", () => {
    expect(scrollDelta(key({ key: "d", ctrl: true }), 20)).toBeLessThan(
      scrollDelta(key({ key: "f", ctrl: true }), 20),
    );
  });

  it("ignores the same letters without ctrl, which are commands", () => {
    expect(scrollDelta(key({ key: "d" }), 20)).toBe(0);
  });

  it("pages with the dedicated pageup and pagedown keys", () => {
    expect(scrollDelta(key({ key: "pagedown" }), 20)).toBeGreaterThan(0);
    expect(scrollDelta(key({ key: "pageup" }), 20)).toBeLessThan(0);
  });

  it("pages the same distance whether by page key or ctrl chord", () => {
    expect(scrollDelta(key({ key: "pagedown" }), 20)).toBe(
      scrollDelta(key({ key: "f", ctrl: true }), 20),
    );
  });

  it("treats q and ctrl-c as quit", () => {
    expect(isQuitKey(key({ key: "q" }))).toBe(true);
    expect(isQuitKey(key({ key: "c", ctrl: true }))).toBe(true);
    expect(isQuitKey(key({ key: "c" }))).toBe(false);
  });
});

function fakeController(over: Partial<SessionSnapshot> = {}) {
  const dispatched: SessionAction[] = [];
  const controller: LabelingSessionController = {
    snapshot: () => snapshot(over),
    dispatch: async (action) => {
      dispatched.push(action);
      return snapshot(over);
    },
    close: async () => {},
  };
  return { controller, dispatched };
}

function scriptedScreen(keys: (KeyEvent | string)[]) {
  const recorder = new FrameRecorder();
  const screen = new Screen({
    input: new ScriptedInput(keys),
    output: recorder,
    width: 100,
    height: 30,
  });
  return { screen, recorder };
}

describe("runLabelTui", () => {
  it("draws a frame and exits on quit", async () => {
    const { screen, recorder } = scriptedScreen(["q"]);
    const { controller } = fakeController();
    await runLabelTui({ controller, screen });
    expect(recorder.frames.length).toBeGreaterThan(0);
    expect(recorder.lastText()).toContain("label");
  });

  it("dispatches the action a key maps to", async () => {
    const { screen } = scriptedScreen([" ", "q"]);
    const { controller, dispatched } = fakeController();
    await runLabelTui({ controller, screen });
    expect(dispatched).toContainEqual({ kind: "toggleAnswer" });
  });

  it("does not dispatch for a page key either", async () => {
    const { screen } = scriptedScreen([key({ key: "pagedown" }), "q"]);
    const { controller, dispatched } = fakeController();
    await runLabelTui({ controller, screen });
    expect(dispatched).toEqual([]);
  });

  it("does not dispatch for a scroll chord", async () => {
    const { screen } = scriptedScreen([key({ key: "f", ctrl: true }), "q"]);
    const { controller, dispatched } = fakeController();
    await runLabelTui({ controller, screen });
    expect(dispatched).toEqual([]);
  });

  it("propagates a controller failure rather than swallowing it", async () => {
    const { screen } = scriptedScreen([" "]);
    const controller: LabelingSessionController = {
      snapshot: () => snapshot(),
      dispatch: async () => {
        throw new Error("controller exploded");
      },
      close: async () => {},
    };
    await expect(runLabelTui({ controller, screen })).rejects.toThrow(/exploded/);
  });

  it("never calls close: the CLI owns the session lifecycle", async () => {
    const { screen } = scriptedScreen(["q"]);
    const closed = vi.fn(async () => {});
    const controller: LabelingSessionController = {
      snapshot: () => snapshot(),
      dispatch: async () => snapshot(),
      close: closed,
    };
    await runLabelTui({ controller, screen });
    expect(closed).not.toHaveBeenCalled();
  });
});

describe("resizing", () => {
  it("adopts a new terminal size on the next draw", async () => {
    const { screen } = scriptedScreen(["q"]);
    const { controller } = fakeController();
    await runLabelTui({
      controller,
      screen,
      currentSize: () => ({ width: 60, height: 18 }),
    });
    expect(screen.size()).toEqual({ width: 60, height: 18 });
  });

  it("leaves the size alone when no provider is given", async () => {
    const { screen } = scriptedScreen(["q"]);
    const { controller } = fakeController();
    await runLabelTui({ controller, screen });
    expect(screen.size()).toEqual({ width: 100, height: 30 });
  });
});

describe("layout arithmetic", () => {
  it("leaves room for the chrome above and below the panes", () => {
    expect(paneHeightFor(30)).toBeLessThan(30);
  });

  it("keeps newlines and tabs when sanitizing", () => {
    expect(sanitizeUntrusted("a\nb\tc")).toBe("a\nb\tc");
  });
});
