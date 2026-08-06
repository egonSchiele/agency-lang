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
import { pathToFileURL } from "node:url";
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

// --- definition (LSP go-to-definition, reads source on stdin) ---------------

function checkDefinition() {
  // Two functions are called on one line; the cursor points at the SECOND call.
  // Coordinates are derived from the fixture, and the line/column differ so that
  // swapping them (below) lands off-target — proving the arguments are honored.
  const source = [
    "def alpha(): number {",
    "  return 1",
    "}",
    "",
    "def beta(): number {",
    "  return 2",
    "}",
    "",
    "node main(): number {",
    "  return alpha() + beta()",
    "}",
    "",
  ].join("\n");
  const lines = source.split("\n");
  const callLine = lines.findIndex((l) => l.includes("alpha() + beta()"));
  assert(callLine >= 0, "fixture must contain the alpha() + beta() call line");
  const callColumn = lines[callLine].indexOf("beta()");
  assert(callColumn >= 0, "fixture call line must contain beta()");
  const defLine = lines.findIndex((l) => l.startsWith("def beta"));
  assert(defLine >= 0, "fixture must contain beta's declaration");
  assert(callLine !== callColumn, "fixture line and column must differ for the swap check");

  const result = runInstalledAgency(
    dir,
    ["definition", "--line", String(callLine), "--column", String(callColumn), "--file", "probe.agency"],
    { input: source },
  );
  assertBlank(result.stderr, "[definition] stderr");
  const got = JSON.parse(result.stdout);
  assert(
    JSON.stringify(got) === JSON.stringify({ file: "probe.agency", line: defLine, column: 0 }),
    `definition returned ${result.stdout}`,
  );

  // Swapping line and column points at an out-of-range position, which must
  // resolve to null — proving the cursor arguments are honored, not ignored.
  const swapped = runInstalledAgency(
    dir,
    ["definition", "--line", String(callColumn), "--column", String(callLine), "--file", "probe.agency"],
    { input: source },
  );
  assertBlank(swapped.stderr, "[definition swapped] stderr");
  assert(
    JSON.parse(swapped.stdout) === null,
    `swapped cursor should resolve to null, got: ${swapped.stdout}`,
  );
  console.log("[cli-tier2] definition ✓");
}

// --- models list (bundled catalog, offline) ---------------------------------

function checkModelsList() {
  const modelsDir = subdir("models");
  // Run with all outbound network entry points throwing, so if `models list`
  // regressed to fetching the remote catalog it would fail here rather than
  // pass on networked CI.
  writeFile(
    modelsDir,
    "blocknet.mjs",
    [
      'import http from "node:http";',
      'import https from "node:https";',
      'import net from "node:net";',
      'const boom = (w) => () => { throw new Error(`network blocked by test preload (${w})`); };',
      'globalThis.fetch = boom("fetch");',
      'http.request = boom("http.request"); http.get = boom("http.get");',
      'https.request = boom("https.request"); https.get = boom("https.get");',
      'net.Socket.prototype.connect = boom("socket.connect");',
      "",
    ].join("\n"),
  );
  // Use the single-option `--import=<file-url>` form: NODE_OPTIONS is
  // space-tokenized, so a raw path breaks when TMPDIR contains a space, and a
  // bare path is not a safe ESM specifier on Windows. A pathToFileURL href
  // encodes spaces and is platform-correct.
  const preloadUrl = pathToFileURL(join(modelsDir, "blocknet.mjs")).href;
  const result = runInstalledAgency(modelsDir, ["models", "list"], {
    env: { NODE_OPTIONS: `--import=${preloadUrl}` },
  });
  assertBlank(result.stderr, "[models list] stderr");
  const lines = result.stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.includes("NAME") && l.includes("PROVIDER"));
  assert(headerIdx >= 0, "models list must print a NAME/PROVIDER header");
  // The empty catalog still prints the header, so require a real, structurally
  // complete data row — all six columns — without pinning volatile values.
  const dataRow = lines.slice(headerIdx + 1).find((l) => l.trim().length > 0);
  assert(dataRow, "models list must print at least one model row");
  const fields = dataRow.trim().split(/\s+/);
  assert(fields.length === 6, `expected 6 columns, got ${fields.length}: "${dataRow}"`);
  const [name, provider, open, inPrice, outPrice, ctx] = fields;
  assert(name.length > 0, "model name must be non-empty");
  assert(provider.length > 0, "model provider must be non-empty");
  assert(/^(yes|no)$/.test(open), `open-weights column must be yes|no, got "${open}"`);
  assert(/^\d+(\.\d+)?$/.test(inPrice), `input price must be numeric, got "${inPrice}"`);
  assert(/^\d+(\.\d+)?$/.test(outPrice), `output price must be numeric, got "${outPrice}"`);
  assert(/^\d+$/.test(ctx) && Number(ctx) > 0, `context must be a positive integer, got "${ctx}"`);
  console.log("[cli-tier2] models list ✓");
}

