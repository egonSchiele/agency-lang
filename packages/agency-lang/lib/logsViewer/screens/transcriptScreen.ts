import { column, row } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { paint, paintedLine, segment, type Painted } from "../../tui/paint.js";
import { ancestorsOf, buildTreeIndex, walkNodes } from "../forest.js";
import { fmtTokens, fmtUsd } from "../format.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { fmtDuration } from "../spanText.js";
import { THEME } from "../theme.js";
import { TOOL_STATUS_MARK, type ToolStatus } from "../story.js";
import { parseRoundId } from "../timeline/rounds.js";
import {
  threadKey,
  transcriptBlocks,
  transcriptText,
  type TranscriptBlock,
} from "../transcript.js";
import { transcriptPayload, type TranscriptPayloadOptions } from "../transcriptPayload.js";
import { traceTimes } from "../timeline/turns.js";
import { fmtOffset } from "../views/shared.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";
import { paintPayload } from "./payloadPaint.js";
import { boxInnerWidth, boxLines, SIDES_MIN_WIDTH } from "./blockBox.js";
import { lineNumberWidth, numberedBlocks } from "./lineNumbers.js";
import { keyFooter } from "./chrome.js";
import type { Screen } from "./screen.js";
/** `indent` is per level of tool depth: a sub-agent's rows sit two cells
 *  further in than the tool rows of the call that started it. */
const LAYOUT = {
  spineWidth: 28,
  dividerWidth: 2,
  fixedRows: 2,
  gap: 1,
  half: 2,
  indent: 4,
  /** A nested box is indented no further than leaves it this wide. */
  minBoxWidth: 24,
};
type BlockLines = { id: string; start: number; lines: Painted[] };
/** Blocks Enter opens: the ones that hold something back until asked. */
const EXPANDABLE = ["system", "tool"];
/** Blocks drawn as a box. A turn or thread divider, a pause and a rewrite
 *  are rules across the pane, not messages. */
const BOXED = ["system", "user", "handback", "assistant", "tool", "history", "error"];

