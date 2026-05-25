# Agency Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a test coverage system that tracks which Agency source lines are exercised across all test types, with summary, detailed, and HTML reports.

**Architecture:** A `CoverageCollector` in the runtime records step hits (keyed by `moduleId:scopeName` → `stepPath`) via a single line added to each Runner step method. Enabled by `AGENCY_COVERAGE=1` env var. On process exit, writes a JSON file to `.coverage/`. The `agency coverage report` command reads these files, compares against `__sourceMap` exports from compiled modules, and generates reports.

**Tech Stack:** TypeScript, Commander CLI

**Spec:** `docs/superpowers/specs/2026-05-11-test-coverage-design.md`

---

## File Structure

### New files

```
lib/runtime/coverageCollector.ts            # CoverageCollector class
lib/runtime/coverageCollector.test.ts       # Unit tests
lib/cli/coverage.ts                         # Report generation + CLI logic (HTML inlined)
```

### Modified files

```
lib/runtime/runner.ts                       # Add collector.hit() to step methods
lib/runtime/state/context.ts                # Create collector when env var set
lib/runtime/index.ts                        # Export CoverageCollector
lib/config.ts                               # Add coverage.outDir to config
lib/cli/test.ts                             # Add --coverage and --accumulate flags
scripts/agency.ts                           # Add coverage subcommand
```

---

## Task 1: CoverageCollector class

**Files:**
- Create: `lib/runtime/coverageCollector.ts`
- Create: `lib/runtime/coverageCollector.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// lib/runtime/coverageCollector.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoverageCollector } from "./coverageCollector.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("CoverageCollector", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "agency-cov-test-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("records hits with correct structure", () => {
    const collector = new CoverageCollector();
    collector.hit("stdlib/fs.agency", "mkdir", "0");
    collector.hit("stdlib/fs.agency", "mkdir", "1");
    collector.hit("stdlib/fs.agency", "copy", "0");

    const hits = collector.getHits();
    expect(hits["stdlib/fs.agency:mkdir"]).toEqual({ "0": true, "1": true });
    expect(hits["stdlib/fs.agency:copy"]).toEqual({ "0": true });
  });

  it("deduplicates repeated hits", () => {
    const collector = new CoverageCollector();
    collector.hit("mod", "fn", "0");
    collector.hit("mod", "fn", "0");
    collector.hit("mod", "fn", "0");

    const hits = collector.getHits();
    expect(Object.keys(hits["mod:fn"])).toHaveLength(1);
  });

  it("writes JSON file to output directory", () => {
    const collector = new CoverageCollector();
    collector.hit("mod", "fn", "0");
    collector.write(outDir);

    const files = readdirSync(outDir).filter((f) => f.startsWith("cov-"));
    expect(files).toHaveLength(1);

    const data = JSON.parse(readFileSync(join(outDir, files[0]), "utf-8"));
    expect(data["mod:fn"]).toEqual({ "0": true });
  });

  it("generates unique filenames", () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    c1.hit("a", "b", "0");
    c2.hit("a", "b", "0");
    c1.write(outDir);
    c2.write(outDir);

    const files = readdirSync(outDir).filter((f) => f.startsWith("cov-"));
    expect(files).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/runtime/coverageCollector.test.ts 2>&1 | tee /tmp/cov-test-1.txt`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the implementation**

```typescript
// lib/runtime/coverageCollector.ts
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export class CoverageCollector {
  private hits: Record<string, Record<string, true>> = {};

  hit(moduleId: string, scopeName: string, stepPath: string): void {
    const scopeKey = `${moduleId}:${scopeName}`;
    if (!this.hits[scopeKey]) this.hits[scopeKey] = {};
    this.hits[scopeKey][stepPath] = true;
  }

  getHits(): Record<string, Record<string, true>> {
    return this.hits;
  }

  write(outDir: string): void {
    mkdirSync(outDir, { recursive: true });
    const filename = `cov-${process.pid}-${Date.now()}.json`;
    writeFileSync(join(outDir, filename), JSON.stringify(this.hits));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run -- lib/runtime/coverageCollector.test.ts 2>&1 | tee /tmp/cov-test-2.txt`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
