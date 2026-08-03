// Successful terminal output for the remote commands: the endpoint listing, a
// call result, and the link status. Owns formatting so the command recipes
// don't; all colour goes through termcolors.

import { color } from "@/utils/termcolors.js";
import type { ServeManifest } from "../statelog/serveClient.js";
import type { RemoteBinding } from "./binding.js";

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
