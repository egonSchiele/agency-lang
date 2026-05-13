// Render a markdown coverage comment from `agency coverage report` output and
// post (or update) a sticky comment on the current pull request.
//
// This module is loaded by the local composite action
// `.github/actions/coverage-comment` via `actions/github-script`.
//
// Inputs come in as env vars (set by the composite action wrapper):
//   SUMMARY_PATH  required, path to plain-text summary file
//   DETAIL_PATH   optional, path to plain-text detail file
//   TITLE         optional, heading text
//   MARKER        required, hidden HTML marker for sticky-comment matching

"use strict";

const fs = require("fs");

/**
 * @param {{file: string, percentage: number, covered: number, total: number}[]} rows
 * @returns {{covered: number, total: number, percentage: number}}
 */
function computeTotals(rows) {
  let covered = 0;
  let total = 0;
  for (const r of rows) {
    covered += r.covered;
    total += r.total;
  }
  const percentage = total === 0 ? 100 : (covered / total) * 100;
  return { covered, total, percentage };
}

/**
 * Coverage band → emoji indicator. Mirrors the colour bands the CLI itself
 * uses (`colorPct` in lib/cli/coverage.ts): red < 50, yellow < 80, else green.
 */
function emojiFor(pct) {
  if (pct < 50) return "🔴";
  if (pct < 80) return "🟡";
  return "🟢";
}

/**
 * Parse the summary report. Each non-header line looks like:
 *   `<file>   <pct>%  (<covered>/<total> steps)`
 * with arbitrary whitespace between columns. The "Total" line uses the same
 * shape but with the literal "Total" as the file column.
 */
function parseSummary(text) {
  const rows = [];
  let total = null;
  const re =
    /^(.+?)\s+(\d+(?:\.\d+)?)%\s+\((\d+)\s*\/\s*(\d+)\s+steps\)\s*$/;
  for (const raw of text.split("\n")) {
    const m = raw.match(re);
    if (!m) continue;
    const [, file, pctStr, coveredStr, totalStr] = m;
    const row = {
      file: file.trim(),
      percentage: parseFloat(pctStr),
      covered: parseInt(coveredStr, 10),
      total: parseInt(totalStr, 10),
    };
    if (row.file === "Total") {
      total = row;
    } else {
      rows.push(row);
    }
  }
  return { rows, total };
}

/**
 * Parse the detail report. Lines look like:
 *   `<file>   <pct>%  (<covered>/<total>)  uncovered: 2-4, 8-9`
 * (the `uncovered:` segment is absent for fully-covered files).
 */
function parseDetail(text) {
  const out = {};
  const re =
    /^(.+?)\s+\d+(?:\.\d+)?%\s+\(\d+\s*\/\s*\d+\)\s*(?:uncovered:\s*(.+))?\s*$/;
  for (const raw of text.split("\n")) {
    const m = raw.match(re);
    if (!m) continue;
    const file = m[1].trim();
    if (file === "Total") continue;
    out[file] = (m[2] ?? "").trim();
  }
  return out;
}

function renderSummaryTable(rows, total) {
  const header =
    "| File | Coverage | Steps |\n|------|---------:|------:|";
  const body = rows
    .map(
      (r) =>
        `| ${emojiFor(r.percentage)} \`${r.file}\` | ${r.percentage.toFixed(1)}% | ${r.covered}/${r.total} |`,
    )
    .join("\n");
  const totalRow = total
    ? `\n| **Total** | **${total.percentage.toFixed(1)}%** | **${total.covered}/${total.total}** |`
    : "";
  return `${header}\n${body}${totalRow}`;
}

function renderDetailTable(rows, uncoveredByFile) {
  const header =
    "| File | Coverage | Uncovered lines |\n|------|---------:|-----------------|";
  const body = rows
    .map((r) => {
      const ranges = uncoveredByFile[r.file];
      const cell = ranges && ranges.length > 0 ? `\`${ranges}\`` : "—";
      return `| ${emojiFor(r.percentage)} \`${r.file}\` | ${r.percentage.toFixed(1)}% | ${cell} |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

function renderBody({ title, marker, summaryRows, summaryTotal, detailMap, runId }) {
  const totals = summaryTotal ?? computeTotals(summaryRows);
  // Sort lowest-coverage first so the worst files surface at the top of the
  // table — matches `printSummaryReport` in the CLI.
  const sorted = [...summaryRows].sort((a, b) => a.percentage - b.percentage);

  const headerLine = `${emojiFor(totals.percentage)} **${totals.percentage.toFixed(1)}%** &nbsp; (${totals.covered} / ${totals.total} steps)`;

  const summarySection = `<details open><summary><strong>Per-file coverage</strong></summary>

${renderSummaryTable(sorted, summaryTotal)}

</details>`;

  const detailSection =
    detailMap === null
      ? ""
      : `

<details><summary><strong>Per-file uncovered ranges</strong></summary>

${renderDetailTable(sorted, detailMap)}

</details>`;

  const runRef = runId ? `\n\n<sub>Run [#${runId}](../actions/runs/${runId}).</sub>` : "";

  return `${marker}
## ${title}

${headerLine}

${summarySection}${detailSection}${runRef}
`;
}

async function postOrUpdate({ github, context, body, marker }) {
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;
  if (!issue_number) {
    // Not a PR context — log and skip silently so the action remains safe to
    // call from `push` workflows too.
    console.log("[coverage-comment] no PR context; skipping comment.");
    return;
  }
  const { data: comments } = await github.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body && c.body.includes(marker));
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    console.log(`[coverage-comment] updated comment ${existing.id}`);
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    });
    console.log("[coverage-comment] created new comment");
  }
}

module.exports = async function render({ github, context, core }) {
  const summaryPath = process.env.SUMMARY_PATH;
  const detailPath = process.env.DETAIL_PATH;
  const title = process.env.TITLE || "Coverage";
  const marker = process.env.MARKER;
  if (!summaryPath || !marker) {
    core.setFailed("SUMMARY_PATH and MARKER inputs are required");
    return;
  }

  const summaryText = fs.readFileSync(summaryPath, "utf8");
  const { rows: summaryRows, total: summaryTotal } = parseSummary(summaryText);
  if (summaryRows.length === 0) {
    core.warning(
      `[coverage-comment] no coverage rows parsed from ${summaryPath}; skipping comment.`,
    );
    return;
  }

  let detailMap = null;
  if (detailPath && fs.existsSync(detailPath)) {
    detailMap = parseDetail(fs.readFileSync(detailPath, "utf8"));
  }

  const body = renderBody({
    title,
    marker,
    summaryRows,
    summaryTotal,
    detailMap,
    runId: context.runId,
  });

  await postOrUpdate({ github, context, body, marker });
};

// Exported for unit-style testing (`node render.test.js` or similar).
module.exports.parseSummary = parseSummary;
module.exports.parseDetail = parseDetail;
module.exports.renderBody = renderBody;
