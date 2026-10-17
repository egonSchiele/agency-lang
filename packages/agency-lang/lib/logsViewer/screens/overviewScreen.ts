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
import {
  hasCutResult,
  roundResponsePayload,
  roundTokenLine,
  type PayloadLine,
  type ResultOptions,
} from "../payload.js";
import { decisionInputPayload, decisionOutputPayload, decisionSummary } from "../decision.js";
import { roundDeltas, type RoundDelta } from "../messageDelta.js";
import {
  hasHistory,
  hasSystemMessages,
  roundInputPayload,
  type InputOptions,
  type InputPayload,
} from "../roundInputPayload.js";
import { fmtDuration } from "../spanText.js";
import { THEME } from "../theme.js";
import type { RunStatus } from "../problems.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";
import { keyFooter, paneHeader } from "./chrome.js";
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
type Pane = "charts" | "preview";
type Preview = { header: Painted[]; body: Painted[]; room: number };

export class OverviewScreen implements Screen {
  readonly screenName = "overview" as const;
  private data: OverviewData | undefined;
  private deltas: Record<string, RoundDelta> = Object.create(null);
  private selectedId: string | undefined;
  // Keep a tool selected when visiting overview without choosing another call.
  private returnFocusId: string | undefined;
  private previewMode: PreviewMode = "input";
  /** Which side the paging and end keys act on. */
  private pane: Pane = "charts";
  private scrollOffsets = { input: 0, output: 0 };
  private systemsExpanded = false;
  private historyExpanded = false;
  private fullResults = false;
  /** The input preview opens on the call's new messages until scrolled. */
  private inputAtNew = true;
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
        /** First painted line of the input's new messages. */
        inputNewAt: number;
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
        help: "focus the other pane: the charts or the preview",
        hint: "tab pane",
        run: () => {
          this.pane = this.pane === "charts" ? "preview" : "charts";
        },
      },
      {
        keys: ["i"],
        help: "preview the input of the selected call",
        hint: "i/o input/output",
        run: () => {
          this.previewMode = "input";
        },
      },
      {
        keys: ["o"],
        help: "preview the output of the selected call",
        run: () => {
          this.previewMode = "output";
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
        help: "a page forward in the focused pane: calls in the charts, lines in the preview",
        hint: "^f/^b page",
        run: () => this.page(1),
      },
      {
        keys: ["Ctrl+B"],
        help: "a page back in the focused pane",
        run: () => this.page(-1),
      },
      {
        keys: ["Ctrl+D"],
        help: "half a page forward in the focused pane",
        run: () => this.page(0.5),
      },
      {
        keys: ["Ctrl+U"],
        help: "half a page back in the focused pane",
        run: () => this.page(-0.5),
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
        keys: ["e"],
        help: "show or hide the earlier messages of the input in full",
        hint: "e earlier",
        when: () =>
          this.previewMode === "input" && hasHistory(this.selected()?.round, this.selectedDelta()),
        run: () => this.toggleHistory(),
      },
      {
        keys: ["x"],
        help: "show or cut long tool results in the output",
        hint: "x full results",
        when: () => this.previewMode === "output" && hasCutResult(this.selected()?.tools ?? []),
        run: () => this.toggleResults(),
      },
      {
        keys: ["g", "Home"],
        help: "the first LLM call, or the top of the preview when it is focused",
        hint: "g/G ends",
        run: () => this.toEnd(-1),
      },
      {
        keys: ["G", "End"],
        help: "the last LLM call, or the end of the preview when it is focused",
        run: () => this.toEnd(1),
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
    const left = [
      paneHeader("CHARTS", this.pane === "charts", "", widths.left, "← → call"),
      ...overviewCharts(
        data.calls,
        this.selectedId,
        widths.left,
        Math.max(0, bodyHeight - 1),
        data.models.length === 1 ? this.contextWindowOf(data.models[0]) : undefined,
      ),
    ];
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
    this.deltas = Object.create(null);
    for (const delta of roundDeltas(this.data?.rounds ?? [])) {
      this.deltas[delta.roundId] = delta;
    }
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
    this.inputAtNew = true;
    this.systemsExpanded = false;
    this.historyExpanded = false;
    this.fullResults = false;
    this.previewCache = undefined;
  }
  private selectedDelta(): RoundDelta | undefined {
    const round = this.selected()?.round;
    return round === undefined ? undefined : this.deltas[round.id];
  }
  private toggleResults(): void {
    this.fullResults = !this.fullResults;
    this.scrollOffsets.output = 0;
    if (this.previewCache !== undefined) this.previewCache.bodies.output = undefined;
  }
  private toggleHistory(): void {
    this.historyExpanded = !this.historyExpanded;
    this.inputAtNew = true;
    if (this.previewCache !== undefined) this.previewCache.bodies.input = undefined;
  }
  /** The scroll stays put, so a prompt opened from the history is still in view. */
  private toggleSystems(): void {
    this.systemsExpanded = !this.systemsExpanded;
    if (this.previewCache !== undefined) this.previewCache.bodies.input = undefined;
  }
  /** Ctrl+F/B/D/U: whole or half pages of calls or of preview lines. */
  private page(pages: number): void {
    if (this.pane === "charts") {
      const calls = Math.max(1, Math.floor(this.callPageSize * Math.abs(pages)));
      this.moveCall(Math.sign(pages) * calls);
      return;
    }
    this.movePreview(
      Math.sign(pages) * Math.max(1, Math.floor(this.previewRoom * Math.abs(pages))),
    );
  }
  /** g/G, Home/End: the first or last call, or the preview's top or end. */
  private toEnd(direction: -1 | 1): void {
    if (this.pane === "charts") {
      this.selectCall(direction < 0 ? 0 : (this.data?.calls.length ?? 1) - 1);
      return;
    }
    this.scrollPreview(direction < 0 ? 0 : this.previewLength);
  }
  private movePreview(delta: number): void {
    this.scrollPreview(this.scrollTop + delta);
  }
  /** In the input, the NEW divider may be the top row even when the new
   *  messages beneath it do not fill the pane. */
  private scrollPreview(position: number): void {
    const anchor = this.previewMode === "input" ? (this.previewCache?.inputNewAt ?? 0) : 0;
    const last = Math.max(this.previewLength - this.previewRoom, anchor);
    this.scrollTop = Math.max(0, Math.min(position, last));
  }
  private preview(width: number, height: number): Preview {
    const selected = this.selected();
    const heading = paneHeader(
      `${callTitle(selected)} · ${this.previewMode === "input" ? "[INPUT] OUTPUT" : "INPUT [OUTPUT]"}`,
      this.pane === "preview",
      "",
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
        inputNewAt: 0,
      };
    }
    if (selected !== undefined && this.previewCache!.bodies[this.previewMode] === undefined) {
      const { lines, newAt } = previewBody(
        selected,
        this.previewMode,
        {
          systemsExpanded: this.systemsExpanded,
          historyExpanded: this.historyExpanded,
          fullResults: this.fullResults,
        },
        this.selectedDelta(),
      );
      const history = paintPayload(lines.slice(0, newAt), width);
      this.previewCache!.bodies[this.previewMode] = [
        ...history,
        ...paintPayload(lines.slice(newAt), width),
      ];
      if (this.previewMode === "input") {
        this.previewCache!.inputNewAt = history.length;
      }
    }
    if (selected !== undefined && this.previewMode === "input" && this.inputAtNew) {
      this.scrollOffsets.input = this.previewCache!.inputNewAt;
      this.inputAtNew = false;
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
  options: InputOptions & ResultOptions,
  delta: RoundDelta | undefined,
): InputPayload {
  if (call.round === undefined) {
    const lines: PayloadLine[] =
      mode === "output"
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
    return { lines, newAt: 0 };
  }
  if (call.round.decision !== undefined) {
    const lines =
      mode === "output"
        ? decisionOutputPayload(call.round.decision)
        : decisionInputPayload(call.round.decision);
    return { lines, newAt: 0 };
  }
  if (mode === "output") {
    return { lines: roundResponsePayload(call.round, call.tools, options), newAt: 0 };
  }
  return roundInputPayload(call.round, options, delta);
}
/** Where the call sits among the others: the call on its thread it
 *  continues, and the tool it ran inside with the call that asked for it. */
function placeLine(call: OverviewCall): string[] {
  const parts: string[] = [];
  if (call.continues !== undefined) {
    parts.push(`continues LLM call ${call.continues + 1}`);
  }
  if (call.inside !== undefined) {
    const asked =
      call.inside.requestedBy === undefined
        ? ""
        : ` (requested by LLM call ${call.inside.requestedBy + 1})`;
    parts.push(`inside ${call.inside.toolName}${asked}`);
  }
  return parts.length === 0 ? [] : [parts.join(" · ")];
}
function previewMetadata(call: OverviewCall): PayloadLine[] {
  if (call.round === undefined) {
    return [`failed at ${new Date(call.at).toISOString()}`, ...placeLine(call)].map((text) => ({
      kind: "meta",
      text,
    }));
  }
  const round = call.round;
  const event = round.node.event!;
  const time =
    typeof event.data.timeTaken === "number"
      ? fmtDuration(round.durationMs, { minutes: true })
      : "time not recorded";
  const cost =
    typeof event.data.cost?.totalCost === "number" ? fmtCost(round.costUsd) : "cost not recorded";
  const tokens = hasTokenUsage(event)
    ? roundTokenLine(round, { exact: true })
    : "token usage not recorded";
  return [
    round.model || "unknown model",
    `${time} · ${cost}`,
    tokens,
    `thread ${call.threadName}`,
    ...placeLine(call),
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
