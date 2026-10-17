import { expect, it } from "vitest";
import { layout } from "../../tui/layout.js";
import { render as renderFrame } from "../../tui/render/renderer.js";
import { parseStyledText } from "../../tui/styleParser.js";
import type { Element } from "../../tui/elements.js";
import { leaf, span, trace } from "../timeline/fixture.js";
import { agentLoopTrace } from "../storyFixture.js";
import { OverviewScreen } from "./overviewScreen.js";

const viewport = { rows: 30, cols: 130 };
function fixture(count = 3) {
  return [
    trace([
      span(
        "llmCall",
        Array.from({ length: count }, (_, index) =>
          leaf("promptCompletion", (index + 1) * 2000, {
            model: '"m1"',
            timeTaken: (index + 1) * 100,
            usage: { inputTokens: 95 + index, cachedInputTokens: 13824, outputTokens: 190 },
            cost: { totalCost: (index + 1) * 0.0000123 },
            completion: {
              output: Array.from(
                { length: 60 },
                (_, line) => `answer ${index + 1} line ${line + 1}`,
              ).join("\n"),
            },
          }),
        ),
        { id: "L" },
      ),
    ]),
  ];
}
/** The fixture records no input, so these tests read the output pane. */
function screen(count = 3) {
  const view = new OverviewScreen(fixture(count), "T", () => 40000);
  view.handleKey({ key: "tab" }, viewport);
  return view;
}
function flat(element: Element): string[] {
  return element.type === "text"
    ? [
        parseStyledText(element.content ?? "")
          .map((part) => part.text)
          .join(""),
      ]
    : (element.children ?? []).flatMap(flat);
}
function frame(view: OverviewScreen, size = viewport): string {
  return renderFrame(layout(view.render(size), size.cols, size.rows)).toPlainText();
}
function tickRows(view: OverviewScreen, size = viewport): string[] {
  return flat(view.render(size))
    .map((row) => row.split(" │ ")[0])
    .filter((row) => /^\s+\d+(?:\s+\d+)*\s*$/.test(row));
}

it("links all three graphs and the preview to one call selected with arrows", () => {
  const view = screen();
  view.handleKey({ key: "right" }, viewport);
  expect(view.focusId()).toBe("round:L:1");
  const text = frame(view);
  for (const title of [
    "CONTEXT PER LLM CALL",
    "COST PER LLM CALL",
    "TIME PER LLM CALL",
    "LLM CALL 2",
  ])
    expect(text).toContain(title);
  expect(text).toContain("answer 2 line 1");
  expect(text).toContain("13,920");
  expect(text).toContain("$0.000025");
  expect(text).toContain("200ms");
  expect(text).not.toContain("WHERE THE TIME WENT");
  expect(text).not.toContain("FACTS");
  expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
    kind: "openScreen",
    screen: "trace",
    focusId: "round:L:1",
  });
  view.handleKey({ key: "left" }, viewport);
  expect(view.focusId()).toBe("round:L:0");
});
it("scrolls the preview without changing the call and resets scroll on selection", () => {
  const view = screen();
  view.handleKey({ key: "pagedown" }, viewport);
  expect(view.focusId()).toBe("round:L:0");
  expect(frame(view)).not.toContain("answer 1 line 1\n");
  expect(frame(view)).toContain("answer 1 line 30");
  view.handleKey({ key: "up" }, viewport);
  view.handleKey({ key: "right" }, viewport);
  expect(frame(view)).toContain("answer 2 line 1");
});
it("keeps the call's metadata visible while scrolling its response", () => {
  const view = screen();
  view.handleKey({ key: "end", ctrl: true }, viewport);
  expect(frame(view)).toContain("LLM CALL 1");
  expect(frame(view)).toContain("13,919");
  expect(frame(view)).toContain("answer 1 line 60");
});
it("scrolls all three graphs together to a carried focus and keeps full tick numbers", () => {
  const view = screen(120);
  view.setFocus("round:L:110");
  const ticks = tickRows(view, { rows: 30, cols: 100 });
  expect(ticks).toHaveLength(3);
  expect(ticks[0]).toBe(ticks[1]);
  expect(ticks[1]).toBe(ticks[2]);
  expect(ticks[0]).toMatch(/\b111\b/);
  expect(frame(view)).toContain("answer 111 line 1");
});
it("keeps selection by stable ID on append and falls back when that call disappears", () => {
  const view = screen();
  view.setFocus("round:L:1");
  view.setData(fixture(4));
  expect(view.focusId()).toBe("round:L:1");
  view.setData(fixture(1));
  expect(view.focusId()).toBe("round:L:0");
  expect(frame(view)).toContain("answer 1 line 1");
});
it("does not move past either end", () => {
  const view = screen();
  view.handleKey({ key: "left" }, viewport);
  expect(view.focusId()).toBe("round:L:0");
  for (let index = 0; index < 5; index++) view.handleKey({ key: "right" }, viewport);
  expect(view.focusId()).toBe("round:L:2");
});
it.each([16, 20, 30, 50])("keeps all graph titles and the footer visible in %i rows", (rows) => {
  const view = screen();
  const text = frame(view, { rows, cols: 100 });
  expect(text).toContain("TIME PER LLM CALL");
  expect(text.split("\n").at(-1)).toContain("[OVERVIEW]");
});
it.each([100, 130, 200])("renders the linked graphs and preview at %i columns", (cols) => {
  expect(frame(screen(), { rows: 30, cols })).toMatchSnapshot();
});
it("handles traces with no completions and empty data", () => {
  const view = screen(0);
  expect(frame(view)).toContain("No completed LLM calls");
  expect(view.handleKey({ key: "enter" }, viewport)).toEqual({ kind: "none" });
  view.setData([]);
  expect(view.focusId()).toBeUndefined();
  expect(frame(view)).toContain("No trace selected");
});

