// Successful terminal output for the remote commands: the endpoint listing, a
// call result, and the link status. Owns formatting so the command recipes
// don't; all colour goes through termcolors.

import { color } from "@/utils/termcolors.js";
import type { ServeManifest } from "../statelog/serveClient.js";
import type { TraceSummary, HostedAgentInfo } from "../statelog/projectClient.js";
import type { RemoteBinding } from "./binding.js";
import type { ProjectSummary, KeySummary, CreatedKey } from "../statelog/accountClient.js";
import type {
  ProjectSpend,
  AccountSpendRow,
  CostBreakdown,
  TokenBreakdown,
  ModelKindSpend,
  UsageKind,
} from "../statelog/spendTypes.js";

const NONE = "—";

export function renderManifest(manifest: ServeManifest, binding: RemoteBinding): string {
  const lines: string[] = [
    color.bold(binding.filename) + color.dim(` — ${binding.serveUrl}`),
    "",
    color.bold("Nodes"),
  ];
  for (const node of manifest.nodes) {
    lines.push(
      `  ${color.cyan(node.name)}(${node.parameters.join(", ")})${effectsSuffix(node.interruptEffects)}`,
    );
  }
  lines.push("", color.bold("Functions"));
  for (const fn of manifest.functions) {
    lines.push(
      `  ${color.cyan(fn.name)}(${fn.parameters.join(", ")})${effectsSuffix(fn.interruptEffects)}`,
    );
    if (fn.description) {
      lines.push(`    ${color.dim(fn.description)}`);
    }
  }
  return lines.join("\n");
}

/** The deployed files (`remote ls`): one row per file, the entry point marked,
 *  each file's exported nodes, and when it was last uploaded. */
