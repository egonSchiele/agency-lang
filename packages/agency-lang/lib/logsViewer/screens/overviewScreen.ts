import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import {
  clipPainted,
  joinPainted,
  padPainted,
  paint,
  paintedLine,
  segment,
  type Painted,
  type Piece,
} from "../../tui/paint.js";
import { hasTokenUsage } from "../../statelog/wireAccessors.js";
import { findNode } from "../forest.js";
import { storyOutline } from "../story.js";
import { fmtUsd } from "../format.js";
import { helpFrom, hintsFrom, runViewerKey, type ViewerBinding } from "../keymap.js";
import { overviewData, type OverviewCall, type OverviewData } from "../overviewData.js";
import { roundResponsePayload, type PayloadLine } from "../payload.js";
import { decisionInputPayload, decisionOutputPayload, decisionSummary } from "../decision.js";
import { hasSystemMessages, roundInputPayload } from "../roundInputPayload.js";
import { fmtDuration } from "../spanText.js";
import { THEME } from "../theme.js";
import type { RunStatus } from "../problems.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";
import { keyFooter } from "./chrome.js";
import {
  fmtCost,
  overviewCallCapacity,
  overviewCharts,
  overviewSection,
} from "./overviewCharts.js";
import { paintPayload } from "./payloadPaint.js";
import type { Screen } from "./screen.js";

const LAYOUT = { leftShare: 0.45, dividerCells: 3, outerRows: 3 };
type PreviewMode = "input" | "output";
type Preview = { header: Painted[]; body: Painted[]; room: number };

