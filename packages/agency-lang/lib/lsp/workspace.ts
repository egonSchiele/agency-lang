import { AgencyConfig, findProjectRoot, loadConfigSafe } from "../config.js";
import * as path from "path";

type WorkspaceEntry = {
  root: string;
  config: AgencyConfig;
};

const workspaces: Record<string, WorkspaceEntry> = {};

export function getWorkspaceForFile(fsPath: string): WorkspaceEntry {
  const root = findProjectRoot(fsPath) ?? path.dirname(fsPath);
  if (!workspaces[root]) {
    const { config } = loadConfigSafe(path.join(root, "agency.json"));
    workspaces[root] = { root, config };
  }
  return workspaces[root];
}

export function invalidateWorkspace(root: string): void {
  delete workspaces[root];
}
