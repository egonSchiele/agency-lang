// `agency remote files list` — the read-only inventory of a project's deployed
// files. Deliberately the ONLY file verb in the CLI besides deploy: files are
// mutated through whole-bundle deploys, never individually (per-file deletion
// is a web-app action). The listing exists to make server-side state visible —
// which bundles a file belongs to, and which legacy rows have no stored source
// (those are what break `/source` and `agency remote pull`).

import { createProjectClient } from "../../statelog/projectClient.js";
import type { ProjectFile } from "../../statelog/projectClient.js";
import { resolveProjectTarget, failProjectCommand } from "./util.js";
import type { ProjectCommandOptions, RemoteCommandContext } from "./util.js";

export async function runFilesList(
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveProjectTarget(context, options);
  try {
    const files = await createProjectClient(
      target.origin,
      target.projectSlug,
      target.apiKey,
    ).listFiles();
    console.log(formatFilesTable(files));
  } catch (error) {
    failProjectCommand(error);
  }
}

export function formatFilesTable(files: ProjectFile[]): string {
  if (files.length === 0) {
    return "No files deployed to this project.";
  }
  const rows = files.map((file) => ({
    name: file.fileName,
    nodes: file.nodeNames.join(", ") || "-",
    bundles: file.bundleEntrypoints.join(", ") || "(untracked)",
    source: file.hasSource ? "yes" : "MISSING",
    updated: file.updatedAt.slice(0, 10),
  }));
  const headers = {
    name: "Name",
    nodes: "Nodes",
    bundles: "Bundles",
    source: "Source",
    updated: "Updated",
  };
  const columns = ["name", "nodes", "bundles", "source", "updated"] as const;
  const width = (column: (typeof columns)[number]) =>
    Math.max(headers[column].length, ...rows.map((row) => row[column].length)) + 2;
  const render = (row: Record<(typeof columns)[number], string>) =>
    columns
      .map((column, index) =>
        index === columns.length - 1 ? row[column] : row[column].padEnd(width(column)),
      )
      .join("");
  return [render(headers), ...rows.map(render)].join("\n");
}
