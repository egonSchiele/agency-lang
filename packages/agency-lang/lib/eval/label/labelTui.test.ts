import { EventEmitter } from "events";

import { describe, expect, it, vi } from "vitest";

import type { LabelingSessionController } from "./controller.js";
import {
  actionForKey,
  isQuitKey,
  parseKeys,
  renderLabelScreen,
  renderMarkdownSafely,
  runLabelTui,
  scrollDelta,
  stripAnsi,
  visibleLength,
  wrapAnsi,
} from "./labelTui.js";
import type { SessionAction, SessionSnapshot } from "./session.js";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const item = { outputId: `out_${"a".repeat(64)}`, task: "a task", text: "some output" };
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
    statuses: { [item.outputId]: "untouched" },
    scores: { [item.outputId]: null },
    progress: { reviewed: 0, total: 1, stale: 0 },
    canSignOff: true,
    hasStagedQuestions: false,
    ...over,
  };
}

describe("visibleLength", () => {
  it("ignores colour codes", () => {
    expect(visibleLength(`${BOLD}abc${RESET}`)).toBe(3);
  });

  it("ignores OSC-8 hyperlinks, which carry a URL in zero columns", () => {
    const link = "\x1b]8;;https://example.com/very/long/path\x07label\x1b]8;;\x07";
    expect(visibleLength(link)).toBe(5);
  });
});

describe("wrapAnsi", () => {
  it("keeps every wrapped line within the width", () => {
    for (const line of wrapAnsi("the quick brown fox jumps over the lazy dog", 12)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(12);
    }
  });

  it("hard-breaks a token longer than the column", () => {
    const lines = wrapAnsi("x".repeat(50), 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(10);
    }
  });

  it("loses no visible words", () => {
    const source = "alpha beta gamma delta epsilon zeta";
    const joined = stripAnsi(wrapAnsi(source, 9).join(" "));
    for (const word of source.split(" ")) {
      expect(joined).toContain(word);
    }
  });

  it("does not let a hyperlink swallow the text after it", () => {
    const source = "(\x1b]8;;https://example.com/a/b/c\x07site\x1b]8;;\x07) and more words here";
    const joined = wrapAnsi(source, 40).join(" ");
    expect(joined).toContain("and more words here");
    expect(joined).toContain("site");
  });
});

describe("renderMarkdownSafely", () => {
  it("preserves the content words of a markdown document", () => {
    const source = "## Heading\n\n- first bullet about reliability\n- second bullet about latency\n";
    const rendered = stripAnsi(renderMarkdownSafely(source));
    for (const word of ["reliability", "latency", "bullet", "Heading"]) {
      expect(rendered).toContain(word);
    }
  });

  it("returns plain text unchanged when there is nothing to highlight", () => {
    expect(stripAnsi(renderMarkdownSafely("plain"))).toContain("plain");
  });
});

describe("renderLabelScreen", () => {
  const base = { storeLabel: "labels", columns: 100, rows: 30, scroll: 0, body: ["output line"] };

  it("aligns the divider on every body row", () => {
    const frame = stripAnsi(renderLabelScreen({ ...base, snapshot: snapshot() }));
    const columns = frame.split("\n").slice(5, 15).map((line) => line.indexOf("│"));
    expect(new Set(columns.filter((column) => column >= 0)).size).toBe(1);
  });

  it("shows a ticked box for an answered question and an empty one otherwise", () => {
    const frame = stripAnsi(renderLabelScreen({ ...base, snapshot: snapshot() }));
    expect(frame).toContain("[✓] Accurate?");
  });

  it("shows a deleted question with a dot box rather than hiding it", () => {
    const frame = stripAnsi(renderLabelScreen({ ...base, snapshot: snapshot() }));
    expect(frame).toContain("[·]");
    expect(frame).toContain("Today?");
  });

  it("shows a dash rather than a number for an unscored item", () => {
    const frame = stripAnsi(renderLabelScreen({ ...base, snapshot: snapshot() }));
    expect(frame).toMatch(/untouched\s+—/);
  });

  it("reports stale items in the header", () => {
    const frame = stripAnsi(renderLabelScreen({
      ...base, snapshot: snapshot({ progress: { reviewed: 1, total: 3, stale: 2 } }),
    }));
    expect(frame).toContain("2 stale");
  });

  it("switches the footer to the question editor", () => {
    const frame = stripAnsi(renderLabelScreen({
      ...base, snapshot: snapshot({ editor: { kind: "question", draft: "Sourced?" } }),
    }));
    expect(frame).toContain("new question Sourced?");
  });

  it("labels d as undelete when the focused question is deleted", () => {
    const frame = stripAnsi(renderLabelScreen({
      ...base,
      snapshot: snapshot({ currentQuestion: { id: "q_b", text: "Today?", weight: 1, deleted: true } }),
    }));
    expect(frame).toContain("d undelete");
  });

  it("handles an empty corpus without throwing", () => {
    const frame = stripAnsi(renderLabelScreen({
      ...base, snapshot: snapshot({ currentItem: null, items: [] }),
    }));
    expect(frame).toContain("nothing to label");
  });
});