it("highlights the selected column and its number in all three charts, including zero bars", () => {
  const roots = fixture();
  roots[0].children[0].children[1].event!.data.cost = { totalCost: 0 };
  roots[0].children[0].children[1].event!.data.timeTaken = 0;
  const view = new OverviewScreen(roots, "T", () => undefined);
  view.setFocus("round:L:1");
  function styled(element: Element): ReturnType<typeof parseStyledText> {
    return element.type === "text"
      ? parseStyledText(element.content ?? "")
      : (element.children ?? []).flatMap(styled);
  }
  const highlighted = styled(view.render(viewport)).filter(
    (part) => part.bg !== undefined && part.text.trim() === "2",
  );
  expect(highlighted).toHaveLength(3);
  expect(highlighted.every((part) => part.bold)).toBe(true);
  expect(frame(view)).toContain("0ms · $0");
});
it("shows tool requests and literal style tags in the preview", () => {
  const roots = fixture(1);
  roots[0].children[0].children[0].event!.data.completion = {
    output: "{bold}literal{/bold}",
    tool_calls: [
      { id: "a", type: "function", function: { name: "read", arguments: '{"path":"notes.md"}' } },
    ],
  };
  const view = new OverviewScreen(roots, "T", () => undefined);
  view.handleKey({ key: "tab" }, viewport);
  expect(frame(view)).toContain("{bold}literal{/bold}");
  expect(frame(view)).toContain("TOOL CALL · read");
  expect(frame(view)).toContain("notes.md");
});
it("keeps chart scales fixed while browsing a long trace", () => {
  const view = screen(120);
  const left = () => flat(view.render(viewport)).map((row) => row.split(" │ ")[0]);
  const scales = (rows: string[]) =>
    rows.filter((row) => /(?:ms|k|\$)/.test(row)).map((row) => row.slice(0, 10));
  const before = scales(left());
  view.setFocus("round:L:119");
  expect(scales(left())).toEqual(before);
});

it("keeps a carried span id as the focus while previewing its first call", () => {
  const view = screen();
  view.setFocus("L");
  expect(frame(view)).toContain("LLM CALL 1");
  expect(view.focusId()).toBe("L");
});
it("formats a summed cost without floating-point noise", () => {
  const roots = fixture(1);
  roots[0].children[0].children[0].event!.data.cost = { totalCost: 0.1 + 0.2 };
  const text = frame(new OverviewScreen(roots, "T", () => undefined));
  expect(text).toContain("$0.300");
  expect(text).not.toContain("0.30000000000000004");
});

it("previews a tool's owning call and preserves the tool when passing back through overview", () => {
  const view = new OverviewScreen([agentLoopTrace()], "T", () => undefined);
  view.setFocus("grep");
  expect(frame(view)).toContain("LLM CALL 2");
  expect(view.focusId()).toBe("grep");
  view.handleKey({ key: "down" }, viewport);
  expect(view.focusId()).toBe("grep");
  expect(view.handleKey({ key: "enter" }, viewport)).toEqual({
    kind: "openScreen",
    screen: "trace",
    focusId: "round:L:1",
  });
  view.handleKey({ key: "right" }, viewport);
  expect(view.focusId()).toBe("round:L:2");
});

