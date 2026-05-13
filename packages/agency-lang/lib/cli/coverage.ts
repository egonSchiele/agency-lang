import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import picomatch from "picomatch";
import { AgencyConfig } from "../config.js";
import { compile } from "./commands.js";
import { RunStrategy } from "../importStrategy.js";
import { ttyColor } from "../utils/termcolors.js";
import renderCoverageHtml from "../templates/cli/coverageReport.js";

type CoverageData = Record<string, Record<string, true>>;
type SourceMap = Record<string, Record<string, { line: number; col: number }>>;

type FileCoverage = {
  file: string;
  totalSteps: number;
  coveredSteps: number;
  percentage: number;
  /** Keyed by 1-indexed line number for display. */
  lineStatus: Record<number, "covered" | "uncovered">;
  /** 1-indexed line ranges of uncovered steps, e.g. [[14, 15], [22, 22]]. */
  uncoveredRanges: [number, number][];
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
    const fullPath = path.join(outDir, file);
    let data: CoverageData;
    try {
      data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch (err) {
      // A subprocess killed mid-write can leave a corrupt file; skip with a
      // warning so a single bad file does not tank the whole report.
      console.warn(
        `[coverage] skipping invalid coverage file ${file}: ${(err as Error).message}`,
      );
      continue;
    }
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
    // Dynamically import the compiled module to read its `__sourceMap` export
    // (mirrors lib/cli/debug.ts). pathToFileURL handles platform-specific
    // file URL formatting; the cache-busting query forces a fresh import on
    // repeated calls within the same process.
    const fileUrl = pathToFileURL(absPath).href;
    // eslint-disable-next-line no-restricted-syntax
    const mod = await import(`${fileUrl}?t=${Date.now()}`);
    return (mod.__sourceMap ?? null) as SourceMap | null;
  } catch (err) {
    console.warn(`Could not load source map for ${agencyFile}: ${(err as Error).message}`);
    return null;
  }
}

function computeUncoveredRanges(
  lineStatus: Record<number, "covered" | "uncovered">,
): [number, number][] {
  const uncoveredLines = Object.entries(lineStatus)
    .filter(([, status]) => status === "uncovered")
    .map(([line]) => Number(line))
    .sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const line of uncoveredLines) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }
  return ranges;
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
    uncoveredRanges: computeUncoveredRanges(lineStatus),
  };
}

export type GenerateReportOptions = {
  detail?: boolean;
  html?: boolean;
  /**
   * Override `coverage.threshold` from config. Total coverage % below this
   * value causes generateReport to return `passed: false`.
   */
  threshold?: number;
  /**
   * Override `coverage.perFileThreshold` from config. Any file below this
   * value causes generateReport to return `passed: false`.
   */
  perFileThreshold?: number;
};

export type GenerateReportResult = {
  /** False when any configured threshold was not met. */
  passed: boolean;
  /** Files that fell below the per-file threshold (if any). */
  failingFiles: string[];
  /** Total coverage percentage across all reported files. */
  totalPercentage: number;
};

export async function generateReport(
  config: AgencyConfig,
  target: string | string[],
  opts?: GenerateReportOptions,
): Promise<GenerateReportResult> {
  const outDir = getCoverageOutDir(config);
  const hits = loadCoverageData(outDir);

  if (Object.keys(hits).length === 0) {
    console.log("No coverage data found. Run tests with --coverage first.");
    return { passed: true, failingFiles: [], totalPercentage: 0 };
  }

  const targets = Array.isArray(target) ? target : [target];
  const exclude = config.coverage?.exclude ?? [];
  const isExcluded = makeExcludeMatcher(exclude);
  const agencyFiles = Array.from(
    new Set(targets.flatMap(findAgencyFiles)),
  ).filter((f) => !isExcluded(f));

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

  return checkThresholds(results, config, opts);
}

/**
 * Build a predicate that returns true when a path matches any of the supplied
 * picomatch glob patterns. Both the absolute and the cwd-relative form of the
 * path are tested so users can write either style in `coverage.exclude`.
 */
function makeExcludeMatcher(patterns: string[]): (file: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map((p) => picomatch(p));
  return (file: string) => {
    const rel = path.relative(process.cwd(), file);
    return matchers.some((m) => m(file) || m(rel));
  };
}

function checkThresholds(
  results: FileCoverage[],
  config: AgencyConfig,
  opts: GenerateReportOptions | undefined,
): GenerateReportResult {
  let totalSteps = 0;
  let totalCovered = 0;
  for (const r of results) {
    totalSteps += r.totalSteps;
    totalCovered += r.coveredSteps;
  }
  const totalPercentage = totalSteps === 0 ? 100 : (totalCovered / totalSteps) * 100;

  const overall = opts?.threshold ?? config.coverage?.threshold;
  const perFile = opts?.perFileThreshold ?? config.coverage?.perFileThreshold;

  const failingFiles =
    perFile === undefined
      ? []
      : results.filter((r) => r.percentage < perFile).map((r) => r.file);
  const overallFails = overall !== undefined && totalPercentage < overall;
  const passed = !overallFails && failingFiles.length === 0;

  if (overall !== undefined || perFile !== undefined) {
    console.log("");
    if (overallFails) {
      console.log(
        ttyColor.red(
          `✗ Overall coverage ${totalPercentage.toFixed(1)}% is below threshold ${overall}%`,
        ),
      );
    }
    if (failingFiles.length > 0 && perFile !== undefined) {
      console.log(
        ttyColor.red(
          `✗ ${failingFiles.length} file(s) below per-file threshold ${perFile}%:`,
        ),
      );
      for (const f of failingFiles) console.log(ttyColor.red(`    ${f}`));
    }
    if (passed) {
      console.log(ttyColor.green("✓ Coverage thresholds met"));
    }
  }

  return { passed, failingFiles, totalPercentage };
}

