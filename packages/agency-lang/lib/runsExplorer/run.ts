// The explorer shell: the one imperative boundary. Owns the screen, the
// view set, the loader pump, and the embedded-viewer hand-off. Two hard
// rules keep it honest:
//
//   * At most ONE outstanding key request, and NEVER one while the
//     embedded viewer runs — a stale explorer waiter would steal the
//     viewer's first keypress.
//   * The loader advances once per macrotask (setImmediate), so a large
//     backfill scan cannot starve input: `q` lands between chunks.
//
// View arrangement: three cycling variants (runs → compare → trend) at
// the bottom, a loading splash before the first rows, and an overlay
// stack (tests, info) above. Esc pops the overlay, then falls back to
// the runs variant, then goes inert; q quits from anywhere.
import * as fs from "fs";

import { runViewer } from "../logsViewer/run.js";
import type { Annotator } from "../eval/label/types.js";
import { Screen } from "../tui/screen.js";
import type { InputSource, KeyEvent } from "../tui/input/types.js";
import type { OutputTarget } from "../tui/output/types.js";
import { createRunsLoader, type LoaderEvent, type RunsLoader } from "./loader.js";
import type { RunRow } from "./rows.js";
import type { Source } from "./sources.js";
import { exportCsv, csvRowsFromProjection } from "./csv.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./views/explorerView.js";
import { CompareView } from "./views/compareView.js";
import { InfoScreen } from "./views/infoScreen.js";
import { LoadingScreen } from "./views/loadingScreen.js";
import { RunsTableView } from "./views/runsTableView.js";
import { TestsTableView } from "./views/testsTableView.js";
import { TrendView } from "./views/trendView.js";

const VARIANTS = ["runs", "compare", "trend"] as const;
type Variant = (typeof VARIANTS)[number];

export type ExplorerOptions = {
  sources: Source[];
  /** "runTable" (a sole run-dir argument) starts on the per-test table. */
  route: "runTable" | "explorer";
  input: InputSource;
  output: OutputTarget;
  viewport: Viewport;
  /** Injectable for tests; production uses the real logs viewer. */
  runViewerFn?: typeof runViewer;
  /** When set, a drilled-into statelog enables the tree `l` label action,
   *  targeting this dataset. The per-run statelog path becomes the source. */
  labeling?: { datasetDir: string; checklistFile?: string; annotator: Annotator };
};

export async function runExplorer(options: ExplorerOptions): Promise<void> {
  const shell = new ExplorerShell(options);
  await shell.run();
}

class ExplorerShell {
  private readonly screen: Screen;
  private readonly loader: RunsLoader;
  private readonly variants: Record<Variant, ExplorerView> = {
    runs: new RunsTableView(),
    compare: new CompareView(),
    trend: new TrendView(),
  };
  private readonly loading = new LoadingScreen();
  private variant: Variant = "runs";
  private overlay: ExplorerView[] = [];
  private rows: RunRow[] = [];
  private rowsSeen = false;
  private pendingKey: Promise<KeyEvent> | null = null;
  /** The `.then`-derived race arm, cached WITH pendingKey: deriving a
   *  fresh one per tick would pile a handler onto the same underlying
   *  promise for every chunk of a long scan (same fix as
   *  Screen.runLoop, lib/tui/screen.ts). */
  private pendingKeyStep: Promise<{ kind: "key"; event: KeyEvent }> | null = null;

  constructor(private readonly options: ExplorerOptions) {
    this.loader = createRunsLoader(options.sources);
    this.screen = new Screen({
      input: options.input,
      output: options.output,
      width: options.viewport.cols,
      height: options.viewport.rows,
    });
    if (options.route === "runTable" && options.sources[0]?.kind === "runDir") {
      this.overlay.push(new TestsTableView(options.sources[0].dir));
    }
  }

  async run(): Promise<void> {
    try {
      this.render();
      for (;;) {
        const step = await this.nextStep();
        if (step.kind === "tick") {
          this.dispatchLoader(this.loader.advance());
          this.render();
          continue;
        }
        const quit = await this.handleKey(step.event);
        if (quit) {
          return;
        }
        this.render();
      }
    } finally {
      this.screen.destroy();
    }
  }

