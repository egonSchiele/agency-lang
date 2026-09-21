import { describe, expect, it } from "vitest";
import { FrameRecorder } from "../../tui/output/recorder.js";
import { layout } from "../../tui/layout.js";
import { render } from "../../tui/render/renderer.js";
import { sampleRunForest, event, loopEvents } from "../storyFixture.js";
import { buildForest } from "../tree.js";
import { transcriptBlocks } from "../transcript.js";
import { TranscriptScreen } from "./transcriptScreen.js";
const viewport = { rows: 40, cols: 130 };
function make(roots = sampleRunForest()) {
  return new TranscriptScreen(roots, roots[0].traceId);
}
function press(screen: TranscriptScreen, key: string) {
  return screen.handleKey({ key }, viewport);
}
function text(screen: TranscriptScreen, cols = 130, rows = 40) {
  const recorder = new FrameRecorder();
  recorder.write(render(layout(screen.render({ rows, cols }), cols, rows)));
  return recorder.lastText();
}
function systems(rounds = 2) {
  return buildForest([
    event("promptCompletion", 100, "L", null, {
      threadIdentity: "parent",
      messages: [
        { role: "system", content: "parent-only prompt" },
        { role: "system", content: "second parent prompt" },
      ],
      completion: { output: "parent answer" },
    }),
    event("promptCompletion", 200, "child", null, {
      threadIdentity: "child",
      messages: [{ role: "system", content: "child-only prompt" }],
      completion: { output: "child answer" },
    }),
    ...(rounds > 2
      ? [
          event("promptCompletion", 300, "L", null, {
            threadIdentity: "parent",
            messages: [
              { role: "system", content: "parent-only prompt" },
              { role: "system", content: "second parent prompt" },
            ],
            completion: { output: "later" },
          }),
        ]
      : []),
  ]);
}
describe("transcript screen", () => {
  it("starts collapsed and reveals a system prompt on s", () => {
    const screen = make(systems());
    expect(text(screen)).not.toContain("parent-only prompt");
    press(screen, "s");
    expect(text(screen)).toContain("parent-only prompt");
    expect(text(screen)).not.toContain("second parent prompt");
  });
  it("expands systems independently by thread and preserves them through follow", () => {
    const screen = make(systems());
    screen.setFocus("round:child:0");
    press(screen, "s");
    expect(text(screen)).toContain("child-only prompt");
    expect(text(screen)).not.toContain("parent-only prompt");
    screen.setData(systems(3));
    expect(text(screen)).toContain("child-only prompt");
    press(screen, "s");
    expect(text(screen)).not.toContain("child-only prompt");
    screen.setFocus("round:L:0");
    press(screen, "s");
    expect(text(screen)).toContain("second parent prompt");
  });
  it("decodes the final answer as Agency source", () => {
    const screen = make();
    press(screen, "G");
    expect(text(screen)).toContain("def archiveNotes(count: number): Result<string> {");
    expect(text(screen)).not.toContain("\\n");
  });
  it("shows tool size, time, interrupts and recorded status", () => {
    const screen = make(buildForest(loopEvents()));
    screen.setFocus("guide");
    expect(text(screen)).toMatch(/→ agencyGuide\(handlers.md\)\s+1 lines\s+6ms/);
    expect(text(screen)).toContain("⚠ std::read  approved");
    screen.setFocus("grep");
    expect(text(screen)).toContain("interrupt rejected; completion not recorded");
  });
  it("searches collapsed payloads, expands matches, and copies full text", () => {
    const screen = make(buildForest(loopEvents()));
    screen.applySearch("handlers.md");
    expect(text(screen)).toContain("Arguments");
    expect(press(screen, "y")).toMatchObject({
      kind: "copy",
      text: expect.stringContaining('"filename":"handlers.md"'),
    });
    expect(press(screen, "d")).toEqual({ kind: "openDetail", rowId: "guide" });
    expect(screen.escape()).toBe(true);
    expect(screen.escape()).toBe(false);
  });
  it("retains shared focus through follow and falls back after truncation", () => {
    const screen = make(systems());
    screen.setFocus("round:child:0");
    expect(screen.focusId()).toBe("round:child:0");
    screen.setData(systems(3));
    expect(screen.focusId()).toBe("round:child:0");
    screen.setFocus("child");
    expect(screen.focusId()).toBe("round:child:0");
    screen.setData(
      buildForest([
        event("promptCompletion", 100, "L", null, { completion: { output: "replacement" } }),
      ]),
    );
    expect(screen.focusId()).toBe("round:L:0");
    screen.setData([]);
    expect(screen.focusId()).toBeUndefined();
  });
  it("preserves literal style tags and escapes terminal controls", () => {
    const screen = make(
      buildForest([
        event("promptCompletion", 100, "L", null, {
          messages: [{ role: "user", content: "make it {bold}" }],
          completion: { output: "\u001b[31m{red-fg}" },
        }),
      ]),
    );
    expect(text(screen)).toContain("make it {bold}");
    expect(text(screen)).toContain("\\u001b[31m{red-fg}");
  });
  it("history requests and object replies are searchable with their call IDs", () => {
    const roots = buildForest([
      event("promptCompletion", 100, "L", null, {
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "seeded", name: "read", arguments: { path: "old" } }],
          },
          {
            role: "tool",
            name: "read",
            tool_call_id: "seeded",
            content: { errors: [], warnings: [] },
          },
        ],
      }),
    ]);
    const screen = make(roots);
    screen.applySearch("warnings");
    expect(text(screen)).toContain("warnings");
    expect(text(screen)).toContain("seeded");
    expect(press(screen, "d")).toEqual({ kind: "openDetail", rowId: "round:L:0" });
  });
  it.each([100, 130, 200])("renders the final answer at %i columns", (cols) => {
    const screen = make();
    screen.setFocus(
      transcriptBlocks(sampleRunForest()[0])
        .filter((block) => block.kind === "assistant")
        .at(-1)!.id,
    );
    const recorder = new FrameRecorder();
    recorder.write(render(layout(screen.render({ rows: 40, cols }), cols, 40)));
    expect(recorder.lastText()).toMatchSnapshot();
    recorder.writeHTML(`/tmp/pr7-transcript-${cols}.html`);
  });
});