function inputScreen() {
  const roots = fixture();
  for (const [index, node] of roots[0].children[0].children.entries()) {
    node.event!.data.messages = [
      { role: "system", content: "system secret line 1\nsystem secret line 2" },
      {
        role: "user",
        content: Array.from(
          { length: 60 },
          (_, line) => `input ${index + 1} line ${line + 1}`,
        ).join("\n"),
      },
      {
        role: "assistant",
        content: "earlier answer",
        tool_calls: [
          { id: "read-1", function: { name: "read", arguments: '{"path":"notes.md"}' } },
        ],
      },
      { role: "tool", tool_call_id: "read-1", name: "read", content: "tool reply" },
    ];
  }
  return new OverviewScreen(roots, "T", () => undefined);
}
it("opens on the recorded input and toggles to output without changing graphs, selection or metrics", () => {
  const view = inputScreen();
  const text = frame(view);
  expect(text).toContain("[INPUT] OUTPUT");
  expect(text).toContain("USER");
  expect(text).toContain("input 1 line 1");
  expect(text).not.toContain("answer 1 line 1");
  expect(text).toContain("13,919");
  expect(text).toContain("tab input/output");
  const before = tickRows(view);
  view.handleKey({ key: "tab" }, viewport);
  const output = frame(view);
  expect(output).toContain("INPUT [OUTPUT]");
  expect(output).toContain("answer 1 line 1");
  expect(output).not.toContain("input 1 line 1");
  expect(output).toContain("13,919");
  expect(view.focusId()).toBe("round:L:0");
  expect(tickRows(view)).toEqual(before);
});
it("preserves separate input and output scroll positions", () => {
  const view = inputScreen();
  view.handleKey({ key: "end", ctrl: true }, viewport);
  const input = frame(view);
  expect(input).toContain("tool reply");
  expect(input).toContain("TOOL CALL · read · read-1");
  view.handleKey({ key: "tab" }, viewport);
  view.handleKey({ key: "pagedown" }, viewport);
  const output = frame(view);
  expect(output).toContain("answer 1 line 30");
  view.handleKey({ key: "tab" }, viewport);
  expect(frame(view)).toBe(input);
  view.handleKey({ key: "tab" }, viewport);
  expect(frame(view)).toBe(output);
});
it("collapses the system prompt until s is pressed and retains expansion across toggles", () => {
  const view = inputScreen();
  expect(frame(view)).toContain("System prompt · 2 lines · s to show");
  expect(frame(view)).not.toContain("system secret");
  view.handleKey({ key: "s" }, viewport);
  expect(frame(view)).toContain("system secret line 1");
  expect(frame(view)).toContain("s to hide");
  view.handleKey({ key: "tab" }, viewport);
  view.handleKey({ key: "tab" }, viewport);
  expect(frame(view)).toContain("system secret line 2");
  view.handleKey({ key: "s" }, viewport);
  expect(frame(view)).not.toContain("system secret");
});
it("keeps input mode but resets both scroll positions and system expansion on another call", () => {
  const view = inputScreen();
  view.handleKey({ key: "tab" }, viewport);
  view.handleKey({ key: "end", ctrl: true }, viewport);
  view.handleKey({ key: "tab" }, viewport);
  view.handleKey({ key: "s" }, viewport);
  view.handleKey({ key: "end", ctrl: true }, viewport);
  view.handleKey({ key: "right" }, viewport);
  expect(frame(view)).toContain("[INPUT] OUTPUT");
  expect(frame(view)).toContain("input 2 line 1");
  expect(frame(view)).not.toContain("system secret");
  view.handleKey({ key: "tab" }, viewport);
  expect(frame(view)).toContain("answer 2 line 1");
});
it("explains when an older log did not record the input", () => {
  const view = new OverviewScreen(fixture(), "T", () => 40000);
  expect(frame(view)).toContain("Input messages were not recorded.");
});

