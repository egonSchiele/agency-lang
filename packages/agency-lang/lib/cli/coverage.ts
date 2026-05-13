import * as fs from "fs";
import * as path from "path";
import { AgencyConfig } from "../config.js";
import { compile } from "./commands.js";
import { RunStrategy } from "../importStrategy.js";

type CoverageData = Record<string, Record<string, true>>;
type SourceMap = Record<string, Record<string, { line: number; col: number }>>;

type FileCoverage = {
  file: string;
  totalSteps: number;
  coveredSteps: number;
  percentage: number;
  /** Keyed by 1-indexed line number for display. */
  lineStatus: Record<number, "covered" | "uncovered">;
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "traces",
  ".git",
  ".coverage",
  ".agency-tmp",
  ".worktrees",
  "test-frames",
  "test-output",
]);

function getCoverageOutDir(config: AgencyConfig): string {
  return config.coverage?.outDir ?? ".coverage";
}

export function cleanCoverage(config: AgencyConfig): void {
  const outDir = getCoverageOutDir(config);
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
    console.log(`Cleaned ${outDir}`);
  }
}

function loadCoverageData(outDir: string): CoverageData {
  if (!fs.existsSync(outDir)) return {};
  const merged: CoverageData = {};
  for (const file of fs.readdirSync(outDir)) {
    if (!file.startsWith("cov-") || !file.endsWith(".json")) continue;
    const data: CoverageData = JSON.parse(
      fs.readFileSync(path.join(outDir, file), "utf-8"),
    );
    for (const [scope, steps] of Object.entries(data)) {
      if (!merged[scope]) merged[scope] = {};
      for (const step of Object.keys(steps)) {
        merged[scope][step] = true;
      }
    }
  }
  return merged;
}

async function getSourceMap(
  config: AgencyConfig,
  agencyFile: string,
): Promise<SourceMap | null> {
  try {
    const compiled = compile(config, agencyFile, undefined, {
      importStrategy: new RunStrategy(),
    });
    if (!compiled) return null;
    const absPath = path.resolve(compiled);
    // Dynamically import the compiled module to read its __sourceMap export
    // safely (mirrors lib/cli/debug.ts). Cache-bust with a query string so
    // repeated calls during the same process pick up fresh compiles.
    const mod = await import(`${absPath}?t=${Date.now()}`);
    return (mod.__sourceMap ?? null) as SourceMap | null;
  } catch (err) {
    console.warn(`Could not load source map for ${agencyFile}: ${(err as Error).message}`);
    return null;
  }
}

function computeFileCoverage(
  file: string,
  sourceMap: SourceMap,
  hits: CoverageData,
): FileCoverage {
  let totalSteps = 0;
  let coveredSteps = 0;
  const lineStatus: Record<number, "covered" | "uncovered"> = {};

  for (const [scope, steps] of Object.entries(sourceMap)) {
    for (const [stepPath, loc] of Object.entries(steps)) {
      totalSteps++;
      // loc.line is 0-indexed (see docs/dev/locations.md). Convert to
      // 1-indexed for display.
      const displayLine = loc.line + 1;
      const isHit = hits[scope]?.[stepPath] === true;
      if (isHit) {
        coveredSteps++;
        // covered wins over uncovered when multiple steps share a line
        lineStatus[displayLine] = "covered";
      } else if (!lineStatus[displayLine]) {
        lineStatus[displayLine] = "uncovered";
      }
    }
  }

  return {
    file,
    totalSteps,
    coveredSteps,
    percentage: totalSteps === 0 ? 100 : (coveredSteps / totalSteps) * 100,
    lineStatus,
  };
}

export async function generateReport(
  config: AgencyConfig,
  targetDir?: string,
  opts?: { detail?: boolean; html?: boolean },
): Promise<void> {
  const outDir = getCoverageOutDir(config);
  const hits = loadCoverageData(outDir);

  if (Object.keys(hits).length === 0) {
    console.log("No coverage data found. Run tests with AGENCY_COVERAGE=1 first.");
    return;
  }

  const searchDir = targetDir ?? "stdlib";
  const agencyFiles = findAgencyFiles(searchDir);

  const results: FileCoverage[] = [];
  for (const file of agencyFiles) {
    const sourceMap = await getSourceMap(config, file);
    if (!sourceMap) {
      console.warn(`Warning: could not compile ${file}, skipping`);
      continue;
    }
    results.push(computeFileCoverage(file, sourceMap, hits));
  }

  // Sort by coverage (lowest first)
  results.sort((a, b) => a.percentage - b.percentage);

  if (opts?.html) {
    generateHtmlReport(config, results);
  }

  if (opts?.detail) {
    printDetailReport(results);
  } else {
    printSummaryReport(results);
  }
}

function printSummaryReport(results: FileCoverage[]): void {
  console.log("\nAgency Coverage Report");
  console.log("======================");

  let totalSteps = 0;
  let totalCovered = 0;

  for (const r of results) {
    const pct = r.percentage.toFixed(1).padStart(5);
    const counts = `(${r.coveredSteps}/${r.totalSteps} steps)`;
    console.log(`${r.file.padEnd(40)} ${pct}%  ${counts}`);
    totalSteps += r.totalSteps;
    totalCovered += r.coveredSteps;
  }

  const totalPct = totalSteps === 0 ? 100 : (totalCovered / totalSteps) * 100;
  console.log("─".repeat(60));
  console.log(
    `${"Total".padEnd(40)} ${totalPct.toFixed(1).padStart(5)}%  (${totalCovered}/${totalSteps} steps)`,
  );
}