export class OverviewScreen implements Screen {
  readonly screenName = "overview" as const;
  private data: OverviewData | undefined;
  private selectedId: string | undefined;
  // Keep a tool selected when visiting overview without choosing another call.
  private returnFocusId: string | undefined;
  private previewMode: PreviewMode = "output";
  private scrollOffsets = { input: 0, output: 0 };
  private systemsExpanded = false;
  private get scrollTop(): number {
    return this.scrollOffsets[this.previewMode];
  }
  private set scrollTop(value: number) {
    this.scrollOffsets[this.previewMode] = value;
  }
  private message = "";
  private following = false;
  private previewRoom = 1;
  private previewLength = 0;
  private previewCache:
    | {
        call: OverviewCall;
        width: number;
        metadata: Painted[];
        bodies: Partial<Record<PreviewMode, Painted[]>>;
      }
    | undefined;
  private callPageSize = 1;
  constructor(
    private roots: TreeNode[],
    private traceId: string,
    private readonly contextWindowOf: (model: string) => number | undefined,
  ) {
    this.derive();
  }
  private bindings(): ViewerBinding[] {
    return [
      {
        keys: ["Tab"],
        help: "switch the preview between input and output",
        hint: "tab input/output",
        run: () => {
          this.previewMode = this.previewMode === "output" ? "input" : "output";
        },
      },
      {
        keys: ["Left", "h"],
        help: "select the previous LLM call",
        hint: "← → call",
        run: () => this.moveCall(-1),
      },
      { keys: ["Right", "l"], help: "select the next LLM call", run: () => this.moveCall(1) },
      {
        keys: ["Ctrl+F"],
        help: "select the LLM call one chart page forward",
        hint: "^f/^b page",
        run: () => this.moveCall(this.callPageSize),
      },
      {
        keys: ["Ctrl+B"],
        help: "select the LLM call one chart page back",
        run: () => this.moveCall(-this.callPageSize),
      },
      {
        keys: ["Ctrl+D"],
        help: "select the LLM call half a chart page forward",
        run: () => this.moveCall(Math.max(1, Math.floor(this.callPageSize / 2))),
      },
      {
        keys: ["Ctrl+U"],
        help: "select the LLM call half a chart page back",
        run: () => this.moveCall(-Math.max(1, Math.floor(this.callPageSize / 2))),
      },
      {
        keys: ["Up", "k"],
        help: "scroll the preview up",
        hint: "↑ ↓ preview",
        run: () => this.movePreview(-1),
      },
      { keys: ["Down", "j"], help: "scroll the preview down", run: () => this.movePreview(1) },
      {
        keys: ["PageUp"],
        help: "scroll the preview up one page",
        run: () => this.movePreview(-Math.max(1, this.previewRoom)),
      },
      {
        keys: ["PageDown"],
        help: "scroll the preview down one page",
        run: () => this.movePreview(Math.max(1, this.previewRoom)),
      },
      {
        keys: ["Ctrl+Home"],
        help: "scroll to the start of the preview",
        run: () => this.scrollPreview(0),
      },
      {
        keys: ["Ctrl+End"],
        help: "scroll to the end of the preview",
        run: () => this.scrollPreview(this.previewLength),
      },
      {
        keys: ["s"],
        help: "show or hide system and developer prompts in the input",
        hint: "s system",
        when: () => this.previewMode === "input" && hasSystemMessages(this.selected()?.round),
        run: () => this.toggleSystems(),
      },
      {
        keys: ["g", "Home"],
        help: "select the first LLM call",
        hint: "g/G ends",
        run: () => this.selectCall(0),
      },
      {
        keys: ["G", "End"],
        help: "select the last LLM call",
        run: () => this.selectCall((this.data?.calls.length ?? 1) - 1),
      },
      {
        keys: ["Enter"],
        help: "open the selected LLM call in the trace",
        hint: "⏎ open",
        run: () =>
          this.selectedId === undefined
            ? { kind: "none" }
            : { kind: "openScreen", screen: "trace", focusId: this.selectedId },
      },
    ];
  }
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    this.message = "";
    const widths = panelWidths(viewport.cols);
    this.callPageSize = overviewCallCapacity(this.data?.calls.length ?? 0, widths.left);
    this.preview(widths.right, Math.max(0, viewport.rows - LAYOUT.outerRows));
    return runViewerKey(this.bindings(), formatKey(event));
  }
  helpLines(): string[] {
    return helpFrom(this.bindings());
  }
  render(viewport: Viewport, sharedHints = ""): Element {
    const data = this.data;
    const footer = keyFooter(hintsFrom(this.bindings()), viewport.cols, "OVERVIEW", sharedHints);
    if (data === undefined)
      return column(
        { height: viewport.rows, justifyContent: "flex-start" },
        column(
          { height: Math.max(0, viewport.rows - 1), justifyContent: "flex-start" },
          paintedLine(segment("No trace selected.", viewport.cols, { style: { fg: THEME.muted } })),
        ),
        footer,
      );
    const bodyHeight = Math.max(0, viewport.rows - LAYOUT.outerRows);
    const widths = panelWidths(viewport.cols);
    const left = overviewCharts(
      data.calls,
      this.selectedId,
      widths.left,
      bodyHeight,
      data.models.length === 1 ? this.contextWindowOf(data.models[0]) : undefined,
    );
    const preview = this.preview(widths.right, bodyHeight);
    const right = [
      ...preview.header,
      ...preview.body.slice(this.scrollTop, this.scrollTop + preview.room),
    ];
    const body = Array.from({ length: bodyHeight }, (_, index) =>
      paintedLine(
        joinPainted(
          fit(left[index] ?? paint(""), widths.left),
          segment(" │ ", LAYOUT.dividerCells, { style: { fg: THEME.rule } }),
          fit(right[index] ?? paint(""), widths.right),
        ),
      ),
    );
    return column(
      { height: viewport.rows, justifyContent: "flex-start" },
      paintedLine(segment(header(data, this.following), viewport.cols)),
      column({ height: bodyHeight, justifyContent: "flex-start" }, ...body),
      paintedLine(
        segment(this.message || this.scrollStatus(), viewport.cols, { style: { fg: THEME.muted } }),
      ),
      footer,
    );
  }
  setData(roots: TreeNode[]): void {
    this.roots = roots;
    this.derive();
  }
  focusId(): string | undefined {
    return this.returnFocusId ?? this.selectedId;
  }
  setFocus(id: string): void {
    const calls = this.data?.calls ?? [];
    const index = calls.findIndex((call) => call.id === id || call.round?.node.id === id);
    if (index !== -1) {
      this.selectCall(index);
      return;
    }
    const trace = this.roots.find((root) => root.traceId === this.traceId);
    if (trace === undefined) return;
    // A span id (a Thread group row) previews its first call but stays the focus.
    const ownerId = owningCall(trace, id);
    const owner = calls.findIndex((call) =>
      ownerId === undefined ? call.round?.spanId === id : call.id === ownerId,
    );
    if (owner !== -1) this.selectCall(owner);
    if (findNode([trace], id) !== undefined) this.returnFocusId = id;
  }
  setTrace(traceId: string): void {
    this.traceId = traceId;
    this.selectedId = undefined;
    this.returnFocusId = undefined;
    this.resetPreview();
    this.derive();
  }
  escape(): boolean {
    return false;
  }
  applySearch(_query: string): void {}
  notify(message: string): void {
    this.message = message;
  }
  setFollowIndicator(on: boolean): void {
    this.following = on;
  }
  private derive(): void {
    const trace = this.roots.find((root) => root.traceId === this.traceId) ?? this.roots[0];
    this.data = trace === undefined ? undefined : overviewData(trace);
    if (this.returnFocusId !== undefined && findNode(this.roots, this.returnFocusId) === undefined)
      this.returnFocusId = undefined;
    if (!this.data?.calls.some((call) => call.id === this.selectedId)) this.selectCall(0);
  }
  private selected(): OverviewCall | undefined {
    return this.data?.calls.find((call) => call.id === this.selectedId);
  }
  private moveCall(delta: number): void {
    const index = this.data?.calls.findIndex((call) => call.id === this.selectedId) ?? 0;
    this.selectCall(index + delta);
  }
  private selectCall(index: number): void {
    this.returnFocusId = undefined;
    const calls = this.data?.calls ?? [];
    const next = calls[Math.max(0, Math.min(calls.length - 1, index))]?.id;
    if (next !== this.selectedId) this.resetPreview();
    this.selectedId = next;
  }
  private resetPreview(): void {
    this.scrollOffsets = { input: 0, output: 0 };
    this.systemsExpanded = false;
    this.previewCache = undefined;
  }
  private toggleSystems(): void {
    this.systemsExpanded = !this.systemsExpanded;
    this.scrollOffsets.input = 0;
    if (this.previewCache !== undefined) this.previewCache.bodies.input = undefined;
  }
  private movePreview(delta: number): void {
    this.scrollPreview(this.scrollTop + delta);
  }
  private scrollPreview(position: number): void {
    this.scrollTop = Math.max(0, Math.min(position, this.previewLength - this.previewRoom));
  }
  private preview(width: number, height: number): Preview {
    const selected = this.selected();
    const heading = overviewSection(
      `${callTitle(selected)} · ${this.previewMode === "output" ? "[OUTPUT] INPUT" : "OUTPUT [INPUT]"}`,
      width,
    );
    if (
      selected !== undefined &&
      (this.previewCache?.call !== selected || this.previewCache.width !== width)
    ) {
      this.previewCache = {
        call: selected,
        width,
        metadata: paintPayload(previewMetadata(selected), width),
        bodies: {},
      };
    }
    if (selected !== undefined && this.previewCache!.bodies[this.previewMode] === undefined) {
      this.previewCache!.bodies[this.previewMode] = paintPayload(
        previewBody(selected, this.previewMode, this.systemsExpanded),
        width,
      );
    }
    const header =
      selected === undefined ? [heading] : [heading, ...this.previewCache!.metadata, paint("")];
    const body =
      selected === undefined
        ? [segment("No completed LLM calls.", width, { style: { fg: THEME.muted } })]
        : this.previewCache!.bodies[this.previewMode]!;
    const room = Math.max(0, height - header.length);
    this.previewRoom = room;
    this.previewLength = body.length;
    this.scrollPreview(this.scrollTop);
    return { header, body, room };
  }
  private scrollStatus(): string {
    return this.previewLength > this.previewRoom && this.previewRoom > 0
      ? `preview ${this.scrollTop + 1}–${Math.min(this.previewLength, this.scrollTop + this.previewRoom)}/${this.previewLength}`
      : "";
  }
}
function panelWidths(cols: number): { left: number; right: number } {
  const left = Math.max(0, Math.floor((cols - LAYOUT.dividerCells) * LAYOUT.leftShare));
  return { left, right: Math.max(0, cols - left - LAYOUT.dividerCells) };
}
function fit(content: Painted, width: number): Painted {
  return padPainted(clipPainted(content, width), width);
}
const STATUS_TEXT: Record<RunStatus, { text: string; fg: string }> = {
  done: { text: "done", fg: THEME.text },
  crashed: { text: "✖ crashed", fg: THEME.kind.error },
  paused: { text: "⏸ paused for a response", fg: THEME.kind.interrupt },
  running: { text: "● running", fg: THEME.ok },
};
/** The header: model, how the run ended, elapsed time, call count, cost,
 *  an error count in red, and the follow indicator. Pieces, so the status
 *  and the count keep their own colors. */
