// PROTOTYPE — THROWAWAY. Shell for the cross-run explorer prototype:
// the explorer runs its own little loop, and opening a run's log hands
// the SAME terminal to the real runViewer (tree + timeline views
// included); when the viewer quits, the explorer re-renders. This is the
// "table → individual run → log viewer → back" loop the prototype
// exists to evaluate.
import { runViewer } from "@/logsViewer/run.js";
import { ExplorerProto, loadRows } from "@/logsViewer/explorerProto.js";
import { Screen } from "@/tui/screen.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";

export async function runsProto(paths: string[]): Promise<void> {
  const rows = loadRows(paths.length > 0 ? paths : ["runs"]);
  if (rows.length === 0) {
    console.error("No runs found. Pass run directories, a directory of runs, or statelog files.");
    process.exit(1);
  }
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const viewport = {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
  const explorer = new ExplorerProto(rows);
  const screen = new Screen({ input, output, width: viewport.cols, height: viewport.rows });
  try {
    screen.render(explorer.render(viewport));
    for (;;) {
      const ev = await screen.nextKey();
      const action = explorer.handleKey(ev, viewport);
      if (action.kind === "quit") {
        return;
      }
      if (action.kind === "openLog") {
        // The real viewer, on the same terminal — q inside it returns here.
        await runViewer({ input, output, viewport, followPath: action.path });
      }
      screen.render(explorer.render(viewport));
    }
  } finally {
    screen.destroy();
  }
}
