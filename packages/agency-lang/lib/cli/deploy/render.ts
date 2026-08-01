// Turning a DeployOutcome into terminal output. Presentation only — it reads
// the typed outcome and prints; no deploy logic lives here.

import { color } from "@/utils/termcolors.js";
import type { DeployOutcome, DeployPlan } from "./deploy.js";
import { serveBaseUrl } from "./uploadClient.js";
import type { Manifest } from "./uploadClient.js";
import { curlExamples } from "./curlExamples.js";

export function renderOutcome(outcome: DeployOutcome): void {
  if (outcome.kind === "error") {
    console.error(`\n${color.red("✗")} ${outcome.error}\n`);
    return;
  }
  if (outcome.kind === "preview") {
    renderPlan(outcome.plan);
    console.log(`\n${color.yellow("dry run")} — nothing uploaded. Re-run without ${color.bold("--dry-run")} to deploy.\n`);
    return;
  }
  renderPlan(outcome.plan);
  renderEndpoints(outcome.endpointUrls, outcome.manifest);
}

function renderPlan(plan: DeployPlan): void {
  const { target, provenance, bundle } = plan;
  console.log(`\n${color.bold("Deploy target")}`);
  console.log(`  ${color.dim("host   ")} ${target.host}   ${color.dim(provenance.host)}`);
  console.log(`  ${color.dim("project")} ${target.projectId}   ${color.dim(provenance.projectId)}`);
  console.log(`  ${color.dim("api key")} ${redactKey(target.apiKey)}   ${color.dim(provenance.apiKey)}`);

  console.log(`\n${color.bold(`Files (${bundle.files.length})`)}   ${color.dim(`entrypoint: ${bundle.entrypoint}`)}`);
  for (const file of bundle.files) {
    console.log(`  ${color.cyan(file.name)}   ${color.dim(`${Buffer.byteLength(file.contents)} bytes`)}`);
  }
}

function renderEndpoints(endpointUrls: string[], manifest: Manifest | undefined): void {
  console.log(`\n${color.green("✓ deployed")}\n`);
  console.log(color.bold("Serve endpoints"));
  for (const url of endpointUrls) {
    const label = url.endsWith("/list") ? color.dim("manifest") : color.dim("node    ");
    console.log(`  ${label} ${url}`);
  }

  const base = serveBaseUrl(endpointUrls);
  if (!base || !manifest) {
    return;
  }
  console.log(`\n${color.bold("Try it")}   ${color.dim("(export KEY=<your-api-key> first)")}`);
  for (const example of curlExamples(base, manifest)) {
    console.log(`  ${color.dim(example.label)}`);
    console.log(`    ${example.command}`);
  }
  console.log();
}

function redactKey(apiKey: string): string {
  return apiKey.length <= 4 ? "••••" : `••••${apiKey.slice(-4)}`;
}
