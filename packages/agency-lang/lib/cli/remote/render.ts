// Successful terminal output for the remote commands: the endpoint listing, a
// call result, and the link status. Owns formatting so the command recipes
// don't; all colour goes through termcolors.

import { color } from "@/utils/termcolors.js";
import type { ServeManifest } from "../statelog/serveClient.js";
import type { TraceSummary } from "../statelog/projectClient.js";
import type { RemoteBinding } from "./binding.js";
import type {
  ProjectSummary,
  KeySummary,
  CreatedKey,
} from "../statelog/accountClient.js";
import type { ProjectSpend, AccountSpendRow } from "../statelog/spendTypes.js";

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

/** A dollar amount that never renders a positive spend as `$0.0000` — a sub-cent
 *  hosted cost must stay visible. */
function formatUsd(amount: number): string {
  if (amount === 0) {
    return "$0.0000";
  }
  if (amount < 0.0001) {
    return "<$0.0001";
  }
  return `$${amount.toFixed(4)}`;
}

/** A count with thousands separators, in a fixed locale for deterministic output. */
function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** Prefix `≥` when the figure is a trusted lower bound (telemetry incomplete).
 *  A lower bound never uses the `<$0.0001` sentinel — `≥ <$0.0001` ("at least
 *  less than") is incoherent — so a sub-$0.0001 lower bound floors to
 *  `≥ $0.0000` (still true: the total is at least ~zero and may be higher). */
function lowerBound(amount: number, complete: boolean): string {
  if (complete) {
    return formatUsd(amount);
  }
  if (amount > 0 && amount < 0.0001) {
    return "≥ $0.0000";
  }
  return `≥ ${formatUsd(amount)}`;
}

export function renderProjectSpend(slug: string, spend: ProjectSpend, description: string): string {
  const lines = [
    `${color.bold("Spend:")} ${slug}  ${color.dim(`(${description})`)}`,
    `  ${color.bold("Cost:")}         ${lowerBound(spend.pricedCost, spend.usageComplete)}`,
    `  ${color.bold("Tokens:")}       ↑ ${formatCount(spend.inputTokens)}  ↓ ${formatCount(spend.outputTokens)}`,
    `  ${color.bold("Invocations:")}  ${formatCount(spend.invocationCount)}`,
  ];
  if (!spend.usageComplete) {
    lines.push(color.dim("  (lower bound — some telemetry incomplete)"));
  }
  if (spend.unpricedCallCount > 0) {
    lines.push(color.dim(`  ${formatCount(spend.unpricedCallCount)} unpriced call(s) — cost may be understated`));
  }
  return lines.join("\n");
}

type SpendTotals = {
  pricedCost: number;
  inputTokens: number;
  outputTokens: number;
  invocationCount: number;
  unpricedCallCount: number;
  usageComplete: boolean;
};

function spendTotals(rows: AccountSpendRow[]): SpendTotals {
  return rows.reduce<SpendTotals>(
    (totals, row) => ({
      pricedCost: totals.pricedCost + row.spend.pricedCost,
      inputTokens: totals.inputTokens + row.spend.inputTokens,
      outputTokens: totals.outputTokens + row.spend.outputTokens,
      invocationCount: totals.invocationCount + row.spend.invocationCount,
      unpricedCallCount: totals.unpricedCallCount + row.spend.unpricedCallCount,
      usageComplete: totals.usageComplete && row.spend.usageComplete,
    }),
    { pricedCost: 0, inputTokens: 0, outputTokens: 0, invocationCount: 0, unpricedCallCount: 0, usageComplete: true },
  );
}

/** Active projects first (by cost desc), then deleted ones (by cost desc), with
 *  the slug as a deterministic tie-break. */
function sortAccountRows(rows: AccountSpendRow[]): AccountSpendRow[] {
  return [...rows].sort((left, right) => {
    const leftDeleted = left.deletedAt !== null;
    const rightDeleted = right.deletedAt !== null;
    if (leftDeleted !== rightDeleted) {
      return leftDeleted ? 1 : -1;
    }
    if (right.spend.pricedCost !== left.spend.pricedCost) {
      return right.spend.pricedCost - left.spend.pricedCost;
    }
    if (left.projectSlug < right.projectSlug) {
      return -1;
    }
    if (left.projectSlug > right.projectSlug) {
      return 1;
    }
    return 0;
  });
}

export function renderAccountSpend(rows: AccountSpendRow[], description: string): string {
  if (rows.length === 0) {
    return color.dim("No projects yet.");
  }
  const sorted = sortAccountRows(rows);
  const tableRows = sorted.map((row) => [
    row.deletedAt === null ? row.projectSlug : `${row.projectSlug} (deleted)`,
    lowerBound(row.spend.pricedCost, row.spend.usageComplete),
    formatCount(row.spend.inputTokens),
    formatCount(row.spend.outputTokens),
    formatCount(row.spend.invocationCount),
    formatCount(row.spend.unpricedCallCount),
  ]);
  const totals = spendTotals(rows);
  tableRows.push([
    "TOTAL",
    lowerBound(totals.pricedCost, totals.usageComplete),
    formatCount(totals.inputTokens),
    formatCount(totals.outputTokens),
    formatCount(totals.invocationCount),
    formatCount(totals.unpricedCallCount),
  ]);
  const lines = [
    color.dim(`(${description})`),
    formatStaticTable(["PROJECT", "COST", "↑IN", "↓OUT", "INVOCATIONS", "UNPRICED"], tableRows),
  ];
  if (!totals.usageComplete) {
    lines.push(color.dim("Some projects have incomplete telemetry; totals are lower bounds."));
  }
  if (totals.unpricedCallCount > 0) {
    lines.push(color.dim(`${formatCount(totals.unpricedCallCount)} unpriced call(s) total — cost may be understated.`));
  }
  return lines.join("\n");
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