function printDetailReport(results: FileCoverage[]): void {
  for (const r of results) {
    const source = fs.readFileSync(r.file, "utf-8");
    const lines = source.split("\n");
    console.log(`\n── ${r.file} (${r.percentage.toFixed(1)}%) ──\n`);
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const status = r.lineStatus[lineNum];
      let prefix: string;
      if (status === "covered") prefix = " ✓ ";
      else if (status === "uncovered") prefix = " ✗ ";
      else prefix = "   ";
      console.log(`${prefix}${String(lineNum).padStart(4)}| ${lines[i]}`);
    }
  }
}

function generateHtmlReport(
  config: AgencyConfig,
  results: FileCoverage[],
): void {
  const outDir = getCoverageOutDir(config);
  const reportDir = path.join(outDir, "report");
  fs.mkdirSync(reportDir, { recursive: true });

  let totalSteps = 0;
  let totalCovered = 0;
  for (const r of results) {
    totalSteps += r.totalSteps;
    totalCovered += r.coveredSteps;
  }
  const totalPct = totalSteps === 0 ? 100 : (totalCovered / totalSteps) * 100;

  const fileSections = results.map((r) => {
    const source = fs.readFileSync(r.file, "utf-8");
    const lines = source.split("\n");
    const annotatedLines = lines.map((line, i) => {
      const lineNum = i + 1;
      const status = r.lineStatus[lineNum] ?? "neutral";
      return { lineNum, text: escapeHtml(line), status };
    });
    return {
      file: r.file,
      percentage: r.percentage.toFixed(1),
      coveredSteps: r.coveredSteps,
      totalSteps: r.totalSteps,
      lines: annotatedLines,
    };
  });

  const html = renderCoverageHtml({
    totalPercentage: totalPct.toFixed(1),
    totalCovered,
    totalSteps,
    files: fileSections,
  });

  const outPath = path.join(reportDir, "index.html");
  fs.writeFileSync(outPath, html);
  console.log(`HTML report written to ${outPath}`);
}

function renderCoverageHtml(data: {
  totalPercentage: string;
  totalCovered: number;
  totalSteps: number;
  files: {
    file: string;
    percentage: string;
    coveredSteps: number;
    totalSteps: number;
    lines: { lineNum: number; text: string; status: string }[];
  }[];
}): string {
  const fileRows = data.files
    .map(
      (f) => `
    <tr>
      <td><a href="#${cssId(f.file)}">${escapeHtml(f.file)}</a></td>
      <td>${f.percentage}%</td>
      <td>${f.coveredSteps}/${f.totalSteps}</td>
      <td><div class="bar"><div class="bar-fill" style="width:${f.percentage}%"></div></div></td>
    </tr>`,
    )
    .join("\n");

  const fileSections = data.files
    .map(
      (f) => `
    <div id="${cssId(f.file)}" class="file-section">
      <h2>${escapeHtml(f.file)} <span class="pct">${f.percentage}%</span></h2>
      <pre>${f.lines.map((l) => `<span class="line ${l.status}"><span class="ln">${String(l.lineNum).padStart(4)}</span> ${l.text}</span>`).join("\n")}</pre>
    </div>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Agency Coverage Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 2em; background: #1a1a2e; color: #e0e0e0; }
  h1 { color: #fff; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2em; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
  th { color: #888; }
  a { color: #7aa2f7; }
  .bar { background: #333; height: 16px; border-radius: 3px; width: 200px; }
  .bar-fill { background: #9ece6a; height: 100%; border-radius: 3px; }
  .file-section { margin-bottom: 3em; }
  .pct { color: #888; font-size: 0.8em; }
  pre { background: #16161e; padding: 1em; border-radius: 6px; overflow-x: auto; line-height: 1.5; }
  .line { display: block; }
  .ln { color: #555; margin-right: 1em; user-select: none; }
  .covered { background: rgba(158, 206, 106, 0.1); }
  .uncovered { background: rgba(247, 118, 142, 0.15); }
  .neutral { }
</style>
</head>
<body>
<h1>Agency Coverage Report</h1>
<p>Total: ${data.totalPercentage}% (${data.totalCovered}/${data.totalSteps} steps)</p>
<table>
  <tr><th>File</th><th>Coverage</th><th>Steps</th><th></th></tr>
  ${fileRows}
</table>
${fileSections}
</body>
</html>`;
}

function cssId(file: string): string {
  return file.replace(/[^a-zA-Z0-9]/g, "-");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findAgencyFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile() && dir.endsWith(".agency")) return [dir];
  if (!stat.isDirectory()) return results;
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    // Skip any other dot-prefixed entries (e.g., .git internals, .vscode).
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const s = fs.statSync(full);
    if (s.isDirectory()) {
      results.push(...findAgencyFiles(full));
    } else if (entry.endsWith(".agency")) {
      results.push(full);
    }
  }
  return results;
}
