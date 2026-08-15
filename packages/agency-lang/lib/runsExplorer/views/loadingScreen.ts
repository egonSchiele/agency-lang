// What the terminal shows the instant the explorer opens: a progress
// counter that ticks while runs load, and a live `q`. The shell swaps
// this out for the runs table as soon as the first rows exist.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import type { LoaderProgress } from "../loader.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

export class LoadingScreen implements ExplorerView {
  readonly viewName = "loading" as const;
  private progress: LoaderProgress | null = null;

  setData(): void {
    // Rows are the runs table's business; this screen only counts.
  }

  setProgress(progress: LoaderProgress | null): void {
    this.progress = progress;
  }

  notify(): void {
    // No message bar on the splash.
  }

  helpLines(): string[] {
    return ["q quits, even while loading"];
  }

  handleKey(event: KeyEvent): ExplorerAction {
    const key = formatKey(event);
    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const text =
      this.progress === null
        ? "Loading runs…"
        : `Loading runs… ${this.progress.completed}/${this.progress.total}`;
    return column(
      { justifyContent: "flex-start" },
      line(text, { height: 1, fg: "bright-white" }),
      line(bottomHints("q quit", "loading", viewport.cols), { height: 1, fg: "gray" }),
    );
  }
}