export class TranscriptScreen implements Screen {
  readonly screenName = "transcript" as const;
  private blocks: TranscriptBlock[] = [];
  private cursor = "";
  private expanded: string[] = [];
  private scrollTop = 0;
  private query = "";
  private matches: string[] = [];
  private message = "";
  private following = false;
  private lineNumbers = false;
  private page = 1;
  private width = 1;
  private painted: BlockLines[] = [];
  private needsReveal = true;
  private revealMatch = false;
  private showApprovals = false;
  /** The run's wall time split into work and waits for the person. */
  private times = { elapsedMs: 0, workingMs: 0, waitingMs: 0 };
  /** Painted blocks by id, expansion, approvals and width; cleared when
   *  the blocks are rebuilt. */
  private paintCache: Record<string, Painted[]> = Object.create(null);
  constructor(
    private roots: TreeNode[],
    private traceId: string,
  ) {
    this.derive();
  }
  private bindings(): ViewerBinding[] {
    const moves = cursorBindings<ViewAction>({
      by: (delta) => this.move(delta),
      toTop: () => this.move(-Infinity),
      toBottom: () => this.move(Infinity),
      page: () => this.page,
      halfPage: () => Math.max(1, Math.floor(this.page / LAYOUT.half)),
    });
    const paging: Record<string, number> = {
      "Ctrl+F": this.page,
      "Ctrl+B": -this.page,
      "Ctrl+D": Math.max(1, Math.floor(this.page / LAYOUT.half)),
      "Ctrl+U": -Math.max(1, Math.floor(this.page / LAYOUT.half)),
    };
    return [
      {
        keys: ["#"],
        help: "toggle line numbers",
        hint: "# numbers",
        run: () => {
          this.lineNumbers = !this.lineNumbers;
        },
      },
      ...moves.map((binding) =>
        Object.hasOwn(paging, binding.keys[0])
          ? { ...binding, run: () => this.pageBy(paging[binding.keys[0]]) }
          : binding,
      ),
      {
        keys: ["Enter"],
        help: "expand or collapse the block",
        hint: "⏎ expand",
        run: () => this.toggle(this.cursor),
      },
      {
        keys: ["s"],
        help: "reveal or hide this thread's system prompt",
        hint: "s system",
        run: () => this.toggleSystem(),
      },
      {
        keys: ["p"],
        help: "show or hide approved interrupts",
        hint: "p approvals",
        run: () => {
          this.showApprovals = !this.showApprovals;
        },
      },
      {
        keys: ["/"],
        help: "search full block text",
        hint: "/ find",
        run: () => ({
          kind: "promptLine",
          label: "/ ",
          onResult: (query) => this.applySearch(query),
        }),
      },
      { keys: ["n"], help: "next match", run: () => this.nextMatch(1) },
      { keys: ["N"], help: "previous match", run: () => this.nextMatch(-1) },
      {
        keys: ["d"],
        help: "open LLM call or tool detail",
        hint: "d detail",
        when: () => this.focusId() !== undefined,
        run: () => ({ kind: "openDetail", rowId: this.focusId()! }),
      },
      {
        keys: ["y"],
        help: "copy full block text",
        hint: "y copy",
        run: () => ({
          kind: "copy",
          text: this.selected() ? transcriptText(this.selected()!) : "",
        }),
      },
    ];
  }
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    this.prepare(viewport);
    this.message = "";
    return runViewerKey(this.bindings(), formatKey(event));
  }
  helpLines(): string[] {
    return helpFrom(this.bindings());
  }
  notify(message: string): void {
    this.message = message;
  }
  setFollowIndicator(on: boolean): void {
    this.following = on;
  }
  private trace(): TreeNode | undefined {
    return this.roots.find((root) => root.traceId === this.traceId);
  }
  private selected(): TranscriptBlock | undefined {
    return this.blocks.find((block) => block.id === this.cursor);
  }
  private derive(): void {
    const old = this.selected();
    const trace = this.trace();
    this.blocks = trace ? transcriptBlocks(trace) : [];
    this.times = trace ? traceTimes(trace) : { elapsedMs: 0, workingMs: 0, waitingMs: 0 };
    this.paintCache = Object.create(null);
    this.expanded = this.expanded.filter((id) => this.blocks.some((block) => block.id === id));
    if (!this.blocks.some((block) => block.id === this.cursor)) {
      this.cursor =
        this.blocks.find((block) => block.kind === "assistant" && block.id === old?.roundId)?.id ??
        this.blocks[0]?.id ??
        "";
      this.needsReveal = true;
    }
    this.updateMatches();
  }
  setData(roots: TreeNode[]): void {
    this.roots = roots;
    this.derive();
  }
  setTrace(traceId: string): void {
    this.traceId = traceId;
    this.cursor = "";
    this.expanded = [];
    this.query = "";
    this.scrollTop = 0;
    this.derive();
  }
  focusId(): string | undefined {
    const block = this.selected();
    return block?.kind === "tool" ? block.id : block?.roundId;
  }
  setFocus(id: string): void {
    const exact = this.blocks.find((block) => block.id === id);
    if (exact) {
      this.select(exact.id);
      return;
    }
    const trace = this.trace();
    if (!trace) {
      return;
    }
    const index = buildTreeIndex(trace);
    const node = index.byId[parseRoundId(id)?.spanId ?? id];
    if (!node) {
      return;
    }
    const descendants = walkNodes(node).map((child) => child.id);
    const assistant = this.blocks.find(
      (block) => block.kind === "assistant" && descendants.includes(block.round.node.id),
    );
    if (assistant) {
      this.select(assistant.id);
      return;
    }
    const ancestorIds = ancestorsOf(node, index).map((ancestor) => ancestor.id);
    const ancestor = this.blocks.find(
      (block) => block.kind === "tool" && ancestorIds.includes(block.id),
    );
    if (ancestor) {
      this.select(ancestor.id);
    }
  }
  private select(id: string): void {
    this.cursor = id;
    this.needsReveal = true;
    this.revealMatch = false;
  }
  private move(delta: number): void {
    const position = this.blocks.findIndex((block) => block.id === this.cursor);
    this.select(
      this.blocks[Math.max(0, Math.min(this.blocks.length - 1, position + delta))]?.id ?? "",
    );
  }
  /** Scroll by lines and move the cursor to the block at the top of the
   *  pane. A page that cannot scroll, at the end or when everything fits,
   *  leaves the cursor where it is. */
  private pageBy(delta: number): void {
    const total = this.painted.flatMap((block) => block.lines).length;
    const scrollTop = Math.max(
      0,
      Math.min(this.scrollTop + delta, Math.max(this.scrollTop, total - this.page)),
    );
    this.needsReveal = false;
    if (scrollTop === this.scrollTop) {
      return;
    }
    this.scrollTop = scrollTop;
    const atTop = this.painted.filter((block) => block.start <= this.scrollTop).at(-1);
    if (atTop) {
      this.cursor = atTop.id;
    }
  }
  private toggle(id: string): void {
    this.needsReveal = true;
    this.expanded = this.expanded.includes(id)
      ? this.expanded.filter((value) => value !== id)
      : [...this.expanded, id];
  }
  private toggleSystem(): void {
    const selected = this.selected();
    if (!selected) {
      return;
    }
    const systems = this.blocks.filter(
      (block) => block.kind === "system" && threadKey(block.thread) === threadKey(selected.thread),
    );
    const preceding = systems.filter(
      (block) => this.blocks.indexOf(block) <= this.blocks.indexOf(selected),
    );
    const target = preceding.at(-1) ?? systems[0];
    if (target) {
      this.toggle(target.id);
      this.select(target.id);
    }
  }
  private updateMatches(): void {
    this.matches = this.query
      ? this.blocks
          .filter((block) => transcriptText(block).toLowerCase().includes(this.query.toLowerCase()))
          .map((block) => block.id)
      : [];
  }
  applySearch(query: string): void {
    this.query = query;
    this.updateMatches();
    if (this.matches.length > 0) {
      this.showMatch(this.matches[0]);
    }
  }
  private showMatch(id: string): void {
    if (!this.expanded.includes(id)) {
      this.expanded.push(id);
    }
    this.select(id);
    this.revealMatch = true;
  }
  private nextMatch(direction: number): void {
    if (this.matches.length === 0) {
      return;
    }
    const current = this.matches.indexOf(this.cursor);
    const position = current < 0 && direction < 0 ? 0 : current;
    this.showMatch(
      this.matches[(position + direction + this.matches.length) % this.matches.length],
    );
  }
  escape(): boolean {
    if (!this.query) {
      return false;
    }
    this.query = "";
    this.matches = [];
    return true;
  }
  private prepare(viewport: Viewport): void {
    const statusRows = this.query || this.following ? 1 : 0;
    this.page = Math.max(1, viewport.rows - LAYOUT.fixedRows - statusRows);
    this.width = Math.max(1, viewport.cols - LAYOUT.spineWidth - LAYOUT.dividerWidth);
    const renderBlocks = (width: number): BlockLines[] => {
      let start = 0;
      return this.blocks.map((block) => {
        const lines = this.paintBlockCached(block, width);
        const placed = {
          id: block.id,
          start,
          lines: [...lines, ...Array.from({ length: LAYOUT.gap }, () => paint(""))],
        };
        start += placed.lines.length;
        return placed;
      });
    };
    this.painted = this.lineNumbers
      ? numberedBlocks(this.width, renderBlocks)
      : renderBlocks(this.width);
    const total = this.painted.reduce((sum, block) => sum + block.lines.length, 0);
    if (this.needsReveal) {
      const focused = this.painted.find((block) => block.id === this.cursor);
      this.keepVisible(focused);
      if (this.revealMatch && focused) {
        const line = focused.lines.findIndex((line) =>
          parseStyledText(line)
            .map((span) => span.text)
            .join("")
            .slice(this.lineNumbers ? lineNumberWidth(total) : 0)
            .toLowerCase()
            .includes(this.query.toLowerCase()),
        );
        this.scrollTop += Math.max(0, line - this.page + 1);
      }
      this.needsReveal = false;
      this.revealMatch = false;
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, total - 1)));
  }
  /** Scroll only as far as it takes to bring the block into the pane, so
   *  the active box stays where the eye left it: up to its top when it is
   *  above, down to its bottom when it is below, and to its top when it is
   *  taller than the pane. */
  private keepVisible(focused: BlockLines | undefined): void {
    if (focused === undefined) {
      this.scrollTop = 0;
      return;
    }
    const end = focused.start + focused.lines.length - LAYOUT.gap;
    if (focused.start < this.scrollTop || end - focused.start > this.page) {
      this.scrollTop = focused.start;
    } else if (end > this.scrollTop + this.page) {
      this.scrollTop = end - this.page;
    }
  }
  /** `▸` or `▾` on a block Enter opens or closes; the same width of
   *  nothing on the rest, so labels line up. */
  private spineMarker(block: TranscriptBlock): string {
    if (!EXPANDABLE.includes(block.kind)) {
      return "  ";
    }
    return this.expanded.includes(block.id) ? "▾ " : "▸ ";
  }
  private paintBlockCached(block: TranscriptBlock, width: number): Painted[] {
    const expanded = this.expanded.includes(block.id);
    const active = block.id === this.cursor;
    const key = `${block.id}|${expanded}|${this.showApprovals}|${width}|${active}`;
    return (this.paintCache[key] ??= paintBlock(block, expanded, width, active, {
      showApprovals: this.showApprovals,
    }));
  }
  /** `Elapsed 26m37s · 7m25s working · 19m12s waiting for the user · block 12 of 87`;
   *  the split appears only when the trace has turns to split by. */
  private headerText(position: number): string {
    const split =
      this.times.waitingMs > 0
        ? ` · ${fmtOffset(this.times.workingMs)} working · ${fmtOffset(this.times.waitingMs)} waiting for the user`
        : "";
    const where =
      this.blocks.length === 0 ? "" : ` · block ${position + 1} of ${this.blocks.length}`;
    return `Elapsed ${fmtOffset(this.times.elapsedMs)}${split}${where}`;
  }
  render(viewport: Viewport, sharedHints = ""): Element {
    this.prepare(viewport);
    const position = this.blocks.findIndex((block) => block.id === this.cursor);
    const spineTop = Math.max(0, position - this.page + 1);
    const spine = this.blocks.slice(spineTop, spineTop + this.page).map((block) =>
      paintedLine(
        segment(
          `${block.id === this.cursor ? "▶" : " "} ${this.spineMarker(block)}${spineLabel(block)}`,
          LAYOUT.spineWidth,
          {
            style: {
              fg: spineColor(block),
              ...(block.kind === "thread" || block.kind === "turn" ? { bold: true } : {}),
              ...(block.id === this.cursor ? { bg: THEME.cursorBg } : {}),
            },
          },
        ),
      ),
    );
    const lines = this.painted
      .flatMap((block) => block.lines)
      .slice(this.scrollTop, this.scrollTop + this.page);
    const status = [
      this.query ? `/${this.query} · ${this.matches.length} matches` : "",
      this.following ? "following" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return column(
      { height: viewport.rows, justifyContent: "flex-start" },
      paintedLine(segment(this.headerText(position), viewport.cols, { style: { fg: THEME.text } })),
      ...(status
        ? [paintedLine(segment(status, viewport.cols, { style: { fg: THEME.muted } }))]
        : []),
      row(
        { height: this.page },
        column(
          { width: LAYOUT.spineWidth, height: this.page, justifyContent: "flex-start" },
          ...spine,
        ),
        column(
          { width: LAYOUT.dividerWidth, height: this.page },
          ...Array.from({ length: this.page }, () =>
            paintedLine(paint("│ ", { fg: THEME.chrome })),
          ),
        ),
        column(
          { width: this.width, height: this.page, justifyContent: "flex-start" },
          ...lines.map((line) => paintedLine(line)),
        ),
      ),
      keyFooter(
        this.message || hintsFrom(this.bindings()),
        viewport.cols,
        "TRANSCRIPT",
        sharedHints,
      ),
    );
  }
}
/** A message block as a box titled by its payload's first heading, with
 *  its stats on the title rule; a divider block as its lines across the
 *  pane. The box is indented by tool depth, as the call list is. */