it("uses g/G for the first and last LLM call, leaving preview scrolling separate", () => {
  const view = screen(120);
  view.handleKey({ key: "G" }, viewport);
  expect(view.focusId()).toBe("round:L:119");
  expect(frame(view)).toContain("answer 120 line 1");
  view.handleKey({ key: "g" }, viewport);
  expect(view.focusId()).toBe("round:L:0");
  view.handleKey({ key: "pagedown" }, viewport);
  expect(view.focusId()).toBe("round:L:0");
  expect(frame(view)).toContain("answer 1 line 30");
  view.handleKey({ key: "home", ctrl: true }, viewport);
  expect(frame(view)).toContain("answer 1 line 1");
});
it.each([100, 130, 200])("pages by the number of visible calls at %i columns", (cols) => {
  const view = screen(120);
  const size = { rows: 30, cols };
  const visible = tickRows(view, size)[0].trim().split(/\s+/).length;
  const half = Math.max(1, Math.floor(visible / 2));
  view.handleKey({ key: "f", ctrl: true }, size);
  expect(view.focusId()).toBe(`round:L:${visible}`);
  expect(frame(view, size)).toContain(`LLM CALL ${visible + 1}`);
  view.handleKey({ key: "d", ctrl: true }, size);
  expect(view.focusId()).toBe(`round:L:${visible + half}`);
  view.handleKey({ key: "u", ctrl: true }, size);
  expect(view.focusId()).toBe(`round:L:${visible}`);
  view.handleKey({ key: "b", ctrl: true }, size);
  expect(view.focusId()).toBe("round:L:0");
  view.handleKey({ key: "b", ctrl: true }, size);
  expect(view.focusId()).toBe("round:L:0");
  view.handleKey({ key: "G" }, size);
  view.handleKey({ key: "f", ctrl: true }, size);
  expect(view.focusId()).toBe("round:L:119");
});
it("uses the resized chart capacity even before the next render", () => {
  const view = screen(120);
  frame(view, { rows: 30, cols: 100 });
  const size = { rows: 30, cols: 200 };
  const expected = tickRows(screen(120), size)[0].trim().split(/\s+/).length;
  view.handleKey({ key: "f", ctrl: true }, size);
  expect(view.focusId()).toBe(`round:L:${expected}`);
});

it("says how the run ended and counts its errors in the header, and marks failed calls", () => {
  const tool = span(
    "toolExecution",
    [
      leaf("toolCallStart", 2_100, { toolName: "write", args: { path: "a" } }),
      leaf("error", 2_200, { message: "disk full", errorType: "toolError" }),
    ],
    { id: "t" },
  );
  tool.firstTs = 2_100;
  const roots = [
    trace([
      leaf("agentStart", 0, { entryNode: "main" }),
      span(
        "llmCall",
        [
          leaf("promptCompletion", 2_000, {
            model: '"m1"',
            timeTaken: 100,
            completion: { toolCalls: [{ name: "write", arguments: { path: "a" } }] },
          }),
          tool,
          leaf("promptCompletion", 4_000, {
            model: '"m1"',
            timeTaken: 100,
            completion: { output: "gave up" },
          }),
        ],
        { id: "L" },
      ),
      leaf("error", 4_500, { message: "Resume desync", errorType: "runtimeError" }),
      leaf("agentEnd", 4_600, {}),
    ]),
  ];
  const view = new OverviewScreen(roots, "T", () => undefined);
  view.handleKey({ key: "tab" }, viewport);
  const text = frame(view);
  expect(text).toContain("✖ crashed");
  expect(text).toContain("✖ 2 errors");
  expect(text).toContain("✖ failed");
  expect(text).toContain("✖ RESULT · tool failed");
  expect(text).toContain("disk full");
  // The ✖ row sits under the call numbers, one mark per failed call.
  const marks = flat(view.render(viewport))
    .map((row) => row.split(" │ ")[0])
    .filter((row) => /^\s+✖(\s+✖)*\s*$/.test(row));
  expect(marks.length).toBeGreaterThan(0);
});

it("reads paused while an interrupt waits on a person", () => {
  const roots = [
    trace([
      leaf("agentStart", 0, { entryNode: "main" }),
      span("llmCall", [leaf("promptCompletion", 1_000, { timeTaken: 100 })], { id: "L" }),
      leaf("interruptResolved", 1_500, { interruptId: "i", outcome: "passed" }),
    ]),
  ];
  expect(frame(new OverviewScreen(roots, "T", () => undefined))).toContain(
    "⏸ paused for a response",
  );
});

it("colors call numbers by thread and lists the threads when there are several", () => {
  const roots = [
    trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1_000, {
            timeTaken: 10,
            threadIdentity: "a",
            threadLabel: "main",
          }),
        ],
        { id: "A" },
      ),
      span(
        "llmCall",
        [
          leaf("promptCompletion", 2_000, {
            timeTaken: 10,
            threadIdentity: "b",
            threadLabel: "check",
          }),
        ],
        { id: "B" },
      ),
    ]),
  ];
  const text = frame(new OverviewScreen(roots, "T", () => undefined));
  expect(text).toContain("threads  ■ main  ■ check");
  expect(text).toContain("thread main");
});

