// Main-only CLI command integration tests.
// Runs from a fresh temp project with agency-lang installed from an npm pack tarball.
// Avoids interactive commands and real LLM calls.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  assertIncludes,
  cleanup,
  createTempProject,
  getTarballPath,
  initProject,
  installTarball,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("cli-main");
const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const expectedDir = join(fixtureDir, "expected");
const logsDir = join(dir, "__logs");
mkdirSync(logsDir, { recursive: true });

// Shared helpers

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeNewline(text) {
  return text.replace(/\r\n/g, "\n");
}

function readText(path) {
  return normalizeNewline(readFileSync(path, "utf8"));
}

function assertFile(path, message) {
  assert(existsSync(path), message || `Expected file to exist: ${path}`);
}

function normalizeOptionalFinalNewline(text) {
  return normalizeNewline(text).replace(/\n*$/, "\n");
}

// Compares two files for equality. By default the comparison is strict
// (line-for-line, preserving trailing newlines). Pass
// `{ normalizeTrailingNewline: true }` to collapse trailing newline
// differences before comparing.
function assertFileEquals(actualPath, expectedPath, opts = {}) {
  const normalize = opts.normalizeTrailingNewline
    ? normalizeOptionalFinalNewline
    : normalizeNewline;
  const actual = normalize(readFileSync(actualPath, "utf8"));
  const expected = normalize(readFileSync(expectedPath, "utf8"));
  assert(
    actual === expected,
    `Expected ${actualPath} to match ${expectedPath}\n--- actual ---\n${actual}\n--- expected ---\n${expected}`,
  );
}

function commandToString(file, args) {
  return [file, ...args].join(" ");
}

