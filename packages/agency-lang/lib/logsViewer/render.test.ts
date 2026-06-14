import { describe, it, expect } from "vitest";
import { renderViewerLines, flattenVisibleRows, colorFor, wrapLine } from "./render.js";
import { TreeNode } from "./treeNode.js";
import type { ViewerState } from "./types.js";
import { color } from "@/utils/termcolors.js";

function span(id: string, label: string, children: TreeNode[] = []): TreeNode {
  return new TreeNode({
    id,
    traceId: "t",
    parentId: null,
    children,
    nodeKind: "span",
    label,
    summary: `${label} (?)`,
  });
}

function trace(children: TreeNode[]): TreeNode {
  return new TreeNode({
    id: "trace-t",
    traceId: "t",
    parentId: null,
    children,
    nodeKind: "trace",
    label: "t",
    summary: "trace t",
  });
}

const baseState = (
  roots: TreeNode[],
  expanded: string[] = [],
  cursorId = roots[0].id,
): ViewerState => ({
  roots,
  expanded: new Set(expanded),
  cursorId,
  scrollTop: 0,
  quit: false,
});

// A promptCompletion leaf, built through the real model so node.event()
// resolves its payload lazily (no payload is stored on the node).
function pcForest(messages: unknown[]): TreeNode[] {
  return TreeNode.forestFromString(
    JSON.stringify({
      format_version: 1,
      trace_id: "t",
      project_id: "p",
      span_id: null,
      parent_span_id: null,
      data: { type: "promptCompletion", timestamp: "2026-01-01T00:00:00Z", messages },
    }),
  );
}

describe("flattenVisibleRows", () => {
  it("returns only roots when nothing is expanded", () => {
    const t = trace([span("a", "agentRun")]);
    const rows = flattenVisibleRows(baseState([t]));
    expect(rows).toHaveLength(1);
    expect(rows[0].node.id).toBe("trace-t");
  });

  it("includes children of expanded nodes", () => {
    const a = span("a", "agentRun", [span("b", "nodeExecution")]);
    const t = trace([a]);
    const rows = flattenVisibleRows(baseState([t], ["trace-t", "a"]));
    expect(rows.map((r) => r.node.id)).toEqual(["trace-t", "a", "b"]);
  });
});

describe("renderViewerLines", () => {
  it("uses ▶ for collapsed parents and ▼ for expanded", () => {
    const a = span("a", "agentRun", [span("b", "nodeExecution")]);
    const t = trace([a]);
    const lines = renderViewerLines(baseState([t], ["trace-t"]), {
      rows: 10,
      cols: 80,
    });
    expect(lines[0]).toMatch(/▼/);
    expect(lines[1]).toMatch(/▶/);
  });

  it("uses ▶ for expandable leaf events", () => {
    const roots = TreeNode.forestFromString(
      JSON.stringify({
        format_version: 1, trace_id: "t", project_id: "p", span_id: null,
        parent_span_id: null,
        data: { type: "debug", timestamp: "2026-01-01T00:00:00Z" },
      }),
    );
    const lines = renderViewerLines(baseState(roots, [roots[0].id]), {
      rows: 10,
      cols: 80,
    });
    expect(lines[1]).toMatch(/▶/);
  });

  it("indents children by depth", () => {
    const a = span("a", "agentRun", [span("b", "nodeExecution")]);
    const t = trace([a]);
    const lines = renderViewerLines(baseState([t], ["trace-t", "a"]), {
      rows: 10,
      cols: 80,
    });
    expect(lines[1].search(/▶|▼|●/)).toBeGreaterThan(
      lines[0].search(/▶|▼|●/),
    );
    expect(lines[2].search(/▶|▼|●/)).toBeGreaterThan(
      lines[1].search(/▶|▼|●/),
    );
  });

  it("marks the cursor row distinctly", () => {
    const t = trace([span("a", "agentRun")]);
    const state = baseState([t], ["trace-t"], "a");
    const lines = renderViewerLines(state, { rows: 10, cols: 80 });
    // Cursor row begins with "> ", non-cursor with "  ".
    expect(lines[1].startsWith(">")).toBe(true);
    expect(lines[0].startsWith(">")).toBe(false);
  });

  it("clips to viewport.rows starting at scrollTop", () => {
    const roots = Array.from({ length: 20 }, (_, i) =>
      trace([span(`s${i}`, "agentRun")]),
    );
    const state: ViewerState = {
      roots,
      expanded: new Set(),
      cursorId: "trace-t",
      scrollTop: 5,
      quit: false,
    };
    const lines = renderViewerLines(state, { rows: 3, cols: 80 });
    expect(lines).toHaveLength(3);
  });
});

