import { column } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { paint, paintedLine, segment, type Painted } from "../../tui/paint.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { resolveDetailRow } from "../detailTarget.js";
import {
  cursorBindings,
  helpFrom,
  hintsFrom,
  runViewerKey,
  type ViewerBinding,
} from "../keymap.js";
import { payloadFor } from "../payload.js";
import { paintPayload } from "../screens/payloadPaint.js";
import type { StoryRow } from "../story.js";
import { THEME } from "../theme.js";
import type { ViewerThresholds } from "../thresholds.js";
import type { TreeNode } from "../types.js";
import type { View, ViewAction, Viewport } from "./view.js";
const LAYOUT = { fixedRows: 2 };
type PayloadCache = { width: number; raw: boolean; lines: Painted[] };
export class DetailScreen implements View {
  readonly viewName = "detail" as const;
  private row: StoryRow | undefined;
  private raw = false;
  private scroll = 0;
  private pageRows = 1;
  private totalRows = 0;
  private message = "";
  private cache: PayloadCache | undefined;
  constructor(
    roots: TreeNode[],
    private readonly rowId: string,
    _thresholds: ViewerThresholds,
  ) {
    this.setData(roots);
  }
  private move(delta: number): void {
    this.scroll = Math.max(
      0,
      Math.min(this.scroll + delta, Math.max(0, this.totalRows - this.pageRows)),
    );
  }
  private bindings(): ViewerBinding[] {
    return [
      ...cursorBindings<ViewAction>({
        by: (delta) => this.move(delta),
        toTop: () => this.move(-Infinity),
        toBottom: () => this.move(Infinity),
        page: () => this.pageRows,
        halfPage: () => Math.max(1, Math.floor(this.pageRows / 2)),
      }),
      { keys: ["Left", "h"], help: "back", hint: "← back", run: () => ({ kind: "back" }) },
      {
        keys: ["r"],
        help: "toggle raw JSON",
        hint: "r raw",
        run: () => {
          this.raw = !this.raw;
          this.scroll = 0;
        },
      },
      {
        keys: ["y"],
        help: "copy the whole page",
        hint: "y copy",
        run: () => ({
          kind: "copy",
          text: this.allLines(10000)
            .map((line) =>
              parseStyledText(line)
                .map((part) => part.text)
                .join(""),
            )
            .join("\n"),
        }),
      },
    ];
  }
  handleKey(event: KeyEvent, viewport: Viewport): ViewAction {
    if (!this.row) {
      return { kind: "back" };
    }
    this.totalRows = this.allLines(viewport.cols).length;
    this.pageRows = Math.max(1, viewport.rows - LAYOUT.fixedRows);
    return runViewerKey(this.bindings(), formatKey(event));
  }
  render(viewport: Viewport): Element {
    const all = this.allLines(viewport.cols);
    this.totalRows = all.length;
    this.pageRows = Math.max(1, viewport.rows - LAYOUT.fixedRows);
    this.move(0);
    const visible = all.slice(this.scroll, this.scroll + this.pageRows);
    return column(
      { height: viewport.rows, justifyContent: "flex-start" },
      paintedLine(
        segment(`DETAIL ${this.row ? this.rowId : "(row no longer in the log)"}`, viewport.cols, {
          style: { fg: THEME.accent },
        }),
      ),
      column(
        { height: this.pageRows, justifyContent: "flex-start" },
        ...visible.map((line) => paintedLine(line)),
      ),
      paintedLine(
        paint(
          `(${Math.min(this.scroll + 1, all.length)}–${Math.min(this.scroll + this.pageRows, all.length)} of ${all.length}) ${hintsFrom(this.bindings())} ${this.message}`,
          { fg: THEME.muted },
        ),
      ),
    );
  }
  setData(roots: TreeNode[]): void {
    this.row = resolveDetailRow(roots, this.rowId);
    this.cache = undefined;
  }
  helpLines(): string[] {
    return helpFrom(this.bindings());
  }
  notify(message: string): void {
    this.message = message;
  }
  setFollowIndicator(): void {}
  allLines(width: number): Painted[] {
    if (!this.row) {
      return [];
    }
    if (this.cache?.width !== width || this.cache?.raw !== this.raw) {
      this.cache = {
        width,
        raw: this.raw,
        lines: paintPayload(payloadFor(this.row, { raw: this.raw }), width),
      };
    }
    return this.cache.lines;
  }
}