function runLogged(label, file, args = [], opts = {}) {
  const logPath = join(logsDir, `${label}.txt`);
  const command = commandToString(file, args);
  const result = spawnSync(file, args, {
    cwd: opts.cwd || dir,
    encoding: "utf8",
    timeout: opts.timeout || 120_000,
    input: opts.input,
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const output = `${stdout}${stderr}`;
  writeFileSync(logPath, output);

  if (result.error) {
    const error = new Error(
      `Command failed: ${command}\nLog: ${logPath}\nspawn error: ${result.error.message}\n${output}`,
    );
    error.cause = result.error;
    throw error;
  }
  if (opts.expectFail) {
    assert(result.status !== 0, `Expected command to fail but it succeeded: ${command}`);
    return output;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\nLog: ${logPath}\n${output}`);
  }
  return stdout;
}

function runAgency(label, args, opts = {}) {
  return runLogged(label, "npx", ["--no-install", "agency", ...args], opts);
}

function runNode(label, args, opts = {}) {
  return runLogged(label, "node", args, opts);
}

// Fixture setup

function copyProjectFixtures() {
  cpSync(join(fixtureDir, "project", "src"), join(dir, "src"), {
    recursive: true,
  });
  cpSync(join(fixtureDir, "project", "docs-src"), join(dir, "docs-src"), {
    recursive: true,
  });
  cpSync(join(fixtureDir, "project", "agents"), join(dir, "agents"), {
    recursive: true,
  });
}

// trace helpers

function readJsonLines(path) {
  return readText(path)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function collectHashStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHashStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectHashStrings(item, out);
  }
  return out;
}

function assertChunkBeforeManifest(lines, hash, manifest) {
  const chunkIndex = lines.findIndex(
    (line) => line.type === "chunk" && line.hash === hash,
  );
  assert(chunkIndex >= 0, `Manifest references missing chunk ${hash}`);
  assert(
    chunkIndex < lines.indexOf(manifest),
    `Chunk ${hash} should appear before its manifest`,
  );
}

function assertTraceFile(tracePath, expectedProgram) {
  const lines = readJsonLines(tracePath);
  const headers = lines.filter((line) => line.type === "header");
  const footers = lines.filter((line) => line.type === "footer");
  const chunks = lines.filter((line) => line.type === "chunk");
  const manifests = lines.filter((line) => line.type === "manifest");

  assert(headers.length === 1, `Expected exactly one trace header, found ${headers.length}`);
  assert(footers.length === 1, `Expected exactly one trace footer, found ${footers.length}`);
  assert(lines[0].type === "header", "Expected trace header to be first line");
  assert(lines[lines.length - 1].type === "footer", "Expected trace footer to be last line");
  assert(chunks.length > 0, "Expected at least one trace chunk");
  assert(manifests.length > 0, "Expected at least one trace manifest");

  const header = headers[0];
  assert(header.version === 1, `Expected trace version 1, got ${header.version}`);
  assert(
    header.program === expectedProgram,
    `Expected trace program ${expectedProgram}, got ${header.program}`,
  );
  assert(header.config.hashAlgorithm === "sha256", "Expected sha256 trace hash algorithm");
  assert(typeof header.runId === "string" && header.runId.length > 0, "Expected non-empty trace runId");

  const footer = footers[0];
  assert(
    footer.checkpointCount === manifests.length,
    `Expected footer checkpointCount ${manifests.length}, got ${footer.checkpointCount}`,
  );
  assert(
    footer.chunkCount === chunks.length,
    `Expected footer chunkCount ${chunks.length}, got ${footer.chunkCount}`,
  );

  const chunkHashes = chunks.map((chunk) => chunk.hash);
  for (const chunk of chunks) {
    assert(typeof chunk.hash === "string" && chunk.hash.length > 0, "Expected chunk hash");
    assert(Object.hasOwn(chunk, "data"), "Expected chunk data");
  }

  for (const manifest of manifests) {
    assert(typeof manifest.id === "number", "Expected manifest id");
    assert(typeof manifest.nodeId === "string" && manifest.nodeId.length > 0, "Expected manifest nodeId");
    assert(typeof manifest.moduleId === "string" && manifest.moduleId.length > 0, "Expected manifest moduleId");
    assert(typeof manifest.scopeName === "string" && manifest.scopeName.length > 0, "Expected manifest scopeName");
    assert(typeof manifest.stepPath === "string" && manifest.stepPath.length > 0, "Expected manifest stepPath");
    assert(manifest.stack.mode === "serialize", `Expected manifest stack mode serialize, got ${manifest.stack.mode}`);

    for (const hash of manifest.stack.stack) {
      assert(chunkHashes.includes(hash), `Manifest references missing stack chunk ${hash}`);
      assertChunkBeforeManifest(lines, hash, manifest);
    }

    for (const hash of collectHashStrings(manifest.globals.store)) {
      assert(chunkHashes.includes(hash), `Manifest references missing globals chunk ${hash}`);
      assertChunkBeforeManifest(lines, hash, manifest);
    }
  }
}

// parse helpers

function assertParseOutput(output, nodeName) {
  const parsed = JSON.parse(output);
  const nodes = parsed.nodes || [];
  assert(
    nodes.some((node) => node.type === "graphNode" && node.nodeName === nodeName),
    `Expected parsed AST to contain node ${nodeName}`,
  );
}

// coverage helpers

function extractCoverageStats(output) {
  const clean = stripAnsi(output);
  const total =
    clean.match(/Total\s+([0-9.]+)%\s+\((\d+)\/(\d+) steps\)/) ||
    clean.match(/\.agency\s+([0-9.]+)%\s+\((\d+)\/(\d+)\)/);
  assert(total, `Expected coverage percentage line, got:\n${clean}`);
  return {
    clean,
    percentage: Number(total[1]),
    covered: Number(total[2]),
    steps: Number(total[3]),
  };
}

function assertFullCoverage(output) {
  const { clean, percentage, covered, steps } = extractCoverageStats(output);
  assertIncludes(clean, "Agency Coverage Report");
  assert(percentage === 100, `Expected coverage to be 100.0%, got ${percentage}%`);
  assert(covered === steps, `Expected covered steps to equal total steps, got ${covered}/${steps}`);
  assert(covered > 0, "Expected coverage to include at least one step");
}

function assertPartialCoverage(output) {
  const { clean, percentage, covered, steps } = extractCoverageStats(output);
  assertIncludes(clean, "Agency Coverage Report");
  assert(
    percentage > 0 && percentage < 100,
    `Expected partial coverage, got ${percentage}%`,
  );
  assert(
    covered > 0 && covered < steps,
    `Expected covered steps to be between 0 and total, got ${covered}/${steps}`,
  );
}

try {
  initProject(dir);
  installTarball(dir, tarball);
  copyProjectFixtures();

  // version

  console.log("--- version ---");
  const versionOutput = runAgency("01-version", ["--version"]);
  assert(
    /^\d+\.\d+\.\d+\s*$/.test(versionOutput),
    `Expected semver version output, got: ${versionOutput}`,
  );

  // compile

  console.log("--- compile ---");
  runAgency("02-compile", ["compile", "src/basic.agency"]);
  assertFile(join(dir, "src/basic.js"), "compile should write src/basic.js");
  assertIncludes(
    runNode("03-compiled-output", ["src/run-compiled.mjs"]),
    "compiled-ok",
  );

  runAgency("04-compile-ts", ["compile", "src/basic.agency", "--ts"]);
  assertFile(join(dir, "src/basic.ts"), "compile --ts should write src/basic.ts");
  assertIncludes(readText(join(dir, "src/basic.ts")), "// @ts-nocheck");

  // run

  console.log("--- run ---");
  assertIncludes(
    runAgency("05-run", ["run", "src/basic.agency"]),
    "basic-ok",
  );

  // pack

  console.log("--- pack ---");
  runAgency("06-pack", ["pack", "src/pack-target.agency", "-o", "packed.mjs"]);
  assertFile(join(dir, "packed.mjs"), "pack should write packed.mjs");
  assert(statSync(join(dir, "packed.mjs")).size > 0, "packed.mjs should be non-empty");

  const standaloneDir = createTempProject("cli-main-standalone");
  try {
    cpSync(join(dir, "packed.mjs"), join(standaloneDir, "packed.mjs"));
    unlinkSync(join(dir, "packed.mjs"));
    assert(!existsSync(join(standaloneDir, "node_modules")), "standalone directory must not contain node_modules");
    assertIncludes(
      runNode("07-pack-standalone", ["packed.mjs"], { cwd: standaloneDir }),
      "pack-ok",
    );
  } finally {
    cleanup(standaloneDir);
  }

  runAgency(
    "08-pack-imports",
    ["pack", "src/pack-imports.agency", "-o", "packed-imports.mjs"],
  );
  const importsStandaloneDir = createTempProject("cli-main-pack-imports");
  try {
    cpSync(join(dir, "packed-imports.mjs"), join(importsStandaloneDir, "packed-imports.mjs"));
    unlinkSync(join(dir, "packed-imports.mjs"));
    assert(
      !existsSync(join(importsStandaloneDir, "node_modules")),
      "pack imports standalone directory must not contain node_modules",
    );
    assertIncludes(
      runNode("09-pack-imports-standalone", ["packed-imports.mjs"], {
        cwd: importsStandaloneDir,
      }),
      "pack-imports-local-5",
    );
  } finally {
    cleanup(importsStandaloneDir);
  }

  const invalidPackTarget = runAgency(
    "10-pack-invalid-target",
    ["pack", "src/pack-target.agency", "--target", "browser"],
    { expectFail: true },
  );
  assertIncludes(invalidPackTarget, "Unsupported pack target: browser");

  // trace

  console.log("--- trace ---");
  runAgency("11-trace", ["trace", "src/trace-target.agency", "-o", "trace-target.trace"]);
  const tracePath = join(dir, "trace-target.trace");
  assertFile(tracePath, "trace should write trace-target.trace");
  assertTraceFile(tracePath, "src/trace-target.agency");

  runAgency("12-trace-log", ["trace", "log", "trace-target.trace", "-o", "trace-events.json"]);
  assertFile(join(dir, "trace-events.json"), "trace log should write trace-events.json");
  const traceEvents = JSON.parse(readText(join(dir, "trace-events.json")));
  assert(Array.isArray(traceEvents), "trace log output should be an array");
  assert(traceEvents.length > 0, "trace log should contain events");

  // fmt

  console.log("--- fmt ---");
  runAgency("13-fmt-in-place", ["fmt", "src/fmt-input.agency", "-i"]);
  assertFileEquals(join(dir, "src/fmt-input.agency"), join(expectedDir, "fmt.expected.agency"));

  const formattedOnce = readText(join(dir, "src/fmt-input.agency"));
  runAgency("14-fmt-idempotent", ["fmt", "src/fmt-input.agency", "-i"]);
  const formattedTwice = readText(join(dir, "src/fmt-input.agency"));
  assert(formattedOnce === formattedTwice, "fmt should be idempotent");

  cpSync(join(fixtureDir, "project", "src", "fmt-input.agency"), join(dir, "src/fmt-stdout.agency"));
  const stdoutFormatted = runAgency(
    "15-fmt-stdout",
    ["fmt", "src/fmt-stdout.agency"],
  );
  assert(
    normalizeOptionalFinalNewline(stdoutFormatted) ===
      normalizeOptionalFinalNewline(readText(join(expectedDir, "fmt.expected.agency"))),
    "fmt stdout should match the fixture",
  );
  // fmt without -i must not modify the source file.
  assertFileEquals(
    join(dir, "src/fmt-stdout.agency"),
    join(fixtureDir, "project", "src", "fmt-input.agency"),
  );

  // interrupts

  console.log("--- interrupts ---");

  // Copy the interrupts fixtures into the temp project.
  cpSync(
    join(fixtureDir, "interrupts"),
    join(dir, "interrupts"),
    { recursive: true },
  );

  const interruptCases = [
    { name: "single-file", entryFile: "interrupts/single-file.agency" },
    { name: "cross-file", entryFile: "interrupts/cross-file/main.agency" },
    { name: "llm-tool", entryFile: "interrupts/llm-tool.agency" },
    { name: "recursion", entryFile: "interrupts/recursion.agency" },
    { name: "no-handler", entryFile: "interrupts/no-handler.agency" },
  ];

  // IMPORTANT: keep this normalization in sync with the matching block in
  // scripts/regenerate-fixtures.ts (regenerateInterruptFixtures). If one
  // changes, the snapshots will drift and these tests will fail spuriously.
  //
  // On macOS, `/tmp` and `/var/folders/...` are symlinks to
  // `/private/tmp` and `/private/var/folders/...`. Node's path.resolve
  // does not follow symlinks, but the agency CLI ends up surfacing the
  // realpath-resolved form, so we normalize both the original temp dir
  // and its realpath to the same token.
  const interruptsDir = join(dir, "interrupts");
  const interruptsDirReal = realpathSync(interruptsDir);
  function normalizeInterruptOutput(s) {
    return s
      .replaceAll(interruptsDirReal, "<fixtures>/interrupts")
      .replaceAll(interruptsDir, "<fixtures>/interrupts")
      .replaceAll(/\\/g, "/");
  }

  for (const c of interruptCases) {
    const actualOutput = runAgency(
      `interrupts-${c.name}`,
      ["interrupts", c.entryFile],
    );
    const normalized = normalizeInterruptOutput(actualOutput);
    const actualPath = join(logsDir, `interrupts-${c.name}.actual.txt`);
    writeFileSync(actualPath, normalized);
    assertFileEquals(
      actualPath,
      join(expectedDir, `interrupts-${c.name}.txt`),
      { normalizeTrailingNewline: true },
    );
  }

  // parse

  console.log("--- parse ---");
  assertParseOutput(
    runAgency("16-parse", ["parse", "src/basic.agency"]),
    "main",
  );
  assertParseOutput(
    runAgency("17-parse-stdin", ["parse"], {
      input: `node stdinMain() {
  return "stdin"
}
`,
    }),
    "stdinMain",
  );

  // parse: directory support (#438)
  const parseDir = join(dir, "parse-dir");
  mkdirSync(parseDir, { recursive: true });
  writeFileSync(
    join(parseDir, "alpha.agency"),
    `node alphaMain() {
  return "alpha"
}
`,
  );
  writeFileSync(
    join(parseDir, "beta.agency"),
    `node betaMain() {
  return "beta"
}
`,
  );
  const parseDirOut = runAgency("17a-parse-dir", ["parse", "parse-dir"]);
  assertIncludes(parseDirOut, "alphaMain");
  assertIncludes(parseDirOut, "betaMain");

  // coverage

  console.log("--- coverage ---");
  runAgency("18-coverage-generate", ["test", "src/coverage-target.agency", "--coverage"]);
  const coverageOutput = runAgency(
    "19-coverage-report",
    ["coverage", "report", "src/coverage-target.agency", "--detail", "--threshold", "100"],
  );
  assertFullCoverage(coverageOutput);
  assertFile(join(dir, ".coverage"), "coverage run should create .coverage");
  runAgency("20-coverage-clean", ["coverage", "clean"]);
  assert(!existsSync(join(dir, ".coverage")), "coverage clean should remove .coverage");

  runAgency(
    "21-coverage-partial-generate",
    ["test", "src/coverage-partial.agency", "--coverage"],
  );
  const partialCoverageOutput = runAgency(
    "22-coverage-partial-report",
    ["coverage", "report", "src/coverage-partial.agency", "--detail"],
  );
  assertPartialCoverage(partialCoverageOutput);
  const thresholdFailure = stripAnsi(runAgency(
    "23-coverage-threshold-failure",
    ["coverage", "report", "src/coverage-partial.agency", "--threshold", "100"],
    { expectFail: true },
  ));
  assertIncludes(thresholdFailure, "below threshold 100%");
  runAgency("24-coverage-clean-partial", ["coverage", "clean"]);
  assert(!existsSync(join(dir, ".coverage")), "coverage clean should remove partial coverage data");

  // tc

  console.log("--- tc ---");
  assertIncludes(
    runAgency("25-tc-ok", ["tc", "src/type-ok.agency"]),
    "No type errors found.",
  );
  const tcError = stripAnsi(runAgency(
    "26-tc-error",
    ["tc", "src/type-error.agency"],
    { expectFail: true },
  ));
  assertIncludes(tcError, "Type '\"oops\"' is not assignable to type 'number'");
  assertIncludes(tcError, "return in 'bad'");
  assertIncludes(
    runAgency("27-tc-stdin", ["tc"], {
      input: `node stdinTypecheck(): string {
  return "stdin-ok"
}
`,
    }),
    "No type errors found.",
  );
  const strictError = stripAnsi(runAgency(
    "28-tc-strict",
    ["tc", "src/type-strict.agency", "--strict"],
    { expectFail: true },
  ));
  assertIncludes(strictError, "no type annotation");
  assertIncludes(strictError, "strict mode");

  // tc: directories and '-' stdin (#438)
  const tcDir = join(dir, "tc-clean");
  mkdirSync(tcDir, { recursive: true });
  writeFileSync(
    join(tcDir, "one.agency"),
    `node oneCheck(): string {
  return "ok"
}
`,
  );
  writeFileSync(
    join(tcDir, "two.agency"),
    `node twoCheck(): number {
  return 42
}
`,
  );
  const tcDirOut = runAgency("28a-tc-dir", ["tc", "tc-clean"]);
  assert(
    (tcDirOut.match(/No type errors found\./g) || []).length >= 2,
    "tc on a directory should type check every .agency file in it",
  );

  // tc: a directory whose files import each other divergently. This guards the
  // multi-entrypoint SymbolTable seed: `consumer.agency` imports from
  // `helper.agency`, which is NOT reachable from whichever file `findRecursively`
  // yields first. With a single-file seed, consumer's import resolves to nothing
  // and typecheck reports a false-positive error (exit 1). Seeding from every
  // file source keeps it clean.
  const tcImportDir = join(dir, "tc-imports");
  mkdirSync(tcImportDir, { recursive: true });
  writeFileSync(
    join(tcImportDir, "helper.agency"),
    `export def greet(name: string): string {
  return "hi " + name
}
`,
  );
  writeFileSync(
    join(tcImportDir, "consumer.agency"),
    `import { greet } from "./helper.agency"

node useGreet(): string {
  return greet("there")
}
`,
  );
  const tcImportOut = runAgency("28a2-tc-dir-imports", ["tc", "tc-imports"]);
  assert(
    (tcImportOut.match(/No type errors found\./g) || []).length >= 2,
    "tc on a directory with cross-file imports must resolve them (seed the SymbolTable from every file, not just the first)",
  );

  const tcMixedOut = runAgency("28b-tc-dir-mixed", ["tc", "tc-clean", "src/type-ok.agency"]);
  assert(
    (tcMixedOut.match(/No type errors found\./g) || []).length >= 3,
    "tc should accept mixed directory and file arguments",
  );

  assertIncludes(
    runAgency("28c-tc-dash", ["tc", "-"], {
      input: `node dashCheck(): string {
  return "dash-ok"
}
`,
    }),
    "No type errors found.",
  );

  const tcEmptyDir = join(dir, "tc-empty");
  mkdirSync(tcEmptyDir, { recursive: true });
  assertIncludes(
    runAgency("28d-tc-empty-dir", ["tc", "tc-empty"]),
    "No .agency files found",
  );

  // bundle and unbundle

  console.log("--- bundle/unbundle ---");
  runAgency(
    "29-bundle",
    ["bundle", "src/trace-target.agency", "trace-target.trace", "-o", "trace-target.bundle"],
  );
  const bundlePath = join(dir, "trace-target.bundle");
  assertFile(bundlePath, "bundle should write trace-target.bundle");
  const bundleLines = readJsonLines(bundlePath);
  assert(
    bundleLines[0].type === "header" && bundleLines[0].bundle === true,
    "bundle should mark the header with bundle=true",
  );
  assert(
    bundleLines.some((line) => line.type === "source" && line.path === "trace-target.agency"),
    "bundle should include source line",
  );

  runAgency("30-unbundle", ["unbundle", "trace-target.bundle", "-o", "unpacked"]);
  assertFileEquals(
    join(dir, "unpacked/trace-target.agency"),
    join(dir, "src/trace-target.agency"),
    { normalizeTrailingNewline: true },
  );
  assertFile(join(dir, "unpacked/trace-target.trace"), "unbundle should write trace-target.trace");
  assertTraceFile(join(dir, "unpacked/trace-target.trace"), "trace-target.agency");

  // doc

  console.log("--- doc ---");
  runAgency("31-doc", ["doc", "src/doc-target.agency", "-o", "generated-docs"]);
  assertFileEquals(join(dir, "generated-docs/doc-target.md"), join(expectedDir, "doc-target.expected.md"));

  runAgency("32-doc-directory-ignore", ["doc", "docs-src", "-o", "generated-docs-dir", "--ignore", "ignored"]);
  assertFile(join(dir, "generated-docs-dir/main.md"), "doc directory mode should generate main.md");
  assert(!existsSync(join(dir, "generated-docs-dir/ignored/skip.md")), "doc --ignore should skip ignored directories");

  // schedule

  console.log("--- schedule ---");
  const scheduleEnv = { HOME: join(dir, "__home") };
  runAgency(
    "33-schedule-add-github",
    ["schedule", "add", "agents/nightly.agency", "--backend", "github", "--every", "hourly", "--name", "nightly", "--no-pin", "--secret", "EXTRA_TOKEN"],
    { env: scheduleEnv },
  );
  assertFileEquals(join(dir, "nightly.yml"), join(expectedDir, "nightly.expected.yml"));
  // The github backend writes a workflow YAML file and does not persist any
  // state under $HOME, so `schedule list` should report no scheduled agents
  // even though the previous `schedule add` succeeded.
  const listOutput = runAgency("34-schedule-list", ["schedule", "list"], { env: scheduleEnv });
  assertIncludes(listOutput, "No scheduled agents");
  const removeOutput = stripAnsi(runAgency(
    "35-schedule-remove-missing",
    ["schedule", "remove", "nightly"],
    { env: scheduleEnv, expectFail: true },
  ));
  assertIncludes(removeOutput, "No schedule named \"nightly\"");

  runAgency(
    "36-schedule-cron-github",
    ["schedule", "add", "agents/nightly.agency", "--backend", "github", "--cron", "*/5 * * * *", "--name", "nightly-cron", "--no-pin"],
    { env: scheduleEnv },
  );
  assertFileEquals(join(dir, "nightly-cron.yml"), join(expectedDir, "nightly-cron.expected.yml"));

  runAgency(
    "37-schedule-write-github",
    ["schedule", "add", "agents/nightly.agency", "--backend", "github", "--every", "hourly", "--name", "nightly-write", "--no-pin", "--write"],
    { env: scheduleEnv },
  );
  assertFileEquals(join(dir, "nightly-write.yml"), join(expectedDir, "nightly-write.expected.yml"));

  const existingSchedule = stripAnsi(runAgency(
    "38-schedule-existing-failure",
    ["schedule", "add", "agents/nightly.agency", "--backend", "github", "--every", "hourly", "--name", "nightly", "--no-pin"],
    { env: scheduleEnv, expectFail: true },
  ));
  assertIncludes(existingSchedule, "File already exists");

  const invalidBackend = stripAnsi(runAgency(
    "39-schedule-invalid-backend",
    ["schedule", "add", "agents/nightly.agency", "--backend", "local", "--every", "hourly", "--name", "bad"],
    { env: scheduleEnv, expectFail: true },
  ));
  assertIncludes(invalidBackend, "Unknown --backend value");

  console.log("=== Main-only CLI command tests passed ===");
  cleanup(dir);
} catch (err) {
  console.error("Main-only CLI command test failed:", err);
  console.error("Temp directory preserved at:", dir);
  console.error("Command logs preserved at:", logsDir);
  process.exit(1);
}
