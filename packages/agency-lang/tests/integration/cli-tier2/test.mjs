// Per-PR integration tests for the Tier 2 artifact CLI commands: pack, trace,
// bundle/unbundle, and coverage. Installs the npm tarball once, then runs each
// stateful workflow in its own project subdirectory so they share no mutable
// state. Deep format matrices stay in cli-main; these are per-PR
// packaging-and-consumability smoke checks.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assert,
  assertFile,
  assertFileEquals,
  assertIncludes,
  cleanup,
  createTempProject,
  getTarballPath,
  initProject,
  installTarball,
  readJsonLines,
  readText,
  runInstalledAgency,
  runProcess,
  writeFile,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("cli-tier2");

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function assertBlank(text, label) {
  assert(stripAnsi(text).trim() === "", `${label} should be empty, got:\n${text}`);
}

function subdir(name) {
  const full = join(dir, name);
  mkdirSync(full, { recursive: true });
  return full;
}

// runInstalledAgency plus a clean-success check: the command must leave stderr
// blank. `pack` is the documented exception (it logs compile progress to
// stderr) and uses runInstalledAgency directly.
function runCleanAgency(cwd, args, label) {
  const result = runInstalledAgency(cwd, args);
  assertBlank(result.stderr, `[${label}] stderr`);
  return result;
}

// --- pack: the standalone-isolation contract --------------------------------
// pack already has per-PR coverage that runs the output beside the project's
// node_modules (cli/test.mjs). The missing contract is that the packed file is
// genuinely self-contained: it must run where no node_modules is reachable and
// where the original sources and install are gone.

const PACK_EXPECTED = "TIER2_PACK_SENTINEL_2\n";

function checkPackStandalone() {
  const packDir = subdir("pack");
  // An import-bearing entry: a local module contributes part of the output and
  // a stdlib function contributes the rest, so local, stdlib, and runtime
  // bundling are all exercised.
  writeFile(packDir, "helper.agency", `export def part(): string {\n  return "TIER2_PACK_SENTINEL"\n}\n`);
  writeFile(
    packDir,
    "probe.agency",
    `import { part } from "./helper.agency"\n` +
      `import { add } from "std::math"\n\n` +
      `node main() {\n  print(part() + "_" + add(1, 1))\n}\n`,
  );

  // pack emits compile progress, so do not assert empty stderr on the command
  // itself; the empty-stderr contract is asserted on the standalone run below.
  runInstalledAgency(packDir, ["pack", "probe.agency", "-o", "packed.mjs"]);
  assertFile(join(packDir, "packed.mjs"), "pack should write packed.mjs");

  // Copy only the packed file to a fresh root with no node_modules ancestor.
  // The root lives outside `dir`, so clean it up ourselves in finally.
  const standaloneRoot = mkdtempSync(join(tmpdir(), "agency-tier2-standalone-"));
  try {
    for (let cur = standaloneRoot; ; cur = dirname(cur)) {
      assert(
        !existsSync(join(cur, "node_modules")),
        `standalone root ancestor unexpectedly has node_modules: ${cur}`,
      );
      if (dirname(cur) === cur) break;
    }
    cpSync(join(packDir, "packed.mjs"), join(standaloneRoot, "packed.mjs"));

    // Remove the source dir so an artifact embedding an absolute source path
    // fails, and rename the install's node_modules so bare/absolute install
    // references fail too. Together these prove the copy is self-contained.
    rmSync(packDir, { recursive: true, force: true });
    const nodeModules = join(dir, "node_modules");
    const stashed = join(dir, "node_modules.stashed");
    renameSync(nodeModules, stashed);
    try {
      // Invoke it the way a user would — `node packed.mjs` from its own
      // directory. (A packed program only auto-runs `main` when launched by a
      // relative path.)
      const result = runProcess(process.execPath, ["packed.mjs"], {
        cwd: standaloneRoot,
      });
      assert(
        result.stdout.replace(/\r\n/g, "\n") === PACK_EXPECTED,
        `standalone packed output was:\n${result.stdout}`,
      );
      assertBlank(result.stderr, "[pack standalone] stderr");
    } finally {
      renameSync(stashed, nodeModules);
    }
  } finally {
    cleanup(standaloneRoot);
  }
  console.log("[cli-tier2] pack standalone ✓");
}

// --- trace + bundle/unbundle round-trip -------------------------------------