/** Color a percentage by coverage band: red <50, yellow <80, green ≥80. */
function colorPct(pct: number, text: string): string {
  if (pct < 50) return ttyColor.red(text);
  if (pct < 80) return ttyColor.yellow(text);
  return ttyColor.green(text);
}

function printSummaryReport(results: FileCoverage[]): void {
  console.log(ttyColor.bold("\nAgency Coverage Report"));
  console.log("======================");

  let totalSteps = 0;
  let totalCovered = 0;

  for (const r of results) {
    const pctStr = r.percentage.toFixed(1).padStart(5);
    const counts = `(${r.coveredSteps}/${r.totalSteps} steps)`;
    console.log(`${r.file.padEnd(40)} ${colorPct(r.percentage, pctStr + "%")}  ${ttyColor.dim(counts)}`);
    totalSteps += r.totalSteps;
    totalCovered += r.coveredSteps;
  }

  const totalPct = totalSteps === 0 ? 100 : (totalCovered / totalSteps) * 100;
  console.log("─".repeat(60));
  const totalStr = totalPct.toFixed(1).padStart(5);
  console.log(
    `${ttyColor.bold("Total".padEnd(40))} ${colorPct(totalPct, totalStr + "%")}  ${ttyColor.dim(`(${totalCovered}/${totalSteps} steps)`)}`,
  );
}

function formatRanges(ranges: [number, number][]): string {
  return ranges
    .map(([a, b]) => (a === b ? String(a) : `${a}-${b}`))
    .join(", ");
}

/**
 * Detail report: one line per file with its uncovered line ranges. Modeled
 * after how `c8` / `nyc` / `istanbul` summarize uncovered regions — full
 * annotated source dumps are reserved for the HTML report.
 */
function printDetailReport(results: FileCoverage[]): void {
  console.log(ttyColor.bold("\nAgency Coverage Report (detail)"));
  console.log("================================");
  for (const r of results) {
    const pctStr = r.percentage.toFixed(1).padStart(5);
    const counts = `(${r.coveredSteps}/${r.totalSteps})`;
    const header = `${r.file.padEnd(40)} ${colorPct(r.percentage, pctStr + "%")}  ${ttyColor.dim(counts)}`;
    if (r.uncoveredRanges.length === 0) {
      console.log(`${header}`);
    } else {
      console.log(`${header}  uncovered: ${ttyColor.red(formatRanges(r.uncoveredRanges))}`);
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

  const fileRowsHtml = results
    .map((r) => {
      const anchor = cssId(r.file);
      const pct = r.percentage.toFixed(1);
      return `  <tr>
    <td><a href="#${anchor}">${escapeHtml(r.file)}</a></td>
    <td>${pct}%</td>
    <td>${r.coveredSteps}/${r.totalSteps}</td>
    <td><div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div></td>
  </tr>`;
    })
    .join("\n");

  const fileSectionsHtml = results
    .map((r) => {
      const source = fs.readFileSync(r.file, "utf-8");
      const lines = source.split("\n");
      const linesHtml = lines
        .map((line, i) => {
          const lineNum = i + 1;
          const status = r.lineStatus[lineNum] ?? "neutral";
          return `<span class="line ${status}"><span class="ln">${String(lineNum).padStart(4)}</span> ${escapeHtml(line)}</span>`;
        })
        .join("\n");
      const anchor = cssId(r.file);
      const pct = r.percentage.toFixed(1);
      return `<div id="${anchor}" class="file-section">
  <h2>${escapeHtml(r.file)} <span class="pct">${pct}%</span></h2>
  <pre>${linesHtml}</pre>
</div>`;
    })
    .join("\n");

  const html = renderCoverageHtml({
    totalPercentage: totalPct.toFixed(1),
    totalCovered,
    totalSteps,
    fileRowsHtml,
    fileSectionsHtml,
  });

  const outPath = path.join(reportDir, "index.html");
  fs.writeFileSync(outPath, html);
  console.log(`HTML report written to ${outPath}`);
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
  // For convenience, accept a `.test.json` path and map it to its sibling
  // `.agency` file. Lets `agency test --coverage tests/agency/foo.test.json`
  // produce a useful auto-report.
  if (stat.isFile() && dir.endsWith(".test.json")) {
    const sibling = dir.replace(/\.test\.json$/, ".agency");
    return fs.existsSync(sibling) ? [sibling] : [];
  }
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