function paintBlock(
  block: TranscriptBlock,
  expanded: boolean,
  width: number,
  active: boolean,
  options: TranscriptPayloadOptions,
): Painted[] {
  const payload = transcriptPayload(block, expanded, options);
  const [first, ...rest] = payload;
  if (!BOXED.includes(block.kind) || first?.kind !== "heading") {
    return paintPayload(payload, width);
  }
  const spec = {
    title: first.text,
    stats: blockStats(block),
    color: spineColor(block),
    indent: Math.min(block.depth * LAYOUT.indent, Math.max(0, width - LAYOUT.minBoxWidth)),
    active,
    sides: width >= SIDES_MIN_WIDTH,
  };
  return boxLines(paintPayload(rest, boxInnerWidth(width, spec)), width, spec);
}
/** What the title rule says on the right: an LLM call's time, context
 *  and cost; a tool's result size and time. */
function blockStats(block: TranscriptBlock): string {
  if (block.kind === "assistant") {
    return `${fmtDuration(block.round.durationMs)} · ${fmtTokens(block.round.contextTokens)} in · ${fmtUsd(block.round.costUsd)}`;
  }
  if (block.kind === "tool") {
    const duration =
      block.row.durationMs === undefined ? "no duration" : fmtDuration(block.row.durationMs);
    return `${block.outputLines} ${block.outputLines === 1 ? "line" : "lines"} · ${duration}`;
  }
  return "";
}
/** Only a problem gets a mark in the call list; a plain result does not. */
function toolMark(status: ToolStatus): string {
  return ["failed", "rejected", "awaitingApproval"].includes(status)
    ? `${TOOL_STATUS_MARK[status]} `
    : "";
}
/** The call list's row for a block, indented by how many tool calls deep
 *  its thread runs, so a sub-agent's calls sit under the tool that
 *  started them. */