describe("parseKeys", () => {
  it("parses arrows from one chunk", () => {
    expect(parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D").map((key) => key.kind))
      .toEqual(["up", "down", "right", "left"]);
  });

  it("parses enter, escape and backspace", () => {
    expect(parseKeys("\r\x1b\x7f").map((key) => key.kind)).toEqual(["enter", "escape", "backspace"]);
  });

  it("parses a space as a character", () => {
    expect(parseKeys(" ")).toEqual([{ kind: "char", value: " " }]);
  });
});

describe("actionForKey", () => {
  it("maps navigation and toggling while labelling", () => {
    expect(actionForKey({ kind: "char", value: " " }, false)).toEqual({ kind: "toggleAnswer" });
    expect(actionForKey({ kind: "left" }, false)).toEqual({ kind: "previousItem" });
    expect(actionForKey({ kind: "up" }, false)).toEqual({ kind: "previousQuestion" });
    expect(actionForKey({ kind: "enter" }, false)).toEqual({ kind: "signOff" });
    expect(actionForKey({ kind: "char", value: "d" }, false)).toEqual({ kind: "toggleQuestionDeleted" });
  });

  it("routes printable keys into the editor while editing", () => {
    expect(actionForKey({ kind: "char", value: "x" }, true))
      .toEqual({ kind: "appendEditorText", text: "x" });
    expect(actionForKey({ kind: "enter" }, true)).toEqual({ kind: "submitEditor" });
    expect(actionForKey({ kind: "escape" }, true)).toEqual({ kind: "cancelEditor" });
  });

  it("keeps a control key out of the editor text", () => {
    expect(actionForKey({ kind: "char", value: "\x06" }, true)).toBeNull();
  });

  it("does not treat space as a toggle while editing", () => {
    expect(actionForKey({ kind: "char", value: " " }, true))
      .toEqual({ kind: "appendEditorText", text: " " });
  });
});

describe("scrollDelta and isQuitKey", () => {
  it("scrolls by a page with ctrl-f and ctrl-b", () => {
    expect(scrollDelta({ kind: "char", value: "\x06" }, 30)).toBeGreaterThan(0);
    expect(scrollDelta({ kind: "char", value: "\x02" }, 30)).toBeLessThan(0);
  });

  it("scrolls by half a page with ctrl-d and ctrl-u", () => {
    expect(scrollDelta({ kind: "char", value: "\x04" }, 30))
      .toBeLessThan(scrollDelta({ kind: "char", value: "\x06" }, 30));
  });

  it("treats q and ctrl-c as quit", () => {
    expect(isQuitKey({ kind: "char", value: "q" })).toBe(true);
    expect(isQuitKey({ kind: "char", value: "\x03" })).toBe(true);
    expect(isQuitKey({ kind: "char", value: "a" })).toBe(false);
  });
});

/** A terminal pair that records what was written and lets a test push keys. */
function fakeTerminal(isTTY = true) {
  const input = new EventEmitter() as unknown as NodeJS.ReadStream & {
    setRawMode: ReturnType<typeof vi.fn>;
    isRaw: boolean;
  };
  input.isTTY = isTTY;
  input.isRaw = false;
  input.setRawMode = vi.fn((raw: boolean) => { input.isRaw = raw; return input; });
  input.resume = vi.fn(() => input);
  input.pause = vi.fn(() => input);
  input.setEncoding = vi.fn(() => input);
  const written: string[] = [];
  const output = {
    isTTY, columns: 100, rows: 30,
    write: (text: string) => { written.push(text); return true; },
  } as unknown as NodeJS.WriteStream;
  return { input, output, written };
}

function fakeController(over: Partial<SessionSnapshot> = {}) {
  const dispatched: SessionAction[] = [];
  const controller: LabelingSessionController = {
    snapshot: () => snapshot(over),
    dispatch: async (action) => { dispatched.push(action); return snapshot(over); },
    close: async () => {},
  };
  return { controller, dispatched };
}

describe("runLabelTui", () => {
  it("refuses a non-interactive terminal", async () => {
    const { input, output } = fakeTerminal(false);
    const { controller } = fakeController();
    await expect(runLabelTui({ controller, input, output }))
      .rejects.toThrow(/interactive terminal/i);
  });

  it("draws a frame on start and restores raw mode on quit", async () => {
    const { input, output, written } = fakeTerminal();
    const { controller } = fakeController();
    const done = runLabelTui({ controller, input, output });
    expect(written.length).toBeGreaterThan(0);
    input.emit("data", "q");
    await done;
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("dispatches the action a key maps to", async () => {
    const { input, output } = fakeTerminal();
    const { controller, dispatched } = fakeController();
    const done = runLabelTui({ controller, input, output });
    input.emit("data", " ");
    input.emit("data", "q");
    await done;
    expect(dispatched).toContainEqual({ kind: "toggleAnswer" });
  });

  it("restores raw mode when the controller throws", async () => {
    const { input, output } = fakeTerminal();
    const controller: LabelingSessionController = {
      snapshot: () => snapshot(),
      dispatch: async () => { throw new Error("controller exploded"); },
      close: async () => {},
    };
    const done = runLabelTui({ controller, input, output });
    input.emit("data", " ");
    await expect(done).rejects.toThrow(/exploded/);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("never calls close: the CLI owns the session lifecycle", async () => {
    const { input, output } = fakeTerminal();
    const closed = vi.fn(async () => {});
    const controller: LabelingSessionController = {
      snapshot: () => snapshot(),
      dispatch: async () => snapshot(),
      close: closed,
    };
    const done = runLabelTui({ controller, input, output });
    input.emit("data", "q");
    await done;
    expect(closed).not.toHaveBeenCalled();
  });
});
