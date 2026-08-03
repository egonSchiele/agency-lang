import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { openLabelingSession, type LabelingSessionController } from "@/eval/label/controller.js";
import { runLabelTui } from "@/eval/label/labelTui.js";
import type { Annotator } from "@/eval/label/types.js";

const DEFAULT_STORE_DIRECTORY = "labels";
const FALLBACK_ANNOTATOR_ID = "human";

export type EvalLabelOptions = {
  source: string;
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
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
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

const defaultDependencies: EvalLabelDependencies = {
  openSession: openLabelingSession,
  runTui: runLabelTui,
  input: process.stdin,
  output: process.stdout,
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
  if (!fs.existsSync(options.source)) {
    throw new Error(`Source run directory not found: ${options.source}`);
  }

  const config = options.config ?? {};
  const controller: LabelingSessionController = await dependencies.openSession({
    sourceDir: path.resolve(options.source),
    storeDir: resolveLabelStore(options, config),
    checklistFile: path.resolve(options.checklist),
    annotator: resolveAnnotator(options, dependencies),
    reportWarning: (message) => console.warn(message),
  });

  // The session owns a lock and a draft; closing it is not optional, which is
  // why the CLI holds the finally rather than the terminal loop.
  try {
    await dependencies.runTui({
      controller,
      input: dependencies.input,
      output: dependencies.output,
    });
  } finally {
    await controller.close();
  }
}
