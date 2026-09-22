import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { paint, paintAnsi, paintedLine } from "../../tui/paint.js";
// Full information for one call, as a scrollable page: metrics plus the
// complete prompt transcript (llm) or the complete call payload (tools).
// A viewer-level screen — reachable from the tree as well as the timeline
// views — and the one place the one-line-per-row invariant is deliberately
// broken: lines wrap, and scrolling clamps against the POST-wrap count.
import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { formatKey } from "../../tui/input/format.js";
import {
  contextTokens,
  hasTokenUsage,
  tokensCacheWrite,
  cost as costOf,
  tokensCached,
  tokensOut,
} from "../../statelog/wireAccessors.js";
import { formatConversation } from "../conversation.js";
import { walkNodes } from "../forest.js";
import { resolveDetailNode } from "../detailTarget.js";
import { fmtDuration, stripQuotes } from "../spanText.js";
import type { ViewerThresholds } from "../thresholds.js";
import { spanExtent, timelineSpans } from "../timeline/spans.js";
import { bottomHints, fmtOffset } from "./shared.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";

export class DetailScreen implements View {
  readonly viewName = "detail" as const;
  private node: TreeNode | undefined;
  private scroll = 0;
  private message = "";
  private pageRows = 1;
  private totalRows = 0;

  constructor(
    roots: TreeNode[],
    private readonly rowId: string,
    private readonly thresholds: ViewerThresholds,
  ) {
    this.node = resolveDetailNode(roots, rowId);
  }

  private bindings(): ViewerBinding[] {
    const move = (delta: number): void => {
      this.scroll = Math.max(
        0,
        Math.min(this.scroll + delta, Math.max(0, this.totalRows - this.pageRows)),
      );
    };
    return [
      ...cursorBindings<ViewAction>({
        by: move,
        toTop: () => {
          this.scroll = 0;
        },
        toBottom: () => move(Infinity),
        page: () => this.pageRows,
        halfPage: () => Math.max(1, Math.floor(this.pageRows / 2)),
      }),
      { keys: ["Left", "h"], help: "back", hint: "← back", run: () => ({ kind: "back" }) },
      {
        keys: ["y"],
        help: "copy the whole page",
        hint: "y copy",
        run: () => ({ kind: "copy", text: this.allLines(10000).join("\n") }),
      },
    ];
  }
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    if (this.node === undefined) {
      return { kind: "back" };
    }
    this.totalRows = this.allLines(viewport.cols).length;
    this.pageRows = Math.max(1, viewport.rows - 3);
    return runViewerKey(this.bindings(), formatKey(event));
  }
  render(viewport: Viewport): Element {
    const all = this.allLines(viewport.cols);
    const page = Math.max(1, viewport.rows - 3);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, all.length - page)));
    const visible = all.slice(this.scroll, this.scroll + page);
    const shownTo = Math.min(all.length, this.scroll + page);
    return column(
      { justifyContent: "flex-start" },
      paintedLine(
        paint(`DETAIL  ${this.node?.summary ?? "(span no longer in the log)"}`, { fg: "#cdd6f4" }),
      ),
      ...visible.map((text) => paintedLine(paintAnsi(text))),
      paintedLine(
        paint(
          bottomHints(
            `(${Math.min(this.scroll + 1, all.length)}–${shownTo} of ${all.length}) ${hintsFrom(this.bindings())}` +
              (this.message ? `  ${this.message}` : ""),
            "detail",
            viewport.cols,
          ),
          { fg: "#7f849c" },
        ),
      ),
    );
  }

  setData(roots: TreeNode[]): void {
    this.node = resolveDetailNode(roots, this.rowId);
  }

  helpLines(): string[] {
    return helpFrom(this.bindings());
  }

  notify(message: string): void {
    this.message = message;
  }

  setFollowIndicator(): void {
    // The detail screen shows a single finished call; nothing to indicate.
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
      // A leaf event yields no timeline span; its self-time IS its envelope.
      const self = spans.length > 0 ? spans[0].selfMs : extent.end - extent.start;
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
      const event = prompt.event!;
      const tokens = hasTokenUsage(event)
        ? `${contextTokens(event)} context (${tokensCached(event)} cached, ${tokensCacheWrite(event)} write) / ${tokensOut(event)} out`
        : "? context / ? out";
      out.push(`tokens: ${tokens}   cost: $${costOf(event).toFixed(4)}`);
      out.push("", "── transcript ──");
      const messages = Array.isArray(d.messages) ? d.messages : [];
      const completion =
        d.completion?.output || d.completion?.toolCalls?.length
          ? [{ role: "assistant", content: d.completion.output, toolCalls: d.completion.toolCalls }]
          : [];
      out.push(...formatConversation([...messages, ...completion]));
      return out;
    }
    const tool =
      firstDescendantEvent(node, "toolCallStart") ?? firstDescendantEvent(node, "toolCall");
    const payload = tool?.event ?? node.event;
    if (payload !== undefined) {
      out.push("── call ──");
      out.push(...JSON.stringify(payload.data, null, 2).split("\n"));
    }
    return out;
  }
}

function firstDescendantEvent(node: TreeNode, type: string): TreeNode | undefined {
  return walkNodes(node).find((entry) => entry.event?.data.type === type);
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    out.push(text.slice(i, i + width));
  }
  return out;
}
