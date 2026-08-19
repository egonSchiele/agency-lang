import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openLabelingSession, type LabelingSessionController } from "@/eval/label/controller.js";
import { resolveLabelingGroup, type LabelingGroup } from "@/eval/label/group.js";
import { runLabelTui } from "@/eval/label/labelTui.js";
import type { Annotator } from "@/eval/label/types.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";
import { Screen } from "@/tui/screen.js";

const FALLBACK_ANNOTATOR_ID = "human";

export type LabelOptions = {
  /** Run directories, or directories of run directories. */
  paths: string[];
  checklist?: string;
  annotator?: string;
};

/** What a session is opened with, once the CLI has resolved every flag and
 *  path: the one group, never the paths it came from. */
export type LabelRequest = {
  group: LabelingGroup;
  checklistFile: string;
  annotator: Annotator;
};

/** @internal Injected so the fallback order and the terminal lifecycle are
 *  testable without a real environment or terminal. */
export type LabelDependencies = {
  /** The CLI creates and destroys the screen; the session runs on it. */
  makeScreen(): Screen;
  openSession(request: LabelRequest): Promise<LabelingSessionController>;
  runTui: typeof runLabelTui;
  reportWarning(message: string): void;
  isInteractive(): boolean;
  environment: NodeJS.ProcessEnv;
  osUserName(): string | undefined;
};

/** Who is judging. Recorded on every annotation, and part of the fold key, so
 *  it must never silently change between sessions. */
export function resolveAnnotator(
  options: { annotator?: string },
  dependencies: Pick<LabelDependencies, "environment" | "osUserName">,
): Annotator {
  const explicit = options.annotator?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { kind: "human", id: explicit };
  }
  const fromEnvironment = dependencies.environment.USER?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return { kind: "human", id: fromEnvironment };
  }
  const fromOs = dependencies.osUserName()?.trim();
  if (fromOs !== undefined && fromOs.length > 0) {
    return { kind: "human", id: fromOs };
  }
  return { kind: "human", id: FALLBACK_ANNOTATOR_ID };
}

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;

/**
 * A usable terminal dimension.
 *
 * `??` is not enough: a PTY with no attached window reports **0**, not
 * undefined, and a zero-width screen lays every element out to nothing and
 * renders a blank frame. Anything that is not a positive finite number falls
 * back.
 */
export function terminalDimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function currentTerminalSize(): { width: number; height: number } {
  return {
    width: terminalDimension(process.stdout.columns, DEFAULT_COLUMNS),
    height: terminalDimension(process.stdout.rows, DEFAULT_ROWS),
  };
}

const defaultDependencies: LabelDependencies = {
  makeScreen: () =>
    new Screen({
      input: new TerminalInput({ suppressSigint: true }),
      output: new TerminalOutput(),
      ...currentTerminalSize(),
    }),
  openSession: (request) =>
    openLabelingSession({ ...request, reportWarning: (message) => console.warn(message) }),
  runTui: runLabelTui,
  reportWarning: (message) => console.warn(message),
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  environment: process.env,
  osUserName: () => {
    try {
      return os.userInfo().username;
    } catch {
      // Some sandboxes have no passwd entry; the literal fallback covers it.
      return undefined;
    }
  },
};

/** `agency label <path…> --checklist <file>`: judge every run the paths name
 *  (run directories, or groups of them) against a checklist, on an
 *  interactive screen. */
export async function label(
  options: LabelOptions,
  dependencies: LabelDependencies = defaultDependencies,
): Promise<void> {
  if (options.checklist === undefined || options.checklist.trim().length === 0) {
    throw new Error(
      "--checklist is required: it names the questions you are judging against. Point it at a " +
        'JSON file like { "name": "news-quality", "questions": [{ "text": "Is it accurate?" }] } to ' +
        "start a new checklist, or at one you have used before to continue it.",
    );
  }
  if (!fs.existsSync(options.checklist)) {
    throw new Error(`Checklist file not found: ${options.checklist}`);
  }
  if (!dependencies.isInteractive()) {
    throw new Error(
      "agency label needs an interactive terminal: it shows outputs and reads " +
        "keystrokes. Run it directly rather than through a pipe.",
    );
  }

  const request: LabelRequest = {
    group: resolveLabelingGroup(options.paths, { reportWarning: dependencies.reportWarning }),
    checklistFile: path.resolve(options.checklist),
    annotator: resolveAnnotator(options, dependencies),
  };

  // Open the session before taking the terminal, so a locked or malformed
  // directory reports as a plain error rather than a flash of raw mode.
  const controller = await dependencies.openSession(request);
  let screen: Screen;
  try {
    screen = dependencies.makeScreen();
  } catch (error) {
    await controller.close();
    throw error;
  }
  try {
    await dependencies.runTui({
      controller,
      screen,
      title: path.basename(request.group.dir),
      currentSize: currentTerminalSize,
    });
  } finally {
    try {
      await controller.close();
    } finally {
      screen.destroy();
    }
  }
}
