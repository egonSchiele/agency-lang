import * as path from "path";

import type { Screen } from "@/tui/screen.js";

import { openLabelingSession } from "./controller.js";
import { readFieldOrder } from "./dataset.js";
import { runLabelTui } from "./labelTui.js";
import type { Annotator } from "./types.js";

export type LabelingRequest = {
  datasetDir: string;
  checklistFile: string;
  annotator: Annotator;
  focusOutputId?: string;
};

/** The single owner of the open-session -> run-TUI -> close-controller
 *  sequence for an already-created terminal. Shared by the CLI and the viewer
 *  so neither reimplements the labeling lifecycle. It never destroys the
 *  `Screen`: whoever created the terminal owns tearing it down. */
export type LabelingHost = {
  run(request: LabelingRequest): Promise<void>;
};

/** @internal Injected so lifecycle tests need no real dataset or terminal. */
export type LabelingHostDependencies = {
  openSession: typeof openLabelingSession;
  runTui: typeof runLabelTui;
  readFieldOrder: typeof readFieldOrder;
};

const defaultDependencies: LabelingHostDependencies = {
  openSession: openLabelingSession,
  runTui: runLabelTui,
  readFieldOrder,
};

export function createLabelingHost(
  screen: Screen,
  currentSize: () => { width: number; height: number },
  dependencies: LabelingHostDependencies = defaultDependencies,
): LabelingHost {
  return {
    async run(request: LabelingRequest): Promise<void> {
      const controller = await dependencies.openSession({
        datasetDir: request.datasetDir,
        checklistFile: request.checklistFile,
        annotator: request.annotator,
        focusOutputId: request.focusOutputId,
        reportWarning: (message) => console.warn(message),
      });
      try {
        await dependencies.runTui({
          controller,
          screen,
          datasetLabel: path.basename(request.datasetDir),
          fieldOrder: dependencies.readFieldOrder(request.datasetDir),
          currentSize,
        });
      } finally {
        await controller.close();
      }
    },
  };
}