// --- local list / resolve, fully isolated from global state -----------------

function checkLocalIsolated() {
  const localDir = subdir("local");
  const envModels = join(localDir, "env-models");
  const configModels = join(localDir, "config-models");
  const home = join(localDir, "home");
  mkdirSync(home, { recursive: true });
  // A sentinel in AGENCY_MODELS_DIR and a decoy in the config's modelsDir prove
  // directory selection rather than coincidentally observing two empty dirs.
  writeFile(envModels, "env-sentinel.gguf", "");
  writeFile(configModels, "config-decoy.gguf", "");
  writeFile(localDir, "agency.json", JSON.stringify({ client: { modelsDir: configModels } }, null, 2) + "\n");
  writeFile(localDir, "provider.mjs", "export default {};\n");

  // The provider gate needs AGENCY_LLAMA_PROVIDER_MODULE (smoltalk-llama-cpp is
  // not installed on CI); the isolated HOME keeps ~/agency.json aliases out.
  // The gate also discovers global installs via `npm/pnpm root -g`, so point
  // both global prefixes at an empty project-owned dir — then the supplied
  // provider override is the only support path, and the test is host-independent
  // (a globally installed smoltalk-llama-cpp cannot silently satisfy the gate).
  // A fresh HOME makes npm run its update check and print a notice to stderr, so
  // disable the notifier to keep the empty-stderr assertions about the command.
  const emptyGlobalRoot = join(localDir, "empty-global");
  mkdirSync(emptyGlobalRoot, { recursive: true });
  const env = {
    AGENCY_MODELS_DIR: envModels,
    AGENCY_LLAMA_PROVIDER_MODULE: join(localDir, "provider.mjs"),
    HOME: home,
    npm_config_update_notifier: "false",
    npm_config_prefix: emptyGlobalRoot,
    PNPM_HOME: emptyGlobalRoot,
  };

  const list = runInstalledAgency(localDir, ["local", "list"], { env });
  assertBlank(list.stderr, "[local list] stderr");
  assertIncludes(list.stdout, "env-sentinel.gguf");
  assert(!list.stdout.includes("config-decoy.gguf"), "AGENCY_MODELS_DIR must win over config modelsDir");
  assert(!list.stdout.includes("No models downloaded."), "the env models dir should not read as empty");

  const resolved = runInstalledAgency(localDir, ["local", "resolve", "smollm2-135m"], { env });
  assertBlank(resolved.stderr, "[local resolve] stderr");
  assert(
    resolved.stdout.replace(/\r\n/g, "\n").trim() === "hf:unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
    `local resolve returned: ${resolved.stdout}`,
  );
  console.log("[cli-tier2] local isolated ✓");
}

// --- Run everything ---------------------------------------------------------

try {
  initProject(dir);
  installTarball(dir, tarball);

  checkPackStandalone();
  checkTraceBundleRoundTrip();
  checkCoverageLifecycle();
  checkDefinition();
  checkModelsList();
  checkLocalIsolated();

  console.log("=== cli-tier2 test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("cli-tier2 test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
