import * as path from "path";
import type { AgencyConfig } from "../config.js";
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  findProjectRoot,
  projectTarget,
  readConfig,
} from "../configTarget.js";

type WorkspaceEntry = {
  root: string;
  config: AgencyConfig;
};

const CONFIG_FILE_NAMES = [CONFIG_FILE, LOCAL_CONFIG_FILE];

const workspaces: Record<string, WorkspaceEntry> = {};

function loadWorkspace(root: string): WorkspaceEntry {
  const { config, error } = readConfig(projectTarget(root));
  if (error !== undefined) {
    // stderr: stdout carries the language server protocol.
    console.error(`[agency lsp] using default config: ${error}`);
  }
  return { root, config };
}

export function getWorkspaceForFile(fsPath: string): WorkspaceEntry {
  const root = findProjectRoot(fsPath) ?? path.dirname(fsPath);
  workspaces[root] ??= loadWorkspace(root);
  return workspaces[root];
}

export function invalidateWorkspace(root: string): void {
  delete workspaces[root];
}

/** The directory holding `fsPath` when it is a config file, else null. */
export function configFileDir(fsPath: string): string | null {
  return CONFIG_FILE_NAMES.includes(path.basename(fsPath)) ? path.dirname(fsPath) : null;
}