it("pages inside a long block by display lines and keeps j/k on blocks", () => {
  const answer = Array.from({ length: 80 }, (_unused, position) => `line ${position}`).join("\n");
  const screen = make(
    buildForest([event("promptCompletion", 100, "L", null, { completion: { output: answer } })]),
  );
  const small = { cols: 100, rows: 12 };
  expect(text(screen, small.cols, small.rows)).toContain("line 0");
  screen.handleKey({ key: "d", ctrl: true }, small);
  expect(text(screen, small.cols, small.rows)).toContain("line 4");
  expect(text(screen, small.cols, small.rows)).not.toContain("line 0");
  expect(screen.focusId()).toBe("round:L:0");
  screen.handleKey({ key: "g" }, small);
  screen.handleKey({ key: "f", ctrl: true }, small);
  expect(text(screen, small.cols, small.rows)).toContain("line 9");
  expect(text(screen, small.cols, small.rows)).not.toContain("line 4");
  const keys = screen.helpLines().flatMap((line) => line.split(" — ")[0].split(" / "));
  expect(keys.filter((key, position) => keys.indexOf(key) !== position)).toEqual([]);
});

it("follow replaces pending approval with completion and preserves tool focus", () => {
  const events = [
    event("promptCompletion", 100, "L"),
    event("toolCallStart", 101, "tool", "L", { toolName: "read" }),
    event("interruptThrown", 102, "tool", "L", {
      interruptId: "read",
      interrupt: { effect: "std::read" },
    }),
  ];
  const screen = make(buildForest(events));
  screen.setFocus("tool");
  expect(text(screen)).toContain("awaiting interrupt response");
  events.push(
    event("interruptResolved", 103, "tool", "L", {
      interruptId: "read",
      outcome: "approved",
      interrupt: { effect: "std::read" },
    }),
    event("toolCall", 105, "tool", "L", { toolName: "read", output: "new result" }),
  );
  screen.setData(buildForest(events));
  expect(screen.focusId()).toBe("tool");
  expect(text(screen)).toContain("completed");
  expect(text(screen)).not.toContain("pending");
  screen.setData(buildForest(events.slice(0, 1)));
  expect(screen.focusId()).toBe("round:L:0");
});

it("scrolls to a search match deep inside an expanded result", () => {
  const events = loopEvents();
  events.find((event) => event.data.type === "toolCall")!.data.output = Array.from(
    { length: 100 },
    (_unused, position) => (position === 90 ? "needle inside result" : `ordinary ${position}`),
  ).join("\n");
  const screen = make(buildForest(events));
  screen.applySearch("needle inside result");
  expect(text(screen)).toContain("│needle inside result");
  expect(screen.focusId()).toBe("guide");
});

it("paging down from a short final block does not scroll backward", () => {
  const screen = make(systems());
  press(screen, "G");
  const before = text(screen);
  screen.handleKey({ key: "d", ctrl: true }, viewport);
  expect(text(screen)).toBe(before);
});