it("previews a decision call as its state and questions, and its answers with bars", () => {
  const roots = [
    trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1_000, {
            model: '"laya"',
            timeTaken: 50,
            usageKind: "decision",
            messages: [{ role: "user", content: "Are you able to set up a recurring job?" }],
            completion: { output: JSON.stringify({ response: "curious" }) },
            decision: {
              state: [{ role: "user", content: "Are you able to set up a recurring job?" }],
              questions: {
                response: {
                  type: "choice",
                  instructions: "Which expression?",
                  criteria: { idle: "i", curious: "c" },
                },
              },
              answers: {
                response: {
                  type: "choice",
                  choice: "curious",
                  confidence: 0.7,
                  probabilities: { curious: 0.86, idle: 0.14 },
                },
              },
            },
          }),
        ],
        { id: "L" },
      ),
    ]),
  ];
  const view = new OverviewScreen(roots, "T", () => undefined);
  const input = frame(view);
  expect(input).toContain("LLM CALL 1 · DECISION · curious 86%");
  expect(input).toContain("STATE");
  expect(input).toContain("response · choice · idle, curious");
  expect(input).toContain("Which expression?");
  view.handleKey({ key: "tab" }, viewport);
  const output = frame(view);
  expect(output).toContain("ANSWER · response");
  expect(output).toMatch(/curious █+░* 86%/);
});

function growingInputScreen() {
  const roots = fixture(2);
  const history = [
    { role: "system", content: "rules" },
    {
      role: "user",
      content: Array.from({ length: 40 }, (_, line) => `first question line ${line + 1}`).join(
        "\n",
      ),
    },
  ];
  const [first, second] = roots[0].children[0].children;
  first.event!.data.messages = history;
  second.event!.data.messages = [
    ...history,
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ];
  return new OverviewScreen(roots, "T", () => undefined);
}
it("folds a later call's history to a stub, and e opens it faded above the new messages", () => {
  const view = growingInputScreen();
  view.handleKey({ key: "right" }, viewport);
  const text = frame(view);
  expect(text).toContain("first question line 1");
  expect(text).toContain("… (+1 earlier message)");
  expect(text).not.toContain("first question line 2");
  expect(text).toContain("second question");
  expect(text).toContain("13,920");
  expect(text).toContain("e earlier");
  view.handleKey({ key: "e" }, viewport);
  const opened = frame(view);
  expect(opened).toContain("── 2 earlier messages above · NEW ──");
  expect(opened).toContain("second question");
  expect(opened).not.toContain("first question line 1");
  view.handleKey({ key: "home", ctrl: true }, viewport);
  const top = frame(view);
  expect(top).toContain("first question line 1");
  expect(top).toContain("System prompt · 1 line · s to show");
  view.handleKey({ key: "e" }, viewport);
  expect(frame(view)).toContain("… (+1 earlier message)");
  view.handleKey({ key: "left" }, viewport);
  expect(frame(view)).toContain("first question line 1");
  expect(frame(view)).not.toContain("e earlier");
});

it("cuts a long tool result with a hint, and x shows it whole", () => {
  const long = Array.from({ length: 120 }, (_, n) => `line ${n + 1}`).join("\n");
  const tool = span(
    "toolExecution",
    [
      leaf("toolCallStart", 2_100, { toolName: "read", args: { path: "a" } }),
      leaf("toolCall", 2_200, { toolName: "read", output: long }),
    ],
    { id: "t" },
  );
  tool.firstTs = 2_100;
  const roots = [
    trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 2_000, {
            model: '"m1"',
            timeTaken: 100,
            completion: { toolCalls: [{ name: "read", arguments: { path: "a" } }] },
          }),
          tool,
        ],
        { id: "L" },
      ),
    ]),
  ];
  const view = new OverviewScreen(roots, "T", () => undefined);
  view.handleKey({ key: "tab" }, viewport);
  view.handleKey({ key: "end", ctrl: true }, viewport);
  const cut = frame(view);
  expect(cut).toMatch(/… ~\d+ more tokens · x to show/);
  expect(cut).toContain("x full results");
  expect(cut).not.toContain("line 120");
  view.handleKey({ key: "x" }, viewport);
  view.handleKey({ key: "end", ctrl: true }, viewport);
  const full = frame(view);
  expect(full).toContain("line 120");
  expect(full).not.toContain("more tokens");
  view.handleKey({ key: "x" }, viewport);
  view.handleKey({ key: "end", ctrl: true }, viewport);
  expect(frame(view)).toMatch(/more tokens · x to show/);
});
