// The explorer's view contract — same shape as the logs viewer's View
// (lib/logsViewer/views/view.ts), with this app's data and actions. The
// two apps stay separate on purpose (separate stacks, separate action
// unions); a view describes INTENT and the shell resolves it.
import type { Element } from "../../tui/elements.js";
import type { KeyEvent } from "../../tui/input/types.js";
import type { LoaderProgress } from "../loader.js";
import type { RunRow } from "../rows.js";
import type { TableProjection } from "./tableState.js";

export type Viewport = { rows: number; cols: number };

export type ExplorerAction =
  | { kind: "openRun"; parentRunKey: string }
  /** The graders table for one test of one run. */
  | { kind: "openTest"; runKey: string; inputId: string }
  /** One grader's verdict on one test, with the input and output it judged. */
  | { kind: "openVerdict"; runKey: string; inputId: string; graderKey: string }
  | { kind: "openLog"; statelogPath: string; title: string; traceId?: string }
  | { kind: "openInfo"; rowKey: string }
  | { kind: "back" }
  | { kind: "exportCsv"; projection: TableProjection }
  | { kind: "cycleView"; delta: 1 | -1 }
  | { kind: "quit" }
  | { kind: "none" };

export type ExplorerView = {
  viewName: "runs" | "tests" | "graders" | "verdict" | "compare" | "trend" | "info" | "loading";
  handleKey(event: KeyEvent, viewport: Viewport): ExplorerAction;
  render(viewport: Viewport): Element;
  /** The loader upserted: every view re-derives from the global rows. */
  setData(rows: RunRow[]): void;
  /** Structured loading progress; null clears it (loading finished). */
  setProgress(progress: LoaderProgress | null): void;
  helpLines(): string[];
  notify(message: string): void;
};
