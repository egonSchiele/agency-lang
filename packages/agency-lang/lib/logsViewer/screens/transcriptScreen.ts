import { column, row } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { joinPainted, paint, paintedLine, segment, type Painted } from "../../tui/paint.js";
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
import { parseRoundId } from "../timeline/rounds.js";
import {
  threadKey,
  transcriptBlocks,
  transcriptText,
  type TranscriptBlock,
} from "../transcript.js";
import { transcriptPayload } from "../transcriptPayload.js";
import type { TreeNode } from "../types.js";
import type { ViewAction, Viewport } from "../views/view.js";
import { paintPayload } from "./payloadPaint.js";
import { lineNumberWidth, numberedBlocks } from "./lineNumbers.js";
import { keyFooter } from "./chrome.js";
import type { Screen } from "./screen.js";
const LAYOUT = { spineWidth: 28, dividerWidth: 2, fixedRows: 1, gap: 1, half: 2 };
type BlockLines = { id: string; start: number; lines: Painted[] };

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
  private pageBy(delta: number): void {
    const total = this.painted.flatMap((block) => block.lines).length;
    this.scrollTop = Math.max(
      0,
      Math.min(this.scrollTop + delta, Math.max(this.scrollTop, total - this.page)),
    );
    const atTop = this.painted.filter((block) => block.start <= this.scrollTop).at(-1);
    if (atTop) {
      this.cursor = atTop.id;
    }
    this.needsReveal = false;
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
        const lines = paintBlock(block, this.expanded.includes(block.id), width);
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
      this.scrollTop = focused?.start ?? 0;
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
  render(viewport: Viewport, sharedHints = ""): Element {
    this.prepare(viewport);
    const position = this.blocks.findIndex((block) => block.id === this.cursor);
    const spineTop = Math.max(0, position - this.page + 1);
    const spine = this.blocks.slice(spineTop, spineTop + this.page).map((block) =>
      paintedLine(
        segment(`${block.id === this.cursor ? "▶" : " "} ${spineLabel(block)}`, LAYOUT.spineWidth, {
          style: {
            fg: spineColor(block),
            ...(block.id === this.cursor ? { bg: THEME.cursorBg } : {}),
          },
        }),
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
function paintBlock(block: TranscriptBlock, expanded: boolean, width: number): Painted[] {
  const body = paintPayload(transcriptPayload(block, expanded), width);
  if (block.kind !== "assistant") {
    return body;
  }
  const stats = `${fmtDuration(block.round.durationMs)} · ${fmtTokens(block.round.contextTokens)} ctx · ${fmtUsd(block.round.costUsd)}`;
  const heading = joinPainted(
    segment(
      `── ASSISTANT · LLM call ${block.round.index + 1} ──`,
      Math.max(0, width - stats.length),
      {
        style: { fg: THEME.kind.assistant, bold: true },
      },
    ),
    segment(stats, Math.min(width, stats.length), { align: "right", style: { fg: THEME.muted } }),
  );
  return [heading, ...body];
}
function spineLabel(block: TranscriptBlock): string {
  switch (block.kind) {
    case "assistant":
      return `LLM call ${block.round.index + 1}`;
    case "tool":
      return `  ${block.row.name}`;
    case "rewrite":
      return "⚠ rewrite";
    case "history":
      return block.message.role;
    default:
      return block.kind;
  }
}

function spineColor(block: TranscriptBlock): string {
  const role = block.kind === "history" ? block.message.role : block.kind;
  if (role === "user") {
    return THEME.kind.user;
  }
  if (role === "assistant") {
    return THEME.kind.assistant;
  }
  return THEME.text;
}
