// Successful terminal output for the remote commands: the endpoint listing, a
// call result, and the link status. Owns formatting so the command recipes
// don't; all colour goes through termcolors.

import { color } from "@/utils/termcolors.js";
import type { ServeManifest } from "../statelog/serveClient.js";
import type { AgentMetadata, TraceSummary } from "../statelog/projectClient.js";
import type { RemoteBinding } from "./binding.js";
import type {
  ProjectSummary,
  KeySummary,
  CreatedKey,
} from "../statelog/accountClient.js";

const NONE = "—";

export function renderManifest(manifest: ServeManifest, binding: RemoteBinding): string {
  const lines: string[] = [
    color.bold(binding.filename) + color.dim(` — ${binding.serveUrl}`),
    "",
    color.bold("Nodes"),
  ];
  for (const node of manifest.nodes) {
    lines.push(`  ${color.cyan(node.name)}(${node.parameters.join(", ")})${effectsSuffix(node.interruptEffects)}`);
  }
  lines.push("", color.bold("Functions"));
  for (const fn of manifest.functions) {
    lines.push(`  ${color.cyan(fn.name)}(${fn.parameters.join(", ")})${effectsSuffix(fn.interruptEffects)}`);
    if (fn.description) {
      lines.push(`    ${color.dim(fn.description)}`);
    }
  }
  return lines.join("\n");
}

export function renderResult(value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `${color.green("Result:")}\n${body}`;
}

export function renderLink(binding: RemoteBinding): string {
  return [
    `${color.bold("Agent:")}   ${binding.filename}`,
    `${color.bold("Project:")} ${binding.projectId}`,
    `${color.bold("Serve:")}   ${color.dim(binding.serveUrl)}`,
  ].join("\n");
}

function effectsSuffix(interruptEffects: string[]): string {
  return interruptEffects.length ? color.dim(`  raises ${interruptEffects.join(", ")}`) : "";
}

export function renderWhoami(userId: string, origin: string): string {
  return [
    `${color.bold("User:")} ${userId}`,
    `${color.bold("Host:")} ${color.dim(origin)}`,
  ].join("\n");
}

export function renderProjects(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return color.dim("No projects yet.");
  }
  const rows = projects.map((project) => [
    project.projectId,
    project.name,
    project.description ?? NONE,
  ]);
  return formatStaticTable(["PROJECT", "NAME", "DESCRIPTION"], rows);
}

export function renderProjectCreated(project: ProjectSummary): string {
  return `${color.green("Created project")} ${color.bold(project.projectId)} — ${project.name}`;
}

export function renderKeys(keys: KeySummary[]): string {
  if (keys.length === 0) {
    return color.dim("No API keys yet.");
  }
  const rows = keys.map((key) => [
    key.name ?? NONE,
    key.scope,
    key.projectId ?? NONE,
    key.createdAt,
    key.id,
  ]);
  return formatStaticTable(["NAME", "SCOPE", "PROJECT", "CREATED", "ID"], rows);
}

export function renderCreatedKey(key: CreatedKey): string {
  const project = key.scope === "project" ? ` · ${key.projectId}` : "";
  return [
    `${color.green("Created API key")} ${color.bold(key.name ?? NONE)} (${key.scope}${project})`,
    "",
    color.yellow("Copy this key now — it will not be shown again:"),
    `  ${key.plainKey}`,
  ].join("\n");
}

/** A plain, ANSI-free aligned table. Colour is applied around the table by the
 *  renderers, never inside a cell, so byte-width never skews alignment. */
export function renderAgent(agent: AgentMetadata): string {
  const lines: string[] = [
    `${color.bold("Entry point:")} ${agent.entryPoint ?? NONE}`,
    `${color.bold("Last upload:")} ${agent.lastUploadAt ?? NONE}`,
    "",
  ];
  if (agent.files.length === 0) {
    lines.push(color.dim("No files deployed."));
  } else {
    lines.push(
      formatStaticTable(
        ["FILE", "NODES"],
        agent.files.map((file) => [
          file.name,
          file.nodeNames.length > 0 ? file.nodeNames.join(", ") : NONE,
        ]),
      ),
    );
  }
  lines.push(
    "",
    color.dim(
      "Nodes shown are exported nodes; run `remote ls` for the full callable manifest (functions too).",
    ),
  );
  return lines.join("\n");
}

export function renderTraceList(traces: TraceSummary[]): string {
  if (traces.length === 0) {
    return color.dim("No traces yet.");
  }
  return formatStaticTable(
    ["TRACE", "CREATED"],
    traces.map((trace) => [trace.id, trace.createdAt]),
  );
}

export function renderPullSummary(names: string[], outputDir: string): string {
  const header = `${color.green("Pulled")} ${names.length} file${names.length === 1 ? "" : "s"} to ${outputDir}`;
  return [header, ...names.map((name) => `  ${name}`)].join("\n");
}

function formatStaticTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, columnIndex) => {
    const values = rows.map((row) => row[columnIndex] ?? "");
    return Math.max(header.length, ...values.map((value) => value.length));
  });
  return [headers, ...rows]
    .map((row) =>
      row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ").trimEnd(),
    )
    .join("\n");
}
