// Main-only CLI command integration tests.
// Runs from a fresh temp project with agency-lang installed from an npm pack tarball.
// Avoids interactive commands and real LLM calls.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
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
  writeFile,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("cli-main");
const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const logsDir = join(dir, "__logs");
mkdirSync(logsDir, { recursive: true });

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

function assertExactFile(actualPath, expectedPath) {
  const actual = readText(actualPath);
  const expected = readText(expectedPath);
  assert(
    actual === expected,
    `Expected ${actualPath} to match ${expectedPath}\n--- actual ---\n${actual}\n--- expected ---\n${expected}`,
  );
}

function normalizeOptionalFinalNewline(text) {
  return normalizeNewline(text).replace(/\n*$/, "\n");
}

function assertSameFileContent(actualPath, expectedPath) {
  const actual = normalizeOptionalFinalNewline(readFileSync(actualPath, "utf8"));
  const expected = normalizeOptionalFinalNewline(
    readFileSync(expectedPath, "utf8"),
  );
  assert(
    actual === expected,
    `Expected ${actualPath} to have the same content as ${expectedPath}\n--- actual ---\n${actual}\n--- expected ---\n${expected}`,
  );
}

function runLogged(label, command, opts = {}) {
  const logPath = join(logsDir, `${label}.txt`);
  try {
    const output = execSync(command, {
      cwd: opts.cwd || dir,
      encoding: "utf8",
      timeout: opts.timeout || 120_000,
      input: opts.input,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    writeFileSync(logPath, output);
    if (opts.expectFail) {
      throw new Error(`Expected command to fail but it succeeded: ${command}`);
    }
    return output;
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`;
    writeFileSync(logPath, output);
    if (opts.expectFail) return output;
    const error = new Error(`Command failed: ${command}\nLog: ${logPath}\n${output}`);
    error.stdout = err.stdout;
    error.stderr = err.stderr;
    throw error;
  }
}

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

function assertParseOutput(output, nodeName) {
  const parsed = JSON.parse(output);
  const nodes = parsed.nodes || [];
  assert(
    nodes.some((node) => node.type === "graphNode" && node.nodeName === nodeName),
    `Expected parsed AST to contain node ${nodeName}`,
  );
}

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

  writeFile(dir, "src/basic.agency", `node main() {
  const greeting = "basic-ok"
  print(greeting)
  return greeting
}
`);

  writeFile(dir, "src/pack-target.agency", `node main() {
  const message = "pack-ok"
  print(message)
  return message
}
`);

  writeFile(dir, "src/pack-helper.agency", `export def helper(value: string): string {
  return value + "-local"
}
`);

  writeFile(dir, "src/pack-imports.agency", `import { add } from "std::math"
import { helper } from "./pack-helper.agency"

node main() {
  const sum = add(2, 3)
  const message = helper("pack-imports")
  print(message + "-" + sum)
  return message + "-" + sum
}
`);

  writeFile(dir, "src/trace-target.agency", `node main() {
  const name = "Trace"
  const greeting = "hello " + name
  print(greeting)
  return greeting
}
`);

  writeFile(dir, "src/messy.agency", `node main(){const name="Ada";print("hello "+name);return name}
`);

  writeFile(dir, "src/type-ok.agency", `node main(): string {
  return "type-ok"
}
`);

  writeFile(dir, "src/type-error.agency", `node bad(): number {
  return "oops"
}
`);

  writeFile(dir, "src/type-strict.agency", `node main() {
  const inferred = "strict-error"
  return inferred
}
`);

  writeFile(dir, "src/coverage-target.agency", `node covered(): string {
  const label = "covered"
  return label
}
`);

  writeFile(dir, "src/coverage-target.test.json", JSON.stringify({
    sourceFile: "coverage-target.agency",
    tests: [
      {
        nodeName: "covered",
        input: "",
        expectedOutput: "\"covered\"",
        evaluationCriteria: [{ type: "exact" }],
      },
    ],
  }, null, 2));

  writeFile(dir, "src/coverage-partial.agency", `node covered(): string {
  const label = "covered"
  return label
}

node uncovered(): string {
  const label = "uncovered"
  return label
}
`);

  writeFile(dir, "src/coverage-partial.test.json", JSON.stringify({
    sourceFile: "coverage-partial.agency",
    tests: [
      {
        nodeName: "covered",
        input: "",
        expectedOutput: "\"covered\"",
        evaluationCriteria: [{ type: "exact" }],
      },
    ],
  }, null, 2));

  writeFile(dir, "src/doc-target.agency", `/** @module
  Helpers used by CLI integration tests.
*/

/** A person to greet. */
type Person = {
  name: string
}

/** Build a greeting. */
def greet(person: Person): string {
  return "Hello, " + person.name + "!"
}

/** Return a greeting for Ada. */
node main(): string {
  const person: Person = { name: "Ada" }
  return greet(person)
}
`);

  writeFile(dir, "docs-src/main.agency", `/** Visible docs file. */
node visible(): string {
  return "visible"
}
`);

  writeFile(dir, "docs-src/ignored/skip.agency", `/** Ignored docs file. */
node ignored(): string {
  return "ignored"
}
`);

  writeFile(dir, "agents/nightly.agency", `node main() {
  return "scheduled"
}
`);

  console.log("--- version ---");
  const versionOutput = runLogged("00-version", "npx --no-install agency --version");
  assert(
    /^\d+\.\d+\.\d+\s*$/.test(versionOutput),
    `Expected semver version output, got: ${versionOutput}`,
  );

  console.log("--- compile ---");
  runLogged("01-compile", "npx --no-install agency compile src/basic.agency");
  assertFile(join(dir, "src/basic.js"), "compile should write src/basic.js");
  writeFile(dir, "src/run-compiled.mjs", `import { main } from "./basic.js";
const result = await main();
const value = result?.data ?? result;
if (value !== "basic-ok") {
  console.error("Unexpected compiled result", result);
  process.exit(1);
}
console.log("compiled-ok");
`);
  assertIncludes(
    runLogged("02-compiled-output", "node src/run-compiled.mjs"),
    "compiled-ok",
  );

  runLogged("02b-compile-ts", "npx --no-install agency compile src/basic.agency --ts");
  assertFile(join(dir, "src/basic.ts"), "compile --ts should write src/basic.ts");
  assertIncludes(readText(join(dir, "src/basic.ts")), "// @ts-nocheck");

  console.log("--- run ---");
  assertIncludes(
    runLogged("03-run", "npx --no-install agency run src/basic.agency"),
    "basic-ok",
  );

  console.log("--- pack ---");
  runLogged("04-pack", "npx --no-install agency pack src/pack-target.agency -o packed.mjs");
  assertFile(join(dir, "packed.mjs"), "pack should write packed.mjs");
  assert(statSync(join(dir, "packed.mjs")).size > 0, "packed.mjs should be non-empty");

  const standaloneDir = createTempProject("cli-main-standalone");
  try {
    cpSync(join(dir, "packed.mjs"), join(standaloneDir, "packed.mjs"));
    unlinkSync(join(dir, "packed.mjs"));
    assert(!existsSync(join(standaloneDir, "node_modules")), "standalone directory must not contain node_modules");
    assertIncludes(
      runLogged("05-pack-standalone", "node packed.mjs", { cwd: standaloneDir }),
      "pack-ok",
    );
  } finally {
    cleanup(standaloneDir);
  }

  runLogged(
    "05b-pack-imports",
    "npx --no-install agency pack src/pack-imports.agency -o packed-imports.mjs",
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
      runLogged("05c-pack-imports-standalone", "node packed-imports.mjs", {
        cwd: importsStandaloneDir,
      }),
      "pack-imports-local-5",
    );
  } finally {
    cleanup(importsStandaloneDir);
  }

  const invalidPackTarget = runLogged(
    "05d-pack-invalid-target",
    "npx --no-install agency pack src/pack-target.agency --target browser",
    { expectFail: true },
  );
  assertIncludes(invalidPackTarget, "Unsupported pack target: browser");

  console.log("--- trace ---");
  runLogged("06-trace", "npx --no-install agency trace src/trace-target.agency -o trace-target.trace");
  const tracePath = join(dir, "trace-target.trace");
  assertFile(tracePath, "trace should write trace-target.trace");
  assertTraceFile(tracePath, "src/trace-target.agency");

  runLogged("07-trace-log", "npx --no-install agency trace log trace-target.trace -o trace-events.json");
  assertFile(join(dir, "trace-events.json"), "trace log should write trace-events.json");
  const traceEvents = JSON.parse(readText(join(dir, "trace-events.json")));
  assert(Array.isArray(traceEvents), "trace log output should be an array");
  assert(traceEvents.length > 0, "trace log should contain events");

  console.log("--- fmt ---");
  runLogged("08-fmt-in-place", "npx --no-install agency fmt src/messy.agency -i");
  assertExactFile(join(dir, "src/messy.agency"), join(fixtureDir, "fmt.expected.agency"));

  const formattedOnce = readText(join(dir, "src/messy.agency"));
  runLogged("09-fmt-idempotent", "npx --no-install agency fmt src/messy.agency -i");
  const formattedTwice = readText(join(dir, "src/messy.agency"));
  assert(formattedOnce === formattedTwice, "fmt should be idempotent");

  writeFile(dir, "src/messy-stdout.agency", `node main(){const name="Ada";print("hello "+name);return name}
`);
  const stdoutFormatted = runLogged(
    "09b-fmt-stdout",
    "npx --no-install agency fmt src/messy-stdout.agency",
  );
  assert(
    normalizeOptionalFinalNewline(stdoutFormatted) ===
      normalizeOptionalFinalNewline(readText(join(fixtureDir, "fmt.expected.agency"))),
    "fmt stdout should match the fixture",
  );
  assertIncludes(
    readText(join(dir, "src/messy-stdout.agency")),
    `node main(){const name="Ada";print("hello "+name);return name}`,
  );

  console.log("--- parse ---");
  assertParseOutput(
    runLogged("10-parse", "npx --no-install agency parse src/basic.agency"),
    "main",
  );
  assertParseOutput(
    runLogged("10b-parse-stdin", "npx --no-install agency parse", {
      input: `node stdinMain() {
  return "stdin"
}
`,
    }),
    "stdinMain",
  );

  console.log("--- coverage ---");
  runLogged("11-coverage-generate", "npx --no-install agency test src/coverage-target.agency --coverage");
  const coverageOutput = runLogged(
    "12-coverage-report",
    "npx --no-install agency coverage report src/coverage-target.agency --detail --threshold 100",
  );
  assertFullCoverage(coverageOutput);
  assertFile(join(dir, ".coverage"), "coverage run should create .coverage");
  runLogged("13-coverage-clean", "npx --no-install agency coverage clean");
  assert(!existsSync(join(dir, ".coverage")), "coverage clean should remove .coverage");

  runLogged(
    "13b-coverage-partial-generate",
    "npx --no-install agency test src/coverage-partial.agency --coverage",
  );
  const partialCoverageOutput = runLogged(
    "13c-coverage-partial-report",
    "npx --no-install agency coverage report src/coverage-partial.agency --detail",
  );
  assertPartialCoverage(partialCoverageOutput);
  const thresholdFailure = stripAnsi(runLogged(
    "13d-coverage-threshold-failure",
    "npx --no-install agency coverage report src/coverage-partial.agency --threshold 100",
    { expectFail: true },
  ));
  assertIncludes(thresholdFailure, "below threshold 100%");
  runLogged("13e-coverage-clean-partial", "npx --no-install agency coverage clean");
  assert(!existsSync(join(dir, ".coverage")), "coverage clean should remove partial coverage data");

  console.log("--- tc ---");
  assertIncludes(
    runLogged("14-tc-ok", "npx --no-install agency tc src/type-ok.agency"),
    "No type errors found.",
  );
  const tcError = stripAnsi(runLogged(
    "15-tc-error",
    "npx --no-install agency tc src/type-error.agency",
    { expectFail: true },
  ));
  assertIncludes(tcError, "Type '\"oops\"' is not assignable to type 'number'");
  assertIncludes(tcError, "return in 'bad'");
  assertIncludes(
    runLogged("15b-tc-stdin", "npx --no-install agency tc", {
      input: `node stdinTypecheck(): string {
  return "stdin-ok"
}
`,
    }),
    "No type errors found.",
  );
  const strictError = stripAnsi(runLogged(
    "15c-tc-strict",
    "npx --no-install agency tc src/type-strict.agency --strict",
    { expectFail: true },
  ));
  assertIncludes(strictError, "no type annotation");
  assertIncludes(strictError, "strict mode");

  console.log("--- bundle/unbundle ---");
  runLogged(
    "16-bundle",
    "npx --no-install agency bundle src/trace-target.agency trace-target.trace -o trace-target.bundle",
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

  runLogged("17-unbundle", "npx --no-install agency unbundle trace-target.bundle -o unpacked");
  assertSameFileContent(join(dir, "unpacked/trace-target.agency"), join(dir, "src/trace-target.agency"));
  assertFile(join(dir, "unpacked/trace-target.trace"), "unbundle should write trace-target.trace");
  assertTraceFile(join(dir, "unpacked/trace-target.trace"), "trace-target.agency");

  console.log("--- doc ---");
  runLogged("18-doc", "npx --no-install agency doc src/doc-target.agency -o generated-docs");
  assertExactFile(join(dir, "generated-docs/doc-target.md"), join(fixtureDir, "doc-target.expected.md"));

  runLogged("18b-doc-directory-ignore", "npx --no-install agency doc docs-src -o generated-docs-dir --ignore ignored");
  assertFile(join(dir, "generated-docs-dir/main.md"), "doc directory mode should generate main.md");
  assert(!existsSync(join(dir, "generated-docs-dir/ignored/skip.md")), "doc --ignore should skip ignored directories");

  console.log("--- schedule ---");
  const scheduleEnv = { HOME: join(dir, "__home") };
  runLogged(
    "19-schedule-add-github",
    "npx --no-install agency schedule add agents/nightly.agency --backend github --every hourly --name nightly --no-pin --secret EXTRA_TOKEN",
    { env: scheduleEnv },
  );
  assertExactFile(join(dir, "nightly.yml"), join(fixtureDir, "nightly.expected.yml"));
  const listOutput = runLogged("20-schedule-list", "npx --no-install agency schedule list", { env: scheduleEnv });
  assertIncludes(listOutput, "No scheduled agents");
  const removeOutput = stripAnsi(runLogged(
    "21-schedule-remove-missing",
    "npx --no-install agency schedule remove nightly",
    { env: scheduleEnv, expectFail: true },
  ));
  assertIncludes(removeOutput, "No schedule named \"nightly\"");

  runLogged(
    "22-schedule-cron-github",
    "npx --no-install agency schedule add agents/nightly.agency --backend github --cron \"*/5 * * * *\" --name nightly-cron --no-pin",
    { env: scheduleEnv },
  );
  assertExactFile(join(dir, "nightly-cron.yml"), join(fixtureDir, "nightly-cron.expected.yml"));

  runLogged(
    "23-schedule-write-github",
    "npx --no-install agency schedule add agents/nightly.agency --backend github --every hourly --name nightly-write --no-pin --write",
    { env: scheduleEnv },
  );
  assertExactFile(join(dir, "nightly-write.yml"), join(fixtureDir, "nightly-write.expected.yml"));

  const existingSchedule = stripAnsi(runLogged(
    "24-schedule-existing-failure",
    "npx --no-install agency schedule add agents/nightly.agency --backend github --every hourly --name nightly --no-pin",
    { env: scheduleEnv, expectFail: true },
  ));
  assertIncludes(existingSchedule, "File already exists");

  const invalidBackend = stripAnsi(runLogged(
    "25-schedule-invalid-backend",
    "npx --no-install agency schedule add agents/nightly.agency --backend local --every hourly --name bad",
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