export function renderHostedFiles(info: HostedAgentInfo): string {
  const lines: string[] = [color.bold("Files")];
  if (info.files.length === 0) {
    lines.push(color.dim("  No files deployed."));
    return lines.join("\n");
  }
  const rows = info.files.map((file) => [
    file.name + (file.name === info.entryPoint ? " (entry point)" : ""),
    file.nodeNames.length ? file.nodeNames.join(", ") : NONE,
    file.updatedAt,
  ]);
  lines.push(indent(formatStaticTable(["FILE", "NODES", "UPDATED"], rows), "  "));
  if (info.lastUploadAt) {
    lines.push(color.dim(`  Last upload: ${info.lastUploadAt}`));
  }
  return lines.join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
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
  return [`${color.bold("User:")} ${userId}`, `${color.bold("Host:")} ${color.dim(origin)}`].join(
    "\n",
  );
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

/** A count with thousands separators, in a fixed locale for deterministic
 *  output. Accepts `bigint` so aggregate totals can be summed without crossing
 *  `Number.MAX_SAFE_INTEGER`. */
function formatCount(count: number | bigint): string {
  return count.toLocaleString("en-US");
}

/** A sub-$0.0001 dollar amount rendered with enough precision that a positive
 *  value never collapses to `$0.0000`. Trailing zeros are trimmed; a value below
 *  the fixed 8-decimal resolution falls back to scientific notation (e.g.
 *  `$1e-10`) rather than rounding a known positive spend to zero. */
function formatTinyUsd(amount: number): string {
  const fixed = amount.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  if (Number(fixed) === 0) {
    return `$${amount.toExponential()}`;
  }
  return `$${fixed}`;
}

/** Prefix `≥` when the figure is a trusted lower bound (telemetry incomplete).
 *  A lower bound never uses the `<$0.0001` sentinel — `≥ <$0.0001` ("at least
 *  less than") is incoherent — but it must not floor a positive amount to
 *  `≥ $0.0000` either (that hides a known positive spend), so a sub-$0.0001
 *  lower bound keeps extra precision (e.g. `≥ $0.00004`). */
function lowerBound(amount: number, complete: boolean): string {
  if (complete) {
    return formatUsd(amount);
  }
  if (amount > 0 && amount < 0.0001) {
    return `≥ ${formatTinyUsd(amount)}`;
  }
  return `≥ ${formatUsd(amount)}`;
}

/** A count that keeps a lower-bound `≥` prefix when the figure is not trusted
 *  complete (telemetry incomplete or price unknown). */
function lowerBoundCount(count: number | bigint, complete: boolean): string {
  return complete ? formatCount(count) : `≥ ${formatCount(count)}`;
}

/** A project's figures are only a trusted exact total when BOTH the telemetry
 *  arrived complete AND every call was priced. Either false makes it a lower
 *  bound (the `≥` marker). */
function spendIsComplete(spend: { usageComplete: boolean; pricingComplete: boolean }): boolean {
  return spend.usageComplete && spend.pricingComplete;
}

/** Human label for a breakdown model — the manual sentinel `""` reads as
 *  `(manual)`. */
function modelLabel(model: string): string {
  return model === "" ? "(manual)" : model;
}

/** The authoritative cost-component and token-component detail lines under a
 *  total. Components are best-effort detail; the totals above carry the `≥`. */
function costComponentLines(cost: CostBreakdown): string[] {
  return [
    `    input         ${formatUsd(cost.inputCost)}`,
    `    output        ${formatUsd(cost.outputCost)}`,
    `    cached in     ${formatUsd(cost.cachedInputCost)}`,
    `    cache write   ${formatUsd(cost.cacheCreationInputCost)}`,
    `    hosted tools  ${formatUsd(cost.hostedToolsCost)}`,
  ];
}
function tokenComponentLines(tokens: TokenBreakdown): string[] {
  return [
    `    input         ${formatCount(tokens.inputTokens)}`,
    `    output        ${formatCount(tokens.outputTokens)}`,
    `    cached in     ${formatCount(tokens.cachedInputTokens)}`,
    `    cache write   ${formatCount(tokens.cacheCreationInputTokens)}`,
  ];
}

export type SpendGrouping = { byModel: boolean; byKind: boolean };

// Token counters accumulate as bigint: a grouping can collapse many individually
// safe breakdown rows, and the sum can cross Number.MAX_SAFE_INTEGER. Cost is a
// float total (money, not an integer count), so it stays a number.
type SpendGroup = {
  model: string | null;
  kind: UsageKind | null;
  totalCost: number;
  inputTokens: bigint;
  outputTokens: bigint;
};

/** Fold the raw `(model, kind)` breakdown into the requested grouping. Both
 *  flags → one group per pair; one flag → collapse the other axis; the caller
 *  only reaches here when at least one flag is set. Sorted by total cost
 *  descending, then model then kind ascending. */
function groupBreakdown(rows: ModelKindSpend[], grouping: SpendGrouping): SpendGroup[] {
  const groups: Record<string, SpendGroup> = Object.create(null);
  for (const row of rows) {
    const model = grouping.byModel ? row.model : null;
    const kind = grouping.byKind ? row.kind : null;
    const key = JSON.stringify([model, kind]);
    let group = groups[key];
    if (group === undefined) {
      group = { model, kind, totalCost: 0, inputTokens: 0n, outputTokens: 0n };
      groups[key] = group;
    }
    group.totalCost += row.cost.totalCost;
    group.inputTokens += BigInt(row.tokens.inputTokens);
    group.outputTokens += BigInt(row.tokens.outputTokens);
  }
  return Object.values(groups).sort((left, right) => {
    if (right.totalCost !== left.totalCost) {
      return right.totalCost - left.totalCost;
    }
    const modelCmp = (left.model ?? "").localeCompare(right.model ?? "");
    if (modelCmp !== 0) {
      return modelCmp;
    }
    return (left.kind ?? "").localeCompare(right.kind ?? "");
  });
}

function renderGroupTable(groups: SpendGroup[], grouping: SpendGrouping): string {
  const headers: string[] = [];
  if (grouping.byModel) headers.push("MODEL");
  if (grouping.byKind) headers.push("KIND");
  headers.push("COST", "↑IN", "↓OUT");
  const tableRows = groups.map((group) => {
    const cells: string[] = [];
    if (grouping.byModel) cells.push(modelLabel(group.model ?? ""));
    if (grouping.byKind) cells.push(group.kind ?? "");
    cells.push(
      formatUsd(group.totalCost),
      formatCount(group.inputTokens),
      formatCount(group.outputTokens),
    );
    return cells;
  });
  return formatStaticTable(headers, tableRows);
}

export function renderProjectSpend(
  slug: string,
  spend: ProjectSpend,
  description: string,
  grouping: SpendGrouping,
): string {
  if (spend.invocationCount === 0) {
    return `No spend in ${description}.`;
  }
  const complete = spendIsComplete(spend);
  const lines = [
    `${color.bold("Spend:")} ${slug}  ${color.dim(`(${description})`)}`,
    `  ${color.bold("Cost:")}         ${lowerBound(spend.cost.totalCost, complete)}`,
    ...costComponentLines(spend.cost),
    `  ${color.bold("Tokens:")}       ${lowerBoundCount(spend.tokens.totalTokens, complete)} total`,
    ...tokenComponentLines(spend.tokens),
    `  ${color.bold("Invocations:")}  ${formatCount(spend.invocationCount)}`,
  ];
  if (grouping.byModel || grouping.byKind) {
    lines.push("", renderGroupTable(groupBreakdown(spend.breakdown, grouping), grouping));
    if (spend.breakdownTruncated) {
      // The host caps the breakdown to its top spenders; the rest is summed into
      // `otherSpend` (the grouped rows above therefore omit it).
      lines.push(
        color.dim(
          `  top ${formatCount(spend.breakdown.length)} (model, kind) shown; ${formatUsd(spend.otherSpend.cost.totalCost)} more across other groups`,
        ),
      );
    }
  }
  lines.push(...trustNotes(spend, "  "));
  return lines.join("\n");
}

/** The separate telemetry-incomplete and unknown-price notes. Independent axes:
 *  a run can be complete-but-unpriced, or priced-but-incomplete, or both. */
function trustNotes(
  spend: { usageComplete: boolean; unpricedCallCount: number },
  indent: string,
): string[] {
  const notes: string[] = [];
  if (!spend.usageComplete) {
    notes.push(color.dim(`${indent}(lower bound — some telemetry incomplete)`));
  }
  if (spend.unpricedCallCount > 0) {
    notes.push(
      color.dim(
        `${indent}${formatCount(spend.unpricedCallCount)} unpriced call(s) — cost may be understated`,
      ),
    );
  }
  return notes;
}

type SpendTotals = {
  totalCost: number;
  // Counters accumulate as bigint: each row's value is a safe integer, but a sum
  // across many projects can cross Number.MAX_SAFE_INTEGER and silently round.
  inputTokens: bigint;
  outputTokens: bigint;
  invocationCount: bigint;
  unpricedCallCount: bigint;
  usageComplete: boolean;
  pricingComplete: boolean;
};

function spendTotals(rows: AccountSpendRow[]): SpendTotals {
  return rows.reduce<SpendTotals>(
    (totals, row) => ({
      totalCost: totals.totalCost + row.spend.cost.totalCost,
      inputTokens: totals.inputTokens + BigInt(row.spend.tokens.inputTokens),
      outputTokens: totals.outputTokens + BigInt(row.spend.tokens.outputTokens),
      invocationCount: totals.invocationCount + BigInt(row.spend.invocationCount),
      unpricedCallCount: totals.unpricedCallCount + BigInt(row.spend.unpricedCallCount),
      usageComplete: totals.usageComplete && row.spend.usageComplete,
      pricingComplete: totals.pricingComplete && row.spend.pricingComplete,
    }),
    {
      totalCost: 0,
      inputTokens: 0n,
      outputTokens: 0n,
      invocationCount: 0n,
      unpricedCallCount: 0n,
      usageComplete: true,
      pricingComplete: true,
    },
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
    if (right.spend.cost.totalCost !== left.spend.cost.totalCost) {
      return right.spend.cost.totalCost - left.spend.cost.totalCost;
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
    lowerBound(row.spend.cost.totalCost, spendIsComplete(row.spend)),
    // Token counts are a lower bound whenever telemetry is incomplete — that is
    // `usageComplete` alone (unpriced calls affect cost, not counts).
    lowerBoundCount(row.spend.tokens.inputTokens, row.spend.usageComplete),
    lowerBoundCount(row.spend.tokens.outputTokens, row.spend.usageComplete),
    formatCount(row.spend.invocationCount),
    formatCount(row.spend.unpricedCallCount),
  ]);
  const totals = spendTotals(rows);
  tableRows.push([
    "TOTAL",
    lowerBound(totals.totalCost, totals.usageComplete && totals.pricingComplete),
    lowerBoundCount(totals.inputTokens, totals.usageComplete),
    lowerBoundCount(totals.outputTokens, totals.usageComplete),
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
  if (totals.unpricedCallCount > 0n) {
    lines.push(
      color.dim(
        `${formatCount(totals.unpricedCallCount)} unpriced call(s) total — cost may be understated.`,
      ),
    );
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
      row
        .map((value, index) => value.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
