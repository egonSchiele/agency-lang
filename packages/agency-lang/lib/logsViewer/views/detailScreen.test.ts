import { describe, expect, it } from "vitest";
import { parseStyledText } from "../../tui/styleParser.js";
import { DEFAULT_THRESHOLDS } from "../thresholds.js";
import { buildForest } from "../tree.js";
import { agentLoopTrace, event } from "../storyFixture.js";
import { DetailScreen } from "./detailScreen.js";
const viewport = { rows: 10, cols: 40 };
const roots = [agentLoopTrace()];
function plain(screen: DetailScreen, width = 140) {
  return screen
    .allLines(width)
    .map((line) =>
      parseStyledText(line)
        .map((part) => part.text)
        .join(""),
    )
    .join("\n");
}
describe("DetailScreen", () => {
  it("resolves a round and an interrupt story id", () => {
    expect(plain(new DetailScreen(roots, "round:L:0", DEFAULT_THRESHOLDS))).toContain(
      "ASSISTANT · round 1",
    );
    const interrupt = new DetailScreen(roots, "leaf:grep:interruptResolved:0", DEFAULT_THRESHOLDS);
    expect(plain(interrupt)).toContain("INTERRUPT · std::grep");
    expect(plain(interrupt)).toContain("rejected");
  });
  it("resolves an llmCall through the raw forest and preserves all direct completions", () => {
    const screen = new DetailScreen(roots, "L", DEFAULT_THRESHOLDS);
    expect(plain(screen)).toContain('"promptCompletion"');
    expect(plain(screen)).toContain('"output": "done"');
  });
  it("shows raw JSON, copies the whole page and returns on left", () => {
    const screen = new DetailScreen(roots, "guide", DEFAULT_THRESHOLDS);
    expect(plain(screen)).toContain("TOOL · agencyGuide");
    screen.handleKey({ key: "r" }, viewport);
    expect(plain(screen)).toContain('"toolCallStart"');
    const action = screen.handleKey({ key: "y" }, viewport);
    expect(action.kind).toBe("copy");
    if (action.kind === "copy") {
      expect(action.text).toContain("handlers.md");
    }
    expect(screen.handleKey({ key: "left" }, viewport)).toEqual({ kind: "back" });
  });
  it("wraps JSON and scrolls half or full pages using the wrapped count", () => {
    const longRoots = buildForest([
      event("toolCallStart", 0, "tool", null, {
        toolName: "read",
        args: { path: "x".repeat(300) },
      }),
    ]);
    const screen = new DetailScreen(longRoots, "tool", DEFAULT_THRESHOLDS);
    screen.handleKey({ key: "r" }, viewport);
    expect(screen.allLines(40).length).toBeGreaterThan(screen.allLines(10000).length);
    const text = () => JSON.stringify(screen.render(viewport));
    const before = text();
    screen.handleKey({ key: "d", ctrl: true }, viewport);
    const half = text();
    screen.handleKey({ key: "g" }, viewport);
    screen.handleKey({ key: "f", ctrl: true }, viewport);
    expect(half).not.toBe(before);
    expect(text()).not.toBe(half);
    for (let count = 0; count < 100; count++) {
      screen.handleKey({ key: "down" }, viewport);
    }
    expect(text()).toContain(`of ${screen.allLines(40).length}`);
  });
  it("clears a vanished payload and re-resolves the original interrupt id on follow", () => {
    const screen = new DetailScreen(roots, "leaf:grep:interruptResolved:0", DEFAULT_THRESHOLDS);
    screen.setData([]);
    expect(screen.allLines(100)).toEqual([]);
    expect(screen.handleKey({ key: "j" }, viewport)).toEqual({ kind: "back" });
    screen.setData([agentLoopTrace()]);
    expect(plain(screen)).toContain("Search?");
  });
});
