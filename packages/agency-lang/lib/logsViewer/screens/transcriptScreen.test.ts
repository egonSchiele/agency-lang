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
        { role: "system", content: "parent-only prompt\nparent second line" },
        { role: "system", content: "second parent prompt\nsecond parent line" },
      ],
      completion: { output: "parent answer" },
    }),
    event("promptCompletion", 200, "child", null, {
      threadIdentity: "child",
      messages: [{ role: "system", content: "child-only prompt\nchild second line" }],
      completion: { output: "child answer" },
    }),
    ...(rounds > 2
      ? [
          event("promptCompletion", 300, "L", null, {
            threadIdentity: "parent",
            messages: [
              { role: "system", content: "parent-only prompt\nparent second line" },
              { role: "system", content: "second parent prompt\nsecond parent line" },
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
    // The first line is a signpost, as on the overview; the rest waits for s.
    expect(text(screen)).toContain("SYSTEM");
    expect(text(screen)).toContain("parent-only prompt");
    expect(text(screen)).toContain("… (+1 more line · s to show)");
    expect(text(screen)).not.toContain("parent second line");
    press(screen, "s");
    expect(text(screen)).toContain("parent second line");
    expect(text(screen)).toContain("s to hide");
    expect(text(screen)).not.toContain("child second line");
  });
  it("expands systems independently by thread and preserves them through follow", () => {
    const screen = make(systems());
    screen.setFocus("round:child:0");
    press(screen, "s");
    expect(text(screen)).toContain("child second line");
    expect(text(screen)).not.toContain("parent second line");
    screen.setData(systems(3));
    expect(text(screen)).toContain("child second line");
    press(screen, "s");
    expect(text(screen)).not.toContain("child second line");
    screen.setFocus("round:L:0");
    press(screen, "s");
    expect(text(screen)).toContain("second parent line");
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
    // The title rule names the tool and carries its size and time; the
    // arguments sit in the box, cut as on the trace's call row.
    expect(text(screen)).toMatch(/TOOL CALL · agencyGuide .*1 line · 6ms/);
    expect(text(screen)).toContain("filename: handlers.md");
    // An approved interrupt is hidden until p, as on the trace; a plain
    // success has no status line.
    expect(text(screen)).not.toContain("⚠ std::read  approved");
    expect(text(screen)).not.toMatch(/\n\s*completed\n/);
    press(screen, "p");
    expect(text(screen)).toContain("⚠ std::read  approved");
    screen.setFocus("grep");
    expect(text(screen)).toContain("interrupt rejected; completion not recorded");
  });
  it("searches collapsed payloads, expands matches, and copies full text", () => {
    const screen = make(buildForest(loopEvents()));
    screen.applySearch("handlers.md");
    expect(text(screen)).toContain("filename: handlers.md");
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
    press(screen, "#");
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
  const small = { cols: 100, rows: 13 };
  expect(text(screen, small.cols, small.rows)).toContain("line 0");
  screen.handleKey({ key: "d", ctrl: true }, small);
  expect(text(screen, small.cols, small.rows)).toContain("line 4");
  expect(text(screen, small.cols, small.rows)).not.toContain("line 0");
  expect(screen.focusId()).toBe("round:L:0");
  screen.handleKey({ key: "g" }, small);
  screen.handleKey({ key: "f", ctrl: true }, small);
  expect(text(screen, small.cols, small.rows)).toContain("line 10");
  expect(text(screen, small.cols, small.rows)).not.toContain("line 9");
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
  expect(text(screen)).toContain("TOOL CALL · read");
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
  expect(text(screen)).toContain("needle inside result");
  expect(screen.focusId()).toBe("guide");
});

it("paging down from a short final block does not scroll backward", () => {
  const screen = make(systems());
  press(screen, "G");
  const before = text(screen);
  screen.handleKey({ key: "d", ctrl: true }, viewport);
  expect(text(screen)).toBe(before);
});

it("keeps a searched tool visible when collapsing its long result", () => {
  const events = loopEvents();
  events.find((event) => event.data.type === "toolCall")!.data.output = Array.from(
    { length: 100 },
    (_unused, position) => (position === 90 ? "needle inside result" : `ordinary ${position}`),
  ).join("\n");
  const screen = make(buildForest(events));
  screen.applySearch("needle inside result");
  text(screen);
  press(screen, "enter");
  expect(text(screen)).toContain("TOOL CALL · agencyGuide");
  expect(screen.focusId()).toBe("guide");
});

it("finds and copies an owned final tool error without a later prompt snapshot", () => {
  const roots = buildForest([
    event("promptCompletion", 100, "L"),
    event("toolCallStart", 101, "write", "L", { toolName: "write", args: { path: "a" } }),
    event("error", 102, "write", "L", { message: "disk quota exceeded", destructiveRan: true }),
  ]);
  const screen = make(roots);
  screen.applySearch("disk quota exceeded");
  expect(screen.focusId()).toBe("write");
  expect(text(screen)).toContain("disk quota exceeded");
  expect(press(screen, "y")).toMatchObject({
    kind: "copy",
    text: expect.stringContaining("disk quota exceeded"),
  });
});

it.each([
  {
    type: "error",
    data: { message: "disk quota exceeded", destructiveRan: true },
    status: "tool failed; work occurred before it stopped",
  },
  { type: "toolCallStart", data: { toolName: "write" }, status: "completion not recorded" },
  {
    type: "interruptThrown",
    data: { interruptId: "write", interrupt: { effect: "std::write" } },
    status: "awaiting interrupt response",
  },
])("searches and copies the visible tool status: $status", ({ type, data, status }) => {
  const screen = make(
    buildForest([
      event("promptCompletion", 100, "L"),
      event("toolCallStart", 101, "write", "L", { toolName: "write", args: { path: "a" } }),
      event(type, 102, "write", "L", data),
    ]),
  );
  screen.applySearch(status);
  expect(screen.focusId()).toBe("write");
  expect(text(screen)).toContain("1 matches");
  expect(press(screen, "y")).toMatchObject({ kind: "copy", text: expect.stringContaining(status) });
});

it("reveals an interrupt message found inside a collapsed tool", () => {
  const screen = make(
    buildForest([
      event("promptCompletion", 100, "L"),
      event("toolCallStart", 101, "write", "L", { toolName: "write", args: { path: "a" } }),
      event("interruptThrown", 102, "write", "L", {
        interruptId: "write",
        interrupt: { effect: "std::write", message: "Approve replacing the archived notes?" },
      }),
    ]),
  );
  screen.applySearch("Approve replacing the archived notes?");
  expect(screen.focusId()).toBe("write");
  expect(text(screen)).toContain("Approve replacing the archived notes?");
  expect(press(screen, "y")).toMatchObject({
    kind: "copy",
    text: expect.stringContaining("Approve replacing the archived notes?"),
  });
});

it("cycles to the last or first match after moving to a nonmatching block", () => {
  const screen = make(
    buildForest([
      event("promptCompletion", 100, "L", null, { completion: { output: "needle first" } }),
      event("promptCompletion", 200, "L", null, { completion: { output: "ordinary" } }),
      event("promptCompletion", 300, "L", null, { completion: { output: "needle last" } }),
    ]),
  );
  screen.applySearch("needle");
  press(screen, "j");
  expect(screen.focusId()).toBe("round:L:1");
  press(screen, "N");
  expect(screen.focusId()).toBe("round:L:2");
  press(screen, "k");
  press(screen, "n");
  expect(screen.focusId()).toBe("round:L:0");
});

it("toggles continuous text line numbers and preserves focus and follow state", () => {
  const roots = buildForest([
    event("promptCompletion", 100, "L", null, {
      completion: { output: Array.from({ length: 80 }, (_, index) => `body ${index}`).join("\n") },
    }),
  ]);
  const screen = make(roots);
  const vp = { rows: 12, cols: 100 };
  const frame = () => text(screen, vp.cols, vp.rows);
  const before = frame();
  const focus = screen.focusId();
  screen.handleKey({ key: "#" }, vp);
  expect(frame()).toMatch(/│\s*1 /);
  screen.handleKey({ key: "pagedown" }, vp);
  expect(frame()).toMatch(/│\s*12 /);
  expect(screen.focusId()).toBe(focus);
  screen.setData(roots);
  expect(frame()).toMatch(/│\s*12 /);
  screen.handleKey({ key: "g" }, vp);
  screen.handleKey({ key: "#" }, vp);
  expect(frame()).toBe(before);
});

it("searches payload text rather than the numbered gutter", () => {
  const roots = buildForest([
    event("promptCompletion", 100, "L", null, {
      completion: {
        output: [...Array.from({ length: 70 }, () => "filler"), "target 42"].join("\n"),
      },
    }),
  ]);
  const screen = make(roots);
  screen.handleKey({ key: "#" }, viewport);
  screen.applySearch("42");
  expect(text(screen, 100, 12)).toContain("target 42");
});

describe("the call list and header", () => {
  it("heads the screen with the elapsed time and the cursor's place", () => {
    const screen = make(systems());
    expect(text(screen).split("\n")[0]).toMatch(/^Elapsed 100ms · block 1 of \d+/);
    press(screen, "j");
    expect(text(screen).split("\n")[0]).toContain("block 2 of");
  });

  it("indents a sub-agent's rows under the tool that started it and marks what Enter opens", () => {
    const ask = { id: "r", name: "researchAgent", arguments: {} };
    const screen = make(
      buildForest([
        event("promptCompletion", 100, "A", null, {
          threadIdentity: "main",
          messages: [{ role: "user", content: "go" }],
          completion: { output: "", toolCalls: [ask] },
        }),
        event("toolCallStart", 101, "t", "A", { toolName: "researchAgent", args: {} }),
        event("promptCompletion", 150, "B", "t", {
          threadIdentity: "main",
          messages: [
            { role: "user", content: "go" },
            { role: "system", content: "You research." },
            { role: "user", content: "research this" },
          ],
          completion: { output: "found" },
        }),
        event("toolCall", 160, "t", "A", { toolName: "researchAgent", output: "found" }),
        event("promptCompletion", 300, "A", null, {
          threadIdentity: "main",
          messages: [
            { role: "user", content: "go" },
            { role: "user", content: "[researchAgent finished. found]\nContinue." },
          ],
          completion: { output: "done" },
        }),
      ]),
    );
    const spineOf = () =>
      text(screen)
        .split("\n")
        .map((line) => line.split("│")[0].trimEnd());
    // The outline is the trace's: a thread row at its tool depth, its
    // messages one level in, a tool one level under its call, and the
    // sub-agent's thread row under the tool. The fold marker keeps one
    // column; the indent follows it.
    let spine = spineOf();
    expect(spine).toContain("▶ ▾ Thread · unnamed");
    expect(spine).toContain("      user");
    expect(spine).toContain("      LLM call 1");
    expect(spine).toContain("  ▸     researchAgent");
    expect(spine).toContain("  ▸       Thread · researchAgent");
    expect(spine).toContain("      ↩ researchAgent");
    // The sub-agent's group is complete, so it starts folded, as on the
    // trace: its prompt is not in the pane, and its row says so.
    expect(spine).not.toContain("            prompt");
    expect(text(screen)).toContain(
      "══ THREAD · researchAgent · 1 LLM call ══ ▸ folded · Enter opens",
    );
    expect(text(screen)).not.toContain("─ PROMPT · researchAgent ─");
    screen.setFocus("group:B");
    press(screen, "enter");
    spine = spineOf();
    expect(spine).toContain("▶ ▾       Thread · researchAgent");
    expect(spine).toContain("  ▸         system");
    expect(spine).toContain("            prompt");
    expect(spine).toContain("            LLM call 2");
    const body = text(screen);
    expect(body).toContain("─ PROMPT · researchAgent ─");
    expect(body).toContain("─ HAND-BACK · researchAgent ─");
    // Inside the group the pane rows carry a rail and the level's tint.
    const railed = body.split("\n").find((line) => line.includes("PROMPT · researchAgent"))!;
    expect(railed.split("│")[1]).toMatch(/^ ┃ /);
    screen.setFocus("t");
    press(screen, "enter");
    expect(spineOf()).toContain("▶ ▾     researchAgent");
  });

  it("paints a breadcrumb over the first row when the pane is scrolled into a sub-agent's group", () => {
    const calls = Array.from({ length: 12 }, (_unused, position) =>
      event("promptCompletion", 150 + position, "B", "t", {
        threadIdentity: "main",
        messages: [{ role: "user", content: `step ${position}\n`.repeat(6) }],
        completion: { output: `did ${position}` },
      }),
    );
    const screen = make(
      buildForest([
        event("promptCompletion", 100, "A", null, {
          threadIdentity: "main",
          messages: [{ role: "user", content: "go" }],
          completion: {
            output: "",
            toolCalls: [{ id: "c1", name: "researchAgent", arguments: {} }],
          },
        }),
        event("toolCallStart", 101, "t", "A", {
          toolName: "researchAgent",
          toolCallId: "c1",
          args: {},
        }),
        ...calls,
        event("toolCall", 400, "t", "A", {
          toolName: "researchAgent",
          toolCallId: "c1",
          output: "found",
        }),
      ]),
    );
    // Search opens the fold on the way to its match and lands inside the group.
    screen.applySearch("did 9");
    expect(screen.focusId()).toBe("round:B:9");
    const first = text(screen).split("\n")[2].split("│")[1];
    expect(first).toContain("researchAgent › Thread · researchAgent · 12 LLM calls");
    // Scrolled so a box's title is the first row, the title shows instead.
    press(screen, "k");
    press(screen, "k");
    screen.handleKey({ key: "d", ctrl: true }, viewport);
    const rows = text(screen).split("\n");
    const top = rows[2].split("│")[1];
    if (top.includes("┌─") || top.includes("┏━")) {
      expect(top).not.toContain("›");
    }
  });
  it("keeps a group the reader opened open through a follow update, and unfolds one that runs again", () => {
    const events = [
      event("promptCompletion", 100, "A", null, {
        threadIdentity: "main",
        messages: [{ role: "user", content: "go" }],
        completion: { output: "", toolCalls: [{ id: "c1", name: "researchAgent", arguments: {} }] },
      }),
      event("toolCallStart", 101, "t", "A", {
        toolName: "researchAgent",
        toolCallId: "c1",
        args: {},
      }),
      event("promptCompletion", 150, "B", "t", {
        threadIdentity: "main",
        messages: [{ role: "user", content: "research this" }],
        completion: { output: "found" },
      }),
      event("toolCall", 160, "t", "A", {
        toolName: "researchAgent",
        toolCallId: "c1",
        output: "found",
      }),
    ];
    const screen = make(buildForest(events));
    expect(text(screen)).toContain("▸ folded");
    screen.setFocus("group:B");
    press(screen, "enter");
    expect(text(screen)).not.toContain("▸ folded");
    screen.setData(
      buildForest([
        ...events,
        event("promptCompletion", 300, "A", null, { completion: { output: "done" } }),
      ]),
    );
    expect(text(screen)).not.toContain("▸ folded");
  });
  it("previews a tool's result under a rule, and grows the box in place on Enter", () => {
    const events = loopEvents();
    events.find((event) => event.data.type === "toolCall")!.data.output = Array.from(
      { length: 30 },
      (_unused, position) => `result line ${position}`,
    ).join("\n");
    const screen = make(buildForest(events));
    screen.setFocus("guide");
    const before = text(screen).split("\n");
    const title = before.findIndex((line) => line.includes("TOOL CALL · agencyGuide"));
    expect(before.join("\n")).toMatch(/── RESULT · ~\d+ tokens ─+/);
    expect(before.join("\n")).toContain("result line 0");
    expect(before.join("\n")).toContain("… (+29 more lines · Enter opens)");
    expect(before.join("\n")).not.toContain("result line 1");
    press(screen, "enter");
    const after = text(screen).split("\n");
    // The box opens where it stands: its title row has not moved.
    expect(after.findIndex((line) => line.includes("TOOL CALL · agencyGuide"))).toBe(title);
    expect(after.join("\n")).toContain("result line 1");
    expect(after.join("\n")).toMatch(/── RESULT · ~\d+ tokens ─+/);
  });
  it("names a reply's tool calls on one line and shows a request no tool ran whole", () => {
    const screen = make(
      buildForest([
        event("promptCompletion", 100, "L", null, {
          threadIdentity: "main",
          messages: [{ role: "user", content: "go" }],
          completion: {
            output: "",
            toolCalls: [
              { id: "c1", name: "grep", arguments: { pattern: "a" } },
              { id: "c2", name: "imaginary", arguments: { what: "never ran" } },
            ],
          },
        }),
        event("toolCallStart", 101, "g", "L", { toolName: "grep", toolCallId: "c1", args: {} }),
        event("toolCall", 102, "g", "L", { toolName: "grep", toolCallId: "c1", output: "x" }),
      ]),
    );
    const body = text(screen);
    expect(body).toContain("→ 2 tool calls · grep, imaginary");
    expect(body).not.toContain("TOOL CALL · grep · c1");
    expect(body).toContain("TOOL CALL · imaginary · c2");
    expect(body).toContain("what: never ran");
  });
  it("keeps the active box where it is until it would leave the pane", () => {
    const screen = make(buildForest(loopEvents()));
    expect(text(screen).split("\n")[1]).toContain("┏━ USER");
    press(screen, "j");
    press(screen, "j");
    // Moving down within the pane does not scroll: the first box is still
    // at the top, and the heavy rule marks the active one further down.
    const moved = text(screen).split("\n");
    expect(moved[1]).toContain("┌─ USER");
    expect(moved.findIndex((line) => line.includes("┏━"))).toBeGreaterThan(1);
  });
  it("cuts a long argument on the call and shows what the model read on the tool", () => {
    const long = "x".repeat(200);
    const screen = make(
      buildForest([
        event("promptCompletion", 100, "L", null, {
          threadIdentity: "main",
          messages: [{ role: "user", content: "go" }],
          completion: {
            output: "",
            toolCalls: [{ id: "c", name: "read", arguments: { path: long } }],
          },
        }),
        event("toolCallStart", 101, "tool", "L", { toolName: "read", args: { path: long } }),
        event("toolCall", 102, "tool", "L", { toolName: "read", output: "a".repeat(10) }),
        event("promptCompletion", 200, "L", null, {
          threadIdentity: "main",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c", name: "read", arguments: { path: long } }],
            },
            {
              role: "tool",
              name: "read",
              tool_call_id: "c",
              content: "aaa [tool result truncated]",
            },
          ],
          completion: { output: "done" },
        }),
      ]),
    );
    const before = text(screen, 300, 40);
    expect(before).toContain(`path: ${"x".repeat(120)}…`);
    expect(before).not.toContain("── WHAT THE MODEL READ");
    screen.setFocus("tool");
    press(screen, "enter");
    const after = text(screen, 300, 40);
    expect(after).toContain(`path: ${"x".repeat(200)}`);
    expect(after).toContain("── WHAT THE MODEL READ");
    expect(after).toContain("aaa [tool result truncated]");
  });
});