git add lib/runtime/coverageCollector.ts lib/runtime/coverageCollector.test.ts
git commit -m "add CoverageCollector class"
```

---

## Task 2: Wire CoverageCollector into RuntimeContext

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Add coverageCollector property to RuntimeContext**

In `lib/runtime/state/context.ts`, add:

1. Import: `import { CoverageCollector } from "../coverageCollector.js";`
2. Add property to the class: `coverageCollector: CoverageCollector | null = null;`
3. In the constructor, after existing setup, add:

```typescript
if (process.env.AGENCY_COVERAGE) {
  this.coverageCollector = new CoverageCollector();
  // AGENCY_COVERAGE_OUTDIR is set by the CLI from agency.json config.
  // Default to .coverage if not set (e.g., when using the env var directly).
  const outDir = process.env.AGENCY_COVERAGE_OUTDIR ?? ".coverage";
  process.on("exit", () => {
    this.coverageCollector?.write(outDir);
  });
}
```

Note: `RuntimeContext`'s constructor does not have access to `AgencyConfig` (it's a runtime concept, config is a compiler concept). The coverage out dir is passed via the `AGENCY_COVERAGE_OUTDIR` env var, which the CLI sets from `agency.json`'s `coverage.outDir` when running with `--coverage`.

- [ ] **Step 2: Export CoverageCollector from runtime index**

In `lib/runtime/index.ts`, add:

```typescript
export { CoverageCollector } from "./coverageCollector.js";
```

- [ ] **Step 3: Build and verify**

Run: `pnpm run build 2>&1 | tee /tmp/cov-build-1.txt`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```
git add lib/runtime/state/context.ts lib/runtime/index.ts
git commit -m "wire CoverageCollector into RuntimeContext"
```

---

## Task 3: Instrument Runner step methods

**Files:**
- Modify: `lib/runtime/runner.ts`

Add a `collector.hit()` call to each step-like method, right after the skip checks pass (before the callback executes).

- [ ] **Step 1: Add hit call to each method**

The pattern is the same for each method. Add this line after the `shouldSkip()` and `getCounter() > id` checks pass, and after the `maybeDebugHook` call:

```typescript
this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));
```

Methods to instrument (add the line in each):

1. `step()` (~line 206, before `this.path.push(id)`)
2. `pipe()` (~line 237, before `const result =`)
3. `thread()` (~line 273, before `const threadKey =`)
4. `handle()` (~line 310, before `this.path.push(id)`)
5. `ifElse()` (~line 340, before `this.path.push(id)`)
6. `loop()` (~line 395, before `this.path.push(id)`)
7. `whileLoop()` (~line 450, before `this.path.push(id)`)
8. `branchStep()` (~line 505, before the callback)

Do NOT instrument `debugger()` or `fork()`.

- [ ] **Step 2: Build and run existing tests**

Run: `pnpm run build && pnpm test:run 2>&1 | tee /tmp/cov-build-2.txt`
Expected: Build and all existing tests pass (the `?.` means no impact when coverage disabled)

- [ ] **Step 3: Verify coverage data is produced**

Run a simple agency test with coverage enabled:

```bash
AGENCY_COVERAGE=1 pnpm run agency test tests/agency/binop.agency 2>&1 | tee /tmp/cov-verify.txt
ls .coverage/cov-*.json
```

Expected: At least one `cov-*.json` file exists in `.coverage/`

- [ ] **Step 4: Clean up and commit**

```bash
rm -rf .coverage
git add lib/runtime/runner.ts
git commit -m "instrument Runner step methods for coverage collection"
```

---

## Task 4: Add coverage config to AgencyConfig

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: Add coverage to AgencyConfig type**

In `lib/config.ts`, add to the `AgencyConfig` interface:

```typescript
coverage?: {
  outDir?: string;
};
```

- [ ] **Step 2: Add coverage to AgencyConfigSchema**

In the `AgencyConfigSchema` Zod object, add:

```typescript
coverage: z.object({ outDir: z.string() }).partial(),
```

- [ ] **Step 3: Add `.coverage` to `.gitignore`**

Add `.coverage` to the project's `.gitignore` file.

- [ ] **Step 4: Build and verify**

Run: `pnpm run build 2>&1 | tee /tmp/cov-build-3.txt`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```
git add lib/config.ts .gitignore
git commit -m "add coverage.outDir to AgencyConfig, gitignore .coverage"
```

---

## Task 5: Coverage report command (summary + detail)

**Files:**
- Create: `lib/cli/coverage.ts`

This is the core report generator. It reads coverage data, loads source maps, and produces text output.

- [ ] **Step 1: Create the coverage module**

```typescript
// lib/cli/coverage.ts
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
  lineStatus: Record<number, "covered" | "uncovered">;
};

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
      fs.readFileSync(path.join(outDir, file), "utf-8")
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