function header(data: OverviewData, following: boolean): Piece[] {
  const status = STATUS_TEXT[data.status];
  const count = data.errors.length;
  const calls = data.rounds.length;
  const failed = data.calls.length - calls;
  const plain = (text: string): Piece => ({ text, style: { fg: THEME.text, bold: true } });
  const separator = plain(" · ");
  const pieces: Piece[] = [
    plain(data.models.join(", ") || "unknown model"),
    separator,
    { text: status.text, style: { fg: status.fg, bold: true } },
    separator,
    plain(fmtDuration(data.elapsedMs, { minutes: true })),
    separator,
    plain(`${calls} LLM ${calls === 1 ? "call" : "calls"}`),
  ];
  if (failed > 0) {
    pieces.push(separator, {
      text: `${failed} failed ${failed === 1 ? "request" : "requests"}`,
      style: { fg: THEME.kind.error, bold: true },
    });
  }
  pieces.push(separator, plain(fmtUsd(data.costUsd)));
  if (count > 0) {
    pieces.push(separator, {
      text: `✖ ${count} ${count === 1 ? "error" : "errors"}`,
      style: { fg: THEME.kind.error, bold: true },
    });
  }
  if (following) {
    pieces.push(separator, plain("following"));
  }
  return pieces;
}
function callTitle(call: OverviewCall | undefined): string {
  if (call === undefined) {
    return "LLM CALL";
  }
  if (call.round === undefined) {
    return "FAILED REQUEST";
  }
  const decision = call.round.decision;
  const suffix = decision === undefined ? "" : ` · DECISION · ${decisionSummary(decision)}`;
  return `LLM CALL ${call.round.index + 1}${suffix}`;
}
function previewBody(
  call: OverviewCall,
  mode: PreviewMode,
  systemsExpanded: boolean,
): PayloadLine[] {
  if (call.round === undefined) {
    return mode === "output"
      ? [
          { kind: "heading", text: "✖ REQUEST FAILED", tone: "error" },
          { kind: "text", text: call.failure!.message, indent: 0, role: "error" },
        ]
      : [
          {
            kind: "meta",
            text: "input not recorded: the request failed before the provider answered",
          },
        ];
  }
  if (call.round.decision !== undefined) {
    return mode === "output"
      ? decisionOutputPayload(call.round.decision)
      : decisionInputPayload(call.round.decision);
  }
  return mode === "output"
    ? roundResponsePayload(call.round, call.tools)
    : roundInputPayload(call.round, systemsExpanded);
}
function previewMetadata(call: OverviewCall): PayloadLine[] {
  if (call.round === undefined) {
    return [{ kind: "meta", text: `failed at ${new Date(call.at).toISOString()}` }];
  }
  const round = call.round;
  const event = round.node.event!;
  const time =
    typeof event.data.timeTaken === "number"
      ? `${round.durationMs.toLocaleString("en-US")}ms`
      : "time not recorded";
  const cost =
    typeof event.data.cost?.totalCost === "number" ? fmtCost(round.costUsd) : "cost not recorded";
  const tokens = hasTokenUsage(event)
    ? [
        `context ${round.contextTokens.toLocaleString("en-US")} · cached ${round.cachedTokens.toLocaleString("en-US")}`,
        `fresh ${round.freshTokens.toLocaleString("en-US")} · output ${round.outputTokens.toLocaleString("en-US")}`,
      ]
    : ["token usage not recorded"];
  return [
    round.model || "unknown model",
    `${time} · ${cost}`,
    ...tokens,
    `thread ${call.threadName}`,
  ].map((text) => ({ kind: "meta", text }));
}

function owningCall(trace: TreeNode, id: string): string | undefined {
  const rows = storyOutline(trace, { admin: true });
  const at = rows.findIndex((row) => row.id === id);
  if (at === -1) return undefined;
  let depth = rows[at].depth;
  for (let index = at - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.depth >= depth) continue;
    if (row.kind === "round") return row.id;
    depth = row.depth;
  }
  return undefined;
}