function spineLabel(block: TranscriptBlock): string {
  const indent = " ".repeat(block.depth * LAYOUT.indent);
  switch (block.kind) {
    case "assistant": {
      const suffix = block.round.decision === undefined ? "" : " · decision";
      return `${indent}LLM call ${block.round.index + 1}${suffix}`;
    }
    case "tool":
      return `${indent}  ${toolMark(block.row.status)}${block.row.name}`;
    case "thread":
      return `${indent}Thread · ${block.label}`;
    case "turn": {
      const title = block.turn.userText?.split("\n")[0].trim();
      return `turn ${block.turn.index + 1}${title ? ` · ${title}` : ""}`;
    }
    case "user":
      return `${indent}${block.promptTo === undefined ? "user" : "prompt"}`;
    case "handback":
      return `${indent}↩ ${block.tool}`;
    case "error":
      return `${indent}✖ error`;
    case "pause":
      return `${indent}${block.resumed ? "⏸ paused · resumed" : "⏸ paused"}`;
    case "rewrite":
      return `${indent}⚠ changed`;
    case "history":
      return `${indent}history · ${block.message.role}`;
    default:
      return `${indent}${block.kind}`;
  }
}

/** The trace's colors by kind, so a tool reads as a tool on every screen
 *  and a system prompt sits back in chrome. */
function spineColor(block: TranscriptBlock): string {
  const role = block.kind === "history" ? block.message.role : block.kind;
  if (role === "user" || role === "turn") {
    return THEME.kind.user;
  }
  if (block.kind === "handback") {
    return THEME.kind.tool;
  }
  if (role === "assistant") {
    return THEME.kind.assistant;
  }
  if (role === "thread") {
    return THEME.accent;
  }
  if (role === "pause") {
    return THEME.kind.interrupt;
  }
  if (
    role === "error" ||
    (block.kind === "tool" && ["failed", "rejected"].includes(block.row.status))
  ) {
    return THEME.kind.error;
  }
  if (block.kind === "tool" && block.row.status === "awaitingApproval") {
    return THEME.kind.interrupt;
  }
  if (block.kind === "tool") {
    return THEME.kind.tool;
  }
  return block.kind === "system" ? THEME.chrome : THEME.text;
}
