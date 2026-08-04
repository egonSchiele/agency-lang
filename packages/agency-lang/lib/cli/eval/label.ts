import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { openLabelingSession, type LabelingSessionController } from "@/eval/label/controller.js";
import { readFieldOrder } from "@/eval/label/store.js";
import { runLabelTui } from "@/eval/label/labelTui.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";
import { Screen } from "@/tui/screen.js";
import type { Annotator } from "@/eval/label/types.js";

const DEFAULT_STORE_DIRECTORY = "labels";
const FALLBACK_ANNOTATOR_ID = "human";

export type EvalLabelOptions = {
  checklist?: string;
  store?: string;
  annotator?: string;
  config?: AgencyConfig;
};

/** @internal Injected so the fallback order is testable without a real
 *  environment or terminal. */
export type EvalLabelDependencies = {
  openSession: typeof openLabelingSession;
  runTui: typeof runLabelTui;
  /** Built here rather than inside the TUI so the terminal lifecycle has one
   *  owner, alongside the session it must be torn down with. */
  makeScreen(): Screen;
  isInteractive(): boolean;
  environment: NodeJS.ProcessEnv;
  osUserName(): string | undefined;
};

/**
 * A relative store resolves from the invoking working directory, matching how
 * `runSuite` resolves `runsDir` — the two are sibling notions of "where this
 * project keeps its eval artifacts".
 */
export function resolveLabelStore(
  options: { store?: string },
  config: AgencyConfig,
): string {
  return path.resolve(options.store ?? config.eval?.labelStore ?? DEFAULT_STORE_DIRECTORY);
}

/** Who is judging. Recorded on every annotation, and part of the fold key, so
 *  it must never silently change between sessions. */
export function resolveAnnotator(
  options: { annotator?: string },
  dependencies: Pick<EvalLabelDependencies, "environment" | "osUserName">,
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

const defaultDependencies: EvalLabelDependencies = {
  openSession: openLabelingSession,
  runTui: runLabelTui,
  makeScreen: () => new Screen({
    input: new TerminalInput({ suppressSigint: true }),
    output: new TerminalOutput(),
    width: terminalDimension(process.stdout.columns, DEFAULT_COLUMNS),
    height: terminalDimension(process.stdout.rows, DEFAULT_ROWS),
  }),
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

export async function evalLabel(
  options: EvalLabelOptions,
  dependencies: EvalLabelDependencies = defaultDependencies,
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
      "agency eval label needs an interactive terminal: it shows outputs and reads " +
      "keystrokes. Run it directly rather than through a pipe.",
    );
  }

  const config = options.config ?? {};
  const storeDir = resolveLabelStore(options, config);
  const controller: LabelingSessionController = await dependencies.openSession({
    storeDir,
    checklistFile: path.resolve(options.checklist),
    annotator: resolveAnnotator(options, dependencies),
    reportWarning: (message) => console.warn(message),
  });

  // The session owns a lock and a draft, and the screen owns raw mode; closing
  // both is not optional, which is why the CLI holds the finallys rather than
  // the terminal loop.
  const screen = dependencies.makeScreen();
  try {
    await dependencies.runTui({
      controller,
      screen,
      storeLabel: path.basename(storeDir),
      fieldOrder: readFieldOrder(storeDir),
      currentSize: () => ({
        width: terminalDimension(process.stdout.columns, DEFAULT_COLUMNS),
        height: terminalDimension(process.stdout.rows, DEFAULT_ROWS),
      }),
    });
  } finally {
    try {
      screen.destroy();
    } finally {
      await controller.close();
    }
  }
}