function checkTraceBundleRoundTrip() {
  const traceDir = subdir("trace");
  // trace runs the `main` node; a uniquely named helper gives the event log a
  // distinctive function to look for.
  const source =
    `def tier2TraceHelper(): string {\n  return "traced"\n}\n\n` +
    `node main() {\n  print(tier2TraceHelper())\n}\n`;
  writeFile(traceDir, "probe.agency", source);

  runCleanAgency(traceDir, ["trace", "run", "probe.agency", "-o", "probe.trace"], "trace run");
  const traceLines = readJsonLines(join(traceDir, "probe.trace"));
  const headers = traceLines.filter((l) => l.type === "header");
  const footers = traceLines.filter((l) => l.type === "footer");
  const manifests = traceLines.filter((l) => l.type === "manifest");
  assert(headers.length === 1, `expected one trace header, got ${headers.length}`);
  assert(footers.length === 1, `expected one trace footer, got ${footers.length}`);
  assert(traceLines[0].type === "header", "trace header must be first");
  assert(traceLines[traceLines.length - 1].type === "footer", "trace footer must be last");
  assert(manifests.length > 0, "expected at least one trace manifest (checkpoint)");
  assert(headers[0].program === "probe.agency", `trace program was ${headers[0].program}`);

  runCleanAgency(traceDir, ["trace", "log", "probe.trace", "-o", "events.json"], "trace log");
  const baselineEvents = JSON.parse(readText(join(traceDir, "events.json")));
  assert(Array.isArray(baselineEvents) && baselineEvents.length > 0, "trace log must yield a non-empty array");
  // Assert the distinctive semantic event for THIS program, not just any
  // node-enter (which every trace gets from `main`).
  assert(
    baselineEvents.some((e) => e.type === "function-enter" && e.functionName === "tier2TraceHelper"),
    "trace log must contain a function-enter for tier2TraceHelper",
  );

  // Save the original source, then bundle and DELETE both originals so unbundle
  // cannot fall back to reading on-disk inputs.
  const savedSource = readText(join(traceDir, "probe.agency"));
  const originalSourcePath = join(traceDir, "probe.agency.original");
  writeFile(traceDir, "probe.agency.original", savedSource);
  runCleanAgency(traceDir, ["bundle", "probe.agency", "probe.trace", "-o", "probe.bundle"], "bundle");
  rmSync(join(traceDir, "probe.agency"));
  rmSync(join(traceDir, "probe.trace"));
  assert(!existsSync(join(traceDir, "probe.agency")), "original source must be gone before unbundle");
  assert(!existsSync(join(traceDir, "probe.trace")), "original trace must be gone before unbundle");
  runCleanAgency(traceDir, ["unbundle", "probe.bundle", "-o", "unpacked"], "unbundle");

  assertFileEquals(join(traceDir, "unpacked", "probe.agency"), originalSourcePath, {
    normalizeTrailingNewline: true,
  });

  // The unbundled trace must still be consumable and semantically identical.
  runCleanAgency(traceDir, ["trace", "log", join("unpacked", "probe.trace"), "-o", join("unpacked", "events.json")], "trace log (unbundled)");
  const restoredEvents = JSON.parse(readText(join(traceDir, "unpacked", "events.json")));
  assert(
    JSON.stringify(restoredEvents) === JSON.stringify(baselineEvents),
    "unbundled trace produced a different event log than the original",
  );
  console.log("[cli-tier2] trace/bundle round-trip ✓");
}

// --- coverage lifecycle -----------------------------------------------------

function parseCoverageTotal(output) {
  const clean = stripAnsi(output);
  const match =
    clean.match(/Total\s+([0-9.]+)%\s+\((\d+)\/(\d+) steps\)/) ||
    clean.match(/\.agency\s+([0-9.]+)%\s+\((\d+)\/(\d+)\)/);
  assert(match, `expected a coverage total line, got:\n${clean}`);
  return { percentage: Number(match[1]), covered: Number(match[2]), total: Number(match[3]) };
}

function checkCoverageLifecycle() {
  const covDir = subdir("coverage");
  writeFile(
    covDir,
    "probe.agency",
    `node covered(): string {\n  const label = "tier2-covered"\n  return label\n}\n`,
  );
  writeFile(
    covDir,
    "probe.test.json",
    JSON.stringify(
      {
        sourceFile: "probe.agency",
        tests: [
          {
            nodeName: "covered",
            input: "",
            expectedOutput: '"tier2-covered"',
            evaluationCriteria: [{ type: "exact" }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  assert(!existsSync(join(covDir, ".coverage")), "coverage dir must not exist before the run");

  const testOut = runCleanAgency(covDir, ["test", "probe.agency", "--coverage"], "test --coverage");
  assertIncludes(stripAnsi(testOut.stdout), "1/1 tests passed");
  const covFiles = readdirSync(join(covDir, ".coverage")).filter(
    (f) => f.startsWith("cov-") && f.endsWith(".json"),
  );
  assert(covFiles.length > 0, "coverage run should write a .coverage/cov-*.json file");

  const report = runCleanAgency(
    covDir,
    ["coverage", "report", "probe.agency", "--detail", "--threshold", "100"],
    "coverage report",
  );
  const { percentage, covered, total } = parseCoverageTotal(report.stdout);
  assert(total > 0, "coverage total steps must be non-zero");
  assert(covered === total, `expected covered === total, got ${covered}/${total}`);
  assert(percentage === 100, `expected 100% coverage, got ${percentage}%`);

  runCleanAgency(covDir, ["coverage", "clean"], "coverage clean");
  assert(!existsSync(join(covDir, ".coverage")), "coverage clean should remove .coverage");
  console.log("[cli-tier2] coverage lifecycle ✓");
}

// --- Run everything ---------------------------------------------------------

try {
  initProject(dir);
  installTarball(dir, tarball);

  checkPackStandalone();
  checkTraceBundleRoundTrip();
  checkCoverageLifecycle();

  console.log("=== cli-tier2 test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("cli-tier2 test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