  /** Either the (single) outstanding key resolves, or one macrotask
   *  passes and the loader gets one unit of work. */
  private async nextStep(): Promise<{ kind: "key"; event: KeyEvent } | { kind: "tick" }> {
    if (this.pendingKey === null) {
      this.pendingKey = this.screen.nextKey();
      this.pendingKeyStep = this.pendingKey.then((event) => ({ kind: "key" as const, event }));
    }
    if (this.loader.isDone()) {
      const event = await this.pendingKey;
      this.pendingKey = null;
      this.pendingKeyStep = null;
      return { kind: "key", event };
    }
    const winner = await Promise.race([
      this.pendingKeyStep as Promise<{ kind: "key"; event: KeyEvent }>,
      nextMacrotask().then(() => ({ kind: "tick" as const })),
    ]);
    if (winner.kind === "key") {
      this.pendingKey = null;
      this.pendingKeyStep = null;
    }
    return winner;
  }

  private dispatchLoader(events: LoaderEvent[]): void {
    for (const event of events) {
      if (event.kind === "progress") {
        this.everyView((view) => view.setProgress(event));
      } else if (event.kind === "upsert") {
        this.rowsSeen = true;
        const at = this.rows.findIndex((row) => row.key === event.row.key);
        if (at === -1) {
          this.rows.push(event.row);
        } else {
          this.rows[at] = event.row;
        }
        this.everyView((view) => view.setData(this.rows));
      } else {
        this.rows = event.rows;
        this.everyView((view) => {
          view.setData(this.rows);
          view.setProgress(null);
        });
      }
    }
  }

  private everyView(apply: (view: ExplorerView) => void): void {
    for (const variant of VARIANTS) {
      apply(this.variants[variant]);
    }
    apply(this.loading);
    for (const view of this.overlay) {
      apply(view);
    }
  }

  private active(): ExplorerView {
    const top = this.overlay[this.overlay.length - 1];
    if (top !== undefined) {
      return top;
    }
    if (!this.rowsSeen) {
      return this.loading;
    }
    return this.variants[this.variant];
  }

  private render(): void {
    this.screen.render(this.active().render(this.options.viewport));
  }

  /** Returns true when the app should exit. */
  private async handleKey(event: KeyEvent): Promise<boolean> {
    const action = this.active().handleKey(event, this.options.viewport);
    return this.dispatchAction(action);
  }

  private async dispatchAction(action: ExplorerAction): Promise<boolean> {
    if (action.kind === "quit") {
      return true;
    }
    if (action.kind === "back") {
      if (this.overlay.length > 0) {
        this.overlay.pop();
      } else if (this.variant !== "runs") {
        this.variant = "runs";
      }
      return false;
    }
    if (action.kind === "cycleView") {
      this.overlay = [];
      const at = VARIANTS.indexOf(this.variant);
      this.variant = VARIANTS[(at + VARIANTS.length + action.delta) % VARIANTS.length];
      return false;
    }
    if (action.kind === "openRun") {
      const tests = new TestsTableView(action.parentRunKey);
      tests.setData(this.rows);
      this.overlay.push(tests);
      return false;
    }
    if (action.kind === "openInfo") {
      const info = new InfoScreen(action.rowKey);
      info.setData(this.rows);
      this.overlay.push(info);
      return false;
    }
    if (action.kind === "openLog") {
      return this.openLog(action.statelogPath);
    }
    if (action.kind === "exportCsv") {
      const { path: outPath, content } = exportCsv(
        csvRowsFromProjection(action.projection, this.rows),
        new Date(),
      );
      // User-triggered disk write: a read-only cwd or full disk must
      // land in the status line, not as a stack trace over the screen.
      try {
        fs.writeFileSync(outPath, content);
        this.active().notify(`exported → ${outPath}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.active().notify(`export failed: ${text}`);
      }
      return false;
    }
    return false;
  }

  /** Hand the SAME terminal to the logs viewer. The explorer must not
   *  hold a key waiter while the viewer runs — the assertion guards the
   *  bug where a stale waiter eats the viewer's first keypress. Sharing
   *  one OutputTarget between two Screen instances is safe because
   *  TerminalOutput owns the single previousGrid both write through, so
   *  the diff-based repaint stays coherent across the hand-off. */
  private async openLog(statelogPath: string): Promise<boolean> {
    if (this.pendingKey !== null) {
      throw new Error("explorer key waiter still outstanding at viewer hand-off");
    }
    const viewerFn = this.options.runViewerFn ?? runViewer;
    try {
      const resolution = await viewerFn({
        input: this.options.input,
        output: this.options.output,
        viewport: { rows: this.options.viewport.rows, cols: this.options.viewport.cols },
        followPath: statelogPath,
        embedded: true,
        labeling:
          this.options.labeling === undefined
            ? undefined
            : { ...this.options.labeling, sourcePath: statelogPath },
      });
      if (resolution === "quit") {
        return true;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.active().notify(`viewer failed: ${text}`);
    }
    return false;
  }
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
