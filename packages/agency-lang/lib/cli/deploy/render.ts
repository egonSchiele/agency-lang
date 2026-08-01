// Turning a DeployOutcome into terminal output. Presentation only: it builds the
// coloured blocks and hands them to the deployReport template, which owns the
// dry-run vs deployed branch. No deploy logic lives here. Each block carries its
// own leading blank line, so the template concatenates them without whitespace
// fiddling.

import { color } from "@/utils/termcolors.js";
import renderDeployReport from "@/templates/cli/deployReport.js";
import type { DeployOutcome, DeployPlan } from "./deploy.js";
import { serveBaseUrl } from "./uploadClient.js";
import type { Manifest } from "./uploadClient.js";
import { curlExamples } from "./curlExamples.js";

export function renderOutcome(outcome: DeployOutcome): void {
  if (outcome.kind === "error") {
    console.error(`\n${color.red("✗")} ${outcome.error}\n`);
    return;
  }

  const deployed = outcome.kind === "deployed";
  console.log(
    renderDeployReport({
      targetBlock: targetBlock(outcome.plan),
      filesBlock: filesBlock(outcome.plan),
      dryRun: outcome.kind === "preview",
      dryRunNote: `\n\n${color.yellow("dry run")} — nothing uploaded. Re-run without ${color.bold("--dry-run")} to deploy.`,
      deployed,
      deployedBody: deployed ? deployedBody(outcome.endpointUrls, outcome.manifest) : "",
    }),
  );
}

function targetBlock(plan: DeployPlan): string {
  const { target, provenance } = plan;
  const rows = [
    targetRow("host   ", target.host, provenance.host),
    targetRow("project", target.projectId, provenance.projectId),
    targetRow("api key", redactKey(target.apiKey), provenance.apiKey),
  ];
  // Single leading blank line (it's the first block); the rest use section().
  return "\n" + [color.bold("Deploy target"), ...rows].join("\n");
}

function targetRow(label: string, value: string, from: string): string {
  return `  ${color.dim(label)} ${value}   ${color.dim(from)}`;
}

function filesBlock(plan: DeployPlan): string {
  const { bundle } = plan;
  const header = `${color.bold(`Files (${bundle.files.length})`)}   ${color.dim(`entrypoint: ${bundle.entrypoint}`)}`;
  const rows = bundle.files.map(
    (file) => `  ${color.cyan(file.name)}   ${color.dim(`${Buffer.byteLength(file.contents)} bytes`)}`,
  );
  return section(header, rows);
}

/** Banner + serve endpoints + (when a manifest was fetched) curl examples. */
function deployedBody(endpointUrls: string[], manifest: Manifest | undefined): string {
  const endpoints = section(color.bold("Serve endpoints"), endpointRows(endpointUrls));
  const banner = `\n\n${color.green("✓ deployed")}`;
  return banner + endpoints + curlSection(endpointUrls, manifest);
}

function endpointRows(endpointUrls: string[]): string[] {
  return endpointUrls.map((url) => `  ${color.dim(endpointLabel(url))} ${url}`);
}

function endpointLabel(url: string): string {
  if (url.includes("/node/")) {
    return "node";
  }
  if (url.includes("/function/")) {
    return "function";
  }
  if (url.endsWith("/list")) {
    return "manifest";
  }
  return "endpoint";
}

function curlSection(endpointUrls: string[], manifest: Manifest | undefined): string {
  const base = serveBaseUrl(endpointUrls);
  if (!base || !manifest) {
    return "";
  }
  const header = `${color.bold("Try it")}   ${color.dim("(export KEY=<your-api-key> first)")}`;
  const rows = curlExamples(base, manifest).flatMap((example) => [
    `  ${color.dim(example.label)}`,
    `    ${example.command}`,
  ]);
  return section(header, rows);
}

/** A titled block with a leading blank line, ready to concatenate. */
function section(header: string, rows: string[]): string {
  return "\n\n" + [header, ...rows].join("\n");
}

function redactKey(apiKey: string): string {
  return apiKey.length <= 4 ? "••••" : `••••${apiKey.slice(-4)}`;
}