describe("promptCompletion expansion", () => {
  // A promptCompletion leaf should expand into one row per message followed by
  // a single "raw data" toggle row. Expanding the toggle reveals the JSON dump.
  it("expands into conversation lines + raw data toggle", () => {
    const roots = pcForest([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const rows = flattenVisibleRows(baseState(roots, ["trace-t", "evt-1"]));
    // trace, leaf, [user], [assistant], raw-data toggle
    expect(rows).toHaveLength(5);
    expect(rows[2].node.nodeKind).toBe("convoLine");
    expect(rows[2].node.summary).toBe(`${color.green("[user]")} "hi"`);
    expect(rows[3].node.nodeKind).toBe("convoLine");
    expect(rows[4].node.nodeKind).toBe("rawDataToggle");
    expect(rows[4].node.id).toBe("evt-1:raw");
  });

  it("expands the raw-data toggle into JSON lines", () => {
    const roots = pcForest([{ role: "user", content: "hi" }]);
    const rows = flattenVisibleRows(
      baseState(roots, ["trace-t", "evt-1", "evt-1:raw"]),
    );
    const jsonRows = rows.filter((r) => r.node.nodeKind === "jsonLine");
    expect(jsonRows.length).toBeGreaterThan(0);
    expect(jsonRows[0].node.summary.trim()).toBe("{");
  });

  // Long messages used to be silently clipped with a `…`. With viewportCols
  // set, a long convoLine is split into multiple synthetic convoLine rows so
  // the full text is visible (wrapped) instead of truncated.
  it("wraps long convoLines into multiple rows when viewportCols is set", () => {
    const longText = "a".repeat(120);
    const roots = pcForest([{ role: "user", content: longText }]);
    const state: ViewerState = {
      ...baseState(roots, ["trace-t", "evt-1"]),
      viewportCols: 40,
    };
    const rows = flattenVisibleRows(state);
    const convoRows = rows.filter((r) => r.node.nodeKind === "convoLine");
    expect(convoRows.length).toBeGreaterThan(1);
    for (const r of convoRows) {
      expect(r.node.summary.length).toBeLessThanOrEqual(40 - r.depth * 2 - 2);
    }
    const joined = convoRows.map((r) => r.node.summary).join("");
    expect(joined).toContain(longText);
  });
});

describe("wrapLine", () => {
  it("returns the input unchanged when it fits", () => {
    expect(wrapLine("hello", 10)).toEqual(["hello"]);
  });

  it("breaks at the last space at or before width", () => {
    expect(wrapLine("one two three four", 10)).toEqual(["one two", "three four"]);
  });

  it("hard-breaks mid-word when no space is in range", () => {
    expect(wrapLine("supercalifragilistic", 6)).toEqual([
      "superc",
      "alifra",
      "gilist",
      "ic",
    ]);
  });

  it("returns a single-element list for width <= 0", () => {
    expect(wrapLine("abc", 0)).toEqual(["abc"]);
  });
});

describe("colorFor", () => {
  it("returns a span-type color for known span labels", () => {
    expect(colorFor(span("a", "agentRun"))).toBe("bright-cyan");
    expect(colorFor(span("b", "nodeExecution"))).toBe("bright-green");
    expect(colorFor(span("c", "llmCall"))).toBe("bright-magenta");
    expect(colorFor(span("d", "toolExecution"))).toBe("yellow");
  });

  it("returns undefined for trace headers (use terminal default)", () => {
    expect(colorFor(trace([]))).toBeUndefined();
  });

  it("highlights error leaves in bright-red", () => {
    const leaf = new TreeNode({
      id: "evt-0", traceId: "t", parentId: null,
      nodeKind: "event", label: "error", summary: "",
    });
    expect(colorFor(leaf)).toBe("bright-red");
  });

  it("returns undefined for unrecognized labels", () => {
    expect(colorFor(span("x", "weird"))).toBeUndefined();
  });
});
