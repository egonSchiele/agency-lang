// Full information for one call, as a scrollable page: metrics plus the
// complete prompt transcript (llm) or the complete call payload (tools).
// A viewer-level screen — reachable from the tree as well as the timeline
// views — and the one place the one-line-per-row invariant is deliberately
// broken: lines wrap, and scrolling clamps against the POST-wrap count.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { formatKey } from "../../tui/input/format.js";
import { formatConversation } from "../conversation.js";
import { fmtDuration, stripQuotes } from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { spanExtent, timelineSpans } from "../timeline/spans.js";
import { fmtOffset } from "./shared.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

export class DetailScreen implements View {
  readonly viewName = "detail" as const;
  private node: TreeNode | undefined;
  private scroll = 0;
  private message = "";

  constructor(
    roots: TreeNode[],
    private readonly spanId: string,
    private readonly thresholds: ViewerThresholds,
  ) {
    this.node = findNode(roots, spanId);
  }

  handleKey(ev: KeyEvent, viewport: Viewport): ViewAction {
    if (this.node === undefined) {
      return { kind: "back" };
    }
    const total = this.allLines(viewport.cols).length;
    const page = Math.max(1, viewport.rows - 3);
    const clamp = (v: number) => Math.max(0, Math.min(v, Math.max(0, total - page)));
    const fmt = formatKey(ev);
    if (fmt === "Escape" || fmt === "Left" || fmt === "h") return { kind: "back" };
    if (fmt === "t") return { kind: "open", view: "tree" };
    if (fmt === "y") return { kind: "copy", text: this.allLines(10_000).join("\n") };
    if (fmt === "Up" || fmt === "k") this.scroll = clamp(this.scroll - 1);
    if (fmt === "Down" || fmt === "j") this.scroll = clamp(this.scroll + 1);
    if (fmt === "g") this.scroll = 0;
    if (fmt === "G") this.scroll = clamp(total);
    if (fmt === "Ctrl+F" || fmt === "Ctrl+D") this.scroll = clamp(this.scroll + page);
    if (fmt === "Ctrl+B" || fmt === "Ctrl+U") this.scroll = clamp(this.scroll - page);
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const all = this.allLines(viewport.cols);
    const page = Math.max(1, viewport.rows - 3);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, all.length - page)));
    const visible = all.slice(this.scroll, this.scroll + page);
    const shownTo = Math.min(all.length, this.scroll + page);
    return column({ justifyContent: "flex-start" },
      line(`DETAIL  ${this.node?.summary ?? "(span no longer in the log)"}`, { fg: "bright-white" }),
      ...visible.map((text) => line(text)),
      line(
        `↑↓ scroll (${Math.min(this.scroll + 1, all.length)}–${shownTo} of ${all.length})  y copy  ←/Esc back` +
        (this.message ? `  ${this.message}` : ""),
        { fg: "gray" },
      ),
    );
  }

  setData(roots: TreeNode[]): void {
    this.node = findNode(roots, this.spanId);
  }

  helpLines(): string[] {
    return [
      "↑↓ / j k — scroll",
      "g / G — top / bottom",
      "Ctrl+F/B/D/U — page",
      "y — copy the whole page",
      "← / Esc — back",
    ];
  }

  notify(message: string): void {
    this.message = message;
  }

  /** The page content, wrapped to `cols`. Exposed for tests. */
  allLines(cols: number): string[] {
    if (this.node === undefined) return [];
    return this.computeLines().flatMap((text) => wrap(text, Math.max(cols - 2, 8)));
  }

  private computeLines(): string[] {
    const node = this.node!;
    const out: string[] = [];
    const extent = spanExtent(node);
    const spans = timelineSpans(node, { hideKinds: [] });
    if (extent !== undefined) {
      const self = spans.length > 0 ? spans[0].selfMs : 0;
      out.push(
        `start +${fmtOffset(0)}   duration ${fmtDuration(extent.end - extent.start, { minutes: true })}` +
        `   self ${fmtDuration(self, { minutes: true })}`,
      );
    }
    out.push("");
    const prompt = firstDescendantEvent(node, "promptCompletion");
    if (prompt !== undefined) {
      const d = prompt.event!.data;
      out.push(`model: ${stripQuotes(typeof d.model === "string" ? d.model : undefined)}`);
      const usage = d.usage ?? {};
      out.push(
        `tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out` +
        `   cost: $${(d.cost?.totalCost ?? 0).toFixed(4)}`,
      );
      out.push("", "── transcript ──");
      const messages = Array.isArray(d.messages) ? d.messages : [];
      const completion = d.completion?.output || d.completion?.toolCalls?.length
        ? [{ role: "assistant", content: d.completion.output, toolCalls: d.completion.toolCalls }]
        : [];
      out.push(...formatConversation([...messages, ...completion]));
      return out;
    }
    const tool = firstDescendantEvent(node, "toolCallStart") ?? firstDescendantEvent(node, "toolCall");
    const payload = tool?.event ?? node.event;
    if (payload !== undefined) {
      out.push("── call ──");
      out.push(...JSON.stringify(payload.data, null, 2).split("\n"));
    }
    return out;
  }
}

function findNode(roots: TreeNode[], id: string): TreeNode | undefined {
  for (const root of roots) {
    const stack: TreeNode[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      stack.push(...n.children);
    }
  }
  return undefined;
}

function firstDescendantEvent(node: TreeNode, type: string): TreeNode | undefined {
  const stack: TreeNode[] = [node];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.event?.data.type === type) return n;
    stack.push(...n.children);
  }
  return undefined;
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    out.push(text.slice(i, i + width));
  }
  return out;
}
