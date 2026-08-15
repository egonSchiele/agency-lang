import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { createLabelingHost, type LabelingHost } from "@/eval/label/labelingHost.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";
import { Screen } from "@/tui/screen.js";
import type { Annotator } from "@/eval/label/types.js";

const DEFAULT_STORE_DIRECTORY = "labels";
const FALLBACK_ANNOTATOR_ID = "human";

export type EvalLabelOptions = {
  checklist?: string;
  dataset?: string;
  store?: string;
  annotator?: string;
  config?: AgencyConfig;
};

/** The dataset directory can be named two ways at each layer: the preferred
 *  `--dataset`/`eval.dataset` and the deprecated `--store`/`eval.labelStore`. */
export type DatasetLocationOptions = {
  dataset?: string;
  store?: string;
};

/** @internal Injected so the fallback order is testable without a real
 *  environment or terminal. */
export type EvalLabelDependencies = {
  /** Built here rather than inside the host so the terminal lifecycle has one
   *  owner: the CLI creates and destroys the screen, the host runs on it. */
  makeScreen(): Screen;
  makeHost(screen: Screen, currentSize: () => { width: number; height: number }): LabelingHost;
  isInteractive(): boolean;
  environment: NodeJS.ProcessEnv;
  osUserName(): string | undefined;
};

/**
 * A relative store resolves from the invoking working directory, matching how
 * `runSuite` resolves `runsDir` — the two are sibling notions of "where this
 * project keeps its eval artifacts".
 */
export function resolveDataset(
  options: DatasetLocationOptions,
  config: AgencyConfig,
): string {
  const fromFlags = resolveAliasedValue({
    preferredName: "--dataset",
    preferredValue: options.dataset,
    legacyName: "--store",
    legacyValue: options.store,
  });
  const fromConfig = resolveAliasedValue({
    preferredName: "eval.dataset",
    preferredValue: config.eval?.dataset,
    legacyName: "eval.labelStore",
    legacyValue: config.eval?.labelStore,
  });
  // Flags win over config, matching how runsDir and every other CLI override
  // behaves.
  return path.resolve(fromFlags ?? fromConfig ?? DEFAULT_STORE_DIRECTORY);
}

type AliasedValue = {
  preferredName: string;
  preferredValue?: string;
  legacyName: string;
  legacyValue?: string;
};

/** Two names for one setting. Equal values or only-one-present are fine;
 *  both present and disagreeing is a hard error rather than a silent winner,
 *  because a silent winner is how a run writes to the wrong dataset. */
function resolveAliasedValue(value: AliasedValue): string | undefined {
  const bothPresent = value.preferredValue !== undefined && value.legacyValue !== undefined;
  if (bothPresent && value.preferredValue !== value.legacyValue) {
    throw new Error(
      `${value.preferredName} and ${value.legacyName} disagree ` +
      `(${value.preferredValue} vs ${value.legacyValue}); set only one.`,
    );
  }
  return value.preferredValue ?? value.legacyValue;
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
  makeHost: (screen, currentSize) => createLabelingHost(screen, currentSize),
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
  const datasetDir = resolveDataset(options, config);

  // The CLI owns the terminal (it created the screen); the labeling host owns
  // the session lifecycle on it. Destroying the screen stays here.
  const screen = dependencies.makeScreen();
  const host = dependencies.makeHost(screen, () => ({
    width: terminalDimension(process.stdout.columns, DEFAULT_COLUMNS),
    height: terminalDimension(process.stdout.rows, DEFAULT_ROWS),
  }));
  try {
    await host.run({
      datasetDir,
      checklistFile: path.resolve(options.checklist),
      annotator: resolveAnnotator(options, dependencies),
    });
  } finally {
    screen.destroy();
  }
}