function getSourceMap(config: AgencyConfig, agencyFile: string): SourceMap | null {
  try {
    const compiled = compile(config, agencyFile, undefined, {
      importStrategy: new RunStrategy(),
    });
    if (!compiled) return null;
    // The compiled JS exports __sourceMap
    // We need to read it from the compiled file
    const content = fs.readFileSync(compiled, "utf-8");
    const match = content.match(/export const __sourceMap = ({.*?});/s);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function computeFileCoverage(
  file: string,
  sourceMap: SourceMap,
  hits: CoverageData,
  sourceContent: string,
): FileCoverage {
  let totalSteps = 0;
  let coveredSteps = 0;
  const lineStatus: Record<number, "covered" | "uncovered"> = {};

  for (const [scope, steps] of Object.entries(sourceMap)) {
    for (const [stepPath, loc] of Object.entries(steps)) {
      totalSteps++;
      const isHit = hits[scope]?.[stepPath] === true;
      if (isHit) {
        coveredSteps++;
        // Mark line as covered (covered wins over uncovered)
        if (lineStatus[loc.line] !== "covered") {
          lineStatus[loc.line] = "covered";
        }
      } else {
        // Only mark uncovered if not already covered
        if (!lineStatus[loc.line]) {
          lineStatus[loc.line] = "uncovered";
        }
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

export function generateReport(
  config: AgencyConfig,
  targetDir?: string,
  opts?: { detail?: boolean; html?: boolean },
): void {
  const outDir = getCoverageOutDir(config);
  const hits = loadCoverageData(outDir);

  if (Object.keys(hits).length === 0) {
    console.log("No coverage data found. Run tests with AGENCY_COVERAGE=1 first.");
    return;
  }

  // Find all .agency files in target
  const searchDir = targetDir ?? "stdlib";
  const agencyFiles = findAgencyFiles(searchDir);

  const results: FileCoverage[] = [];
  for (const file of agencyFiles) {
    const sourceMap = getSourceMap(config, file);
    if (!sourceMap) {
      console.warn(`Warning: could not compile ${file}, skipping`);
      continue;
    }
    const source = fs.readFileSync(file, "utf-8");
    results.push(computeFileCoverage(file, sourceMap, hits, source));
  }

  // Sort by coverage (lowest first)
  results.sort((a, b) => a.percentage - b.percentage);

  if (opts?.html) {
    generateHtmlReport(config, results, agencyFiles);
  }

  if (opts?.detail) {
    printDetailReport(results, agencyFiles);
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
    `${"Total".padEnd(40)} ${totalPct.toFixed(1).padStart(5)}%  (${totalCovered}/${totalSteps} steps)`
  );
}

function printDetailReport(results: FileCoverage[], agencyFiles: string[]): void {
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
  agencyFiles: string[],
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

  // Build file sections
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
  files: Array<{
    file: string;
    percentage: string;
    coveredSteps: number;
    totalSteps: number;
    lines: Array<{ lineNum: number; text: string; status: string }>;
  }>;
}): string {
  // Self-contained HTML with inline CSS
  const fileRows = data.files
    .map(
      (f) => `
    <tr>
      <td><a href="#${cssId(f.file)}">${f.file}</a></td>
      <td>${f.percentage}%</td>
      <td>${f.coveredSteps}/${f.totalSteps}</td>
      <td><div class="bar"><div class="bar-fill" style="width:${f.percentage}%"></div></div></td>
    </tr>`
    )
    .join("\n");

  const fileSections = data.files
    .map(
      (f) => `
    <div id="${cssId(f.file)}" class="file-section">
      <h2>${f.file} <span class="pct">${f.percentage}%</span></h2>
      <pre>${f.lines.map((l) => `<span class="line ${l.status}"><span class="ln">${String(l.lineNum).padStart(4)}</span> ${l.text}</span>`).join("\n")}</pre>
    </div>`
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
    if (entry === "node_modules" || entry === "dist") continue;
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
```

Note: I inlined the HTML generation rather than using typestache templates because the HTML is a single self-contained string with inline CSS. Adding two mustache templates plus recompiling templates (`pnpm run templates`) for what amounts to string concatenation would add complexity without benefit. The template data is just arrays and strings — no complex control flow.

- [ ] **Step 2: Build and verify**

Run: `pnpm run build 2>&1 | tee /tmp/cov-build-4.txt`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```
git add lib/cli/coverage.ts
git commit -m "add coverage report generator with summary, detail, and HTML output"
```

---

## Task 6: Add CLI commands

**Files:**
- Modify: `scripts/agency.ts`

- [ ] **Step 1: Add coverage subcommand**

In `scripts/agency.ts`, add the coverage commands. Find where other commands are defined (around line 280+) and add:

```typescript
import { generateReport, cleanCoverage } from "../lib/cli/coverage.js";

const coverageCmd = program
  .command("coverage")
  .description("View test coverage reports");

coverageCmd
  .command("report")
  .description("Generate coverage report from collected data")
  .argument("[target]", "Directory to report on (default: stdlib)")
  .option("--html", "Generate HTML report")
  .option("--detail", "Show annotated source")
  .action((target, opts) => {
    generateReport(config, target, { detail: opts.detail, html: opts.html });
  });

coverageCmd
  .command("clean")
  .description("Delete collected coverage data")
  .action(() => {
    cleanCoverage(config);
  });
```

- [ ] **Step 2: Build and verify commands work**

```bash
pnpm run build
pnpm run agency coverage report --help
pnpm run agency coverage clean --help
```

Expected: Both commands show help text.

- [ ] **Step 3: Commit**

```
git add scripts/agency.ts
git commit -m "add agency coverage report and agency coverage clean CLI commands"
```

---

## Task 7: Add --coverage and --accumulate flags to test command

**Files:**
- Modify: `lib/cli/test.ts`
- Modify: `scripts/agency.ts`

- [ ] **Step 1: Add flags to the test command in scripts/agency.ts**

Find the test command definition (~line 286) and add options:

```typescript
.option("--coverage", "Enable coverage collection and report")
.option("--accumulate", "Preserve existing coverage data (use with --coverage)")
```

- [ ] **Step 2: Implement coverage flag logic in the test action**

In the test command action handler, before tests run:

```typescript
if (opts.coverage) {
  process.env.AGENCY_COVERAGE = "1";
  // Pass the configured outDir to child processes via env var,
  // since RuntimeContext reads it from process.env, not from config
  const outDir = config.coverage?.outDir ?? ".coverage";
  process.env.AGENCY_COVERAGE_OUTDIR = outDir;
  if (!opts.accumulate) {
    cleanCoverage(config);
  }
}
```

Note: Setting `process.env.AGENCY_COVERAGE` in the parent process works because Agency tests are spawned via `execFileAsync("node", ...)` which inherits the parent's environment by default.

After tests complete:

```typescript
if (opts.coverage) {
  generateReport(config);
}
```

Add the same flags and logic to the `test js` subcommand.

- [ ] **Step 3: Build and verify**

```bash
pnpm run build
# Run a simple test with coverage
pnpm run agency test --coverage tests/agency/binop.agency 2>&1 | tee /tmp/cov-flag-test.txt
```

Expected: Coverage data collected, summary report printed after tests.

- [ ] **Step 4: Verify --accumulate preserves data**

```bash
pnpm run agency test --coverage tests/agency/binop.agency
pnpm run agency test --coverage --accumulate tests/agency/handlers/handle-approve.agency
pnpm run agency coverage report
```

Expected: Report includes coverage from both test runs.

- [ ] **Step 5: Clean up and commit**

```bash
rm -rf .coverage
git add scripts/agency.ts lib/cli/test.ts
git commit -m "add --coverage and --accumulate flags to test commands"
```

---

## Task 8: End-to-end verification

- [ ] **Step 1: Run agency test coverage**

```bash
pnpm run agency test --coverage tests/agency/ 2>&1 | tee /tmp/cov-e2e-1.txt
```

Verify: summary report shows per-file coverage for tested modules.

Then generate a stdlib-focused report:

```bash
pnpm run agency coverage report stdlib/
```

Verify: shows coverage for each stdlib module file.

- [ ] **Step 2: Generate HTML report**

```bash
pnpm run agency coverage report --html
```

Verify: `.coverage/report/index.html` exists and opens in a browser with file list and annotated source.

- [ ] **Step 3: Generate detail report**

```bash
pnpm run agency coverage report --detail stdlib/math.agency
```

Verify: annotated source with covered/uncovered markers.

- [ ] **Step 4: Multi-run merge**

```bash
pnpm run agency coverage clean
AGENCY_COVERAGE=1 pnpm run test:agency 2>&1 | tee /tmp/cov-e2e-agency.txt
AGENCY_COVERAGE=1 pnpm run test:agency-js 2>&1 | tee /tmp/cov-e2e-js.txt
pnpm run agency coverage report
```

Verify: merged report includes data from both test runs.

- [ ] **Step 5: Verify existing tests still pass**

```bash
pnpm test:run 2>&1 | tee /tmp/cov-e2e-unit.txt
```

- [ ] **Step 6: Clean up and final commit**

```bash
rm -rf .coverage
git add -A
git commit -m "final coverage system verification"
```
