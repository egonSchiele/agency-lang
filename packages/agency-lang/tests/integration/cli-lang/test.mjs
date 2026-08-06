// Per-PR integration tests for the deterministic language CLI commands.
// Runs from a fresh temp project with agency-lang installed from an npm pack
// tarball. Every command is offline and deterministic: no model or network
// calls, no secrets, no server, no interactive prompt. This is a fast per-PR
// packaging gate; deep behavior lives in unit tests and the main-only
// cli-main runner.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assert,
  assertIncludes,
  cleanup,
  createTempProject,
  getTarballPath,
  initProject,
  installTarball,
  runInstalledAgency,
  writeFile,
} from "../helpers.mjs";

const tarball = resolve(getTarballPath());
const dir = createTempProject("cli-lang");

// The CLI emits ANSI color even when stdout is piped, so strip it before any
// substring assertion. JSON-producing commands emit plain output, so stripping
// is a no-op there.
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function assertBlank(text, label) {
  assert(stripAnsi(text).trim() === "", `${label} should be empty, got:\n${text}`);
}

function normalizeTrailingNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
}

function walkNodes(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    visit(value);
    for (const key of Object.keys(value)) walkNodes(value[key], visit);
  }
}

// --- Fixtures -------------------------------------------------------------

const typecheckGood = `node typecheckGood(): number {
  return 42
}
`;

const typecheckBad = `def takesNumber(value: number): number {
  return value
}

node typecheckBad(): number {
  return takesNumber("oops")
}
`;

const formatMessy = `node formatProbe(){const answer=40+2
return answer}
`;

const formatExpected = `node formatProbe() {
  const answer = 40 + 2
  return answer
}
`;

const lintProbe = `import { map } from "std::array"

node lintProbe(): number {
  return 1
}
`;

const astPreprocessProbe = `def identity(value: string): string {
  return value
}

node preprocessProbe(): string {
  return identity("ok")
}
`;

// The body carries a unique sentinel found nowhere in the signature or
// docstring. `doc` documents the public API, not the body, so the sentinel must
// be absent from the generated Markdown — a check that survives any body
// reformatting a broken generator might apply.
const docProbe = `export def greet(name: string): string {
  """Greet a person by name."""
  return "Hello, " + name + " DOC_BODY_SENTINEL"
}
`;

const diagnosticsBad = `def brokenParams(first: string; second: string) {}
`;

const diagnosticsGood = `def joinStrings(first: string, second: string): string {
  return first + second
}
`;

// A RECOVERABLE parse failure (not a thrown TarsecError). The old diagnostics
// path emitted nothing for these; the whole point of this PR's change is that
// they now produce JSON. The bad token is on the second line, so this also
// proves line mapping rather than only column mapping on line 0.
const diagnosticsRecoverable = `const x = 5
!!!
`;

// outDir + log.projectId are echoed by `config show`. verbose is deliberately
// omitted: it writes a config-loading notice to stderr, which would break the
// quiet-stderr assertion below.
const configProbe = `${JSON.stringify(
  { outDir: "plan-probe-dist", log: { projectId: "plan-probe" } },
  null,
  2,
)}
`;

// --- Declarative simple command contracts ---------------------------------

const commandCases = [
  {
    name: "typecheck accepts valid input",
    args: ["typecheck", "typecheck-good.agency"],
    expectedStatus: 0,
    stdoutIncludes: ["No type errors found."],
    stderrIncludes: [],
    stdoutEmpty: false,
    stderrEmpty: true,
  },
  {
    name: "typecheck rejects a wrong argument type",
    args: ["typecheck", "typecheck-bad.agency"],
    expectedStatus: 1,
    stdoutIncludes: [],
    stderrIncludes: ["AG6019", "takesNumber", "oops", "number"],
    stdoutEmpty: true,
    stderrEmpty: false,
  },
  {
    name: "lint reports an unused import without failing",
    args: ["lint", "lint-probe.agency"],
    expectedStatus: 0,
    stdoutIncludes: ["lint-probe.agency", "AL0001", "map", "never used"],
    stderrIncludes: [],
    stdoutEmpty: false,
    stderrEmpty: true,
  },
  {
    name: "explain renders AG2005",
    args: ["explain", "AG2005"],
    expectedStatus: 0,
    stdoutIncludes: ["AG2005", "typeNotAssignable", "severity:", "not assignable"],
    stderrIncludes: [],
    stdoutEmpty: false,
    stderrEmpty: true,
  },
];

function runCommandCase(testCase) {
  const { stdout, stderr } = runInstalledAgency(dir, testCase.args, {
    expectedStatus: testCase.expectedStatus,
  });
  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);
  for (const needle of testCase.stdoutIncludes) {
    assertIncludes(out, needle, `[${testCase.name}] stdout missing "${needle}"\n${out}`);
  }
  for (const needle of testCase.stderrIncludes) {
    assertIncludes(err, needle, `[${testCase.name}] stderr missing "${needle}"\n${err}`);
  }
  if (testCase.stdoutEmpty) assertBlank(stdout, `[${testCase.name}] stdout`);
  if (testCase.stderrEmpty) assertBlank(stderr, `[${testCase.name}] stderr`);
  console.log(`[cli-lang] ${testCase.name} ✓`);
}

// --- Behavioral checks with independent oracles ---------------------------

function checkFormat() {
  const original = readFileSync(join(dir, "format-probe.agency"), "utf8");

  const stdoutResult = runInstalledAgency(dir, ["format", "format-probe.agency"]);
  assertBlank(stdoutResult.stderr, "[format stdout mode] stderr");
  assert(
    normalizeTrailingNewlines(stdoutResult.stdout) === normalizeTrailingNewlines(formatExpected),
    `[format stdout mode] output did not match the expected canonical source:\n${stdoutResult.stdout}`,
  );
  assert(
    readFileSync(join(dir, "format-probe.agency"), "utf8") === original,
    "[format stdout mode] must not modify the file",
  );

  const inPlace = runInstalledAgency(dir, ["format", "-i", "format-probe.agency"]);
  assertIncludes(stripAnsi(inPlace.stdout), "Formatted: format-probe.agency", "[format -i] message");
  assertBlank(inPlace.stderr, "[format -i] stderr");
  const afterFirst = readFileSync(join(dir, "format-probe.agency"), "utf8");
  assert(afterFirst !== original, "[format -i] must rewrite the file");
  assert(
    normalizeTrailingNewlines(afterFirst) === normalizeTrailingNewlines(formatExpected),
    "[format -i] file content did not match the expected canonical source",
  );

  runInstalledAgency(dir, ["format", "-i", "format-probe.agency"]);
  assert(
    readFileSync(join(dir, "format-probe.agency"), "utf8") === afterFirst,
    "[format -i] second run must be idempotent",
  );
  console.log("[cli-lang] format behavior ✓");
}

function checkAstPreprocess() {
  const astResult = runInstalledAgency(dir, ["ast", "ast-preprocess-probe.agency"]);
  assertBlank(astResult.stderr, "[ast] stderr");
  const ast = JSON.parse(astResult.stdout);
  assert(ast.type === "agencyProgram", "ast must emit an agencyProgram");
  assert(
    ast.nodes.some((node) => node.type === "graphNode" && node.nodeName === "preprocessProbe"),
    "ast must contain the preprocessProbe graph node",
  );
  let astHasScope = false;
  walkNodes(ast, (node) => {
    if (Object.prototype.hasOwnProperty.call(node, "scope")) astHasScope = true;
  });
  assert(!astHasScope, "raw ast must not carry preprocessor scope annotations");

  const preResult = runInstalledAgency(dir, ["preprocess", "ast-preprocess-probe.agency"]);
  assertBlank(preResult.stderr, "[preprocess] stderr");
  const pre = JSON.parse(preResult.stdout);
  assert(pre.type === "agencyProgram", "preprocess must emit an agencyProgram");
  let preHasArgsScope = false;
  walkNodes(pre, (node) => {
    if (node.scope === "args") preHasArgsScope = true;
  });
  assert(
    preHasArgsScope,
    "preprocess must annotate a parameter reference with args scope (proves it is not the raw parser)",
  );
  console.log("[cli-lang] ast/preprocess behavior ✓");
}

function checkDoc() {
  const result = runInstalledAgency(dir, ["doc", "doc-probe.agency", "-o", "generated-docs"]);
  assertBlank(result.stdout, "[doc] stdout");
  assertBlank(result.stderr, "[doc] stderr");
  const docPath = join(dir, "generated-docs", "doc-probe.md");
  assert(existsSync(docPath), `[doc] expected generated file at ${docPath}`);
  const doc = readFileSync(docPath, "utf8");
  assertIncludes(doc, 'name: "doc-probe"');
  assertIncludes(doc, "# doc-probe");
  assertIncludes(doc, "## Functions");
  assertIncludes(doc, "### greet");
  assertIncludes(doc, "```ts\ngreet(name: string): string\n```");
  assertIncludes(doc, "Greet a person by name.");
  assert(!doc.includes("DOC_BODY_SENTINEL"), "[doc] must not copy the function body into the docs");
  console.log("[cli-lang] doc behavior ✓");
}

function checkConfig() {
  const result = runInstalledAgency(dir, ["-c", "config-probe.json", "config", "show"]);
  assertBlank(result.stderr, "[config show] stderr");
  const config = JSON.parse(result.stdout);
  assert(config.outDir === "plan-probe-dist", `[config show] outDir was ${config.outDir}`);
  assert(config.log?.projectId === "plan-probe", `[config show] projectId was ${config.log?.projectId}`);
  console.log("[cli-lang] config show behavior ✓");
}

function checkDiagnostics() {
  // The expected location is derived from the fixture rather than hard-coded.
  const markerOffset = diagnosticsBad.indexOf(";");
  const beforeMarker = diagnosticsBad.slice(0, markerOffset);
  const expectedLine = beforeMarker.split("\n").length - 1;
  const previousNewline = beforeMarker.lastIndexOf("\n");
  const expectedColumn =
    previousNewline === -1 ? beforeMarker.length : beforeMarker.length - previousNewline - 1;

  const badResult = runInstalledAgency(dir, ["diagnostics", "diagnostics-bad.agency"]);
  assertBlank(badResult.stderr, "[diagnostics error] stderr");
  const diagnostic = JSON.parse(badResult.stdout);
  assert(diagnostic.line === expectedLine, `[diagnostics] line was ${diagnostic.line}, expected ${expectedLine}`);
  assert(
    diagnostic.column === expectedColumn,
    `[diagnostics] column was ${diagnostic.column}, expected ${expectedColumn}`,
  );
  assert(diagnostic.length === 1, `[diagnostics] length was ${diagnostic.length}`);
  assert(
    typeof diagnostic.message === "string" && diagnostic.message.length > 0,
    "[diagnostics] message must be a non-empty string",
  );
  assert(
    typeof diagnostic.prettyMessage === "string" && diagnostic.prettyMessage.length > 0,
    "[diagnostics] prettyMessage must be a non-empty string",
  );
  assertIncludes(diagnostic.message, "expected `,` between parameters");

  const goodResult = runInstalledAgency(dir, ["diagnostics", "diagnostics-good.agency"]);
  assertBlank(goodResult.stdout, "[diagnostics valid] stdout");
  assertBlank(goodResult.stderr, "[diagnostics valid] stderr");

  // Recoverable failure: proves the non-committed branch emits JSON and that
  // line mapping works (the bad token is on the second line).
  const recoverableLine = diagnosticsRecoverable.slice(0, diagnosticsRecoverable.indexOf("!!!")).split("\n").length - 1;
  const recResult = runInstalledAgency(dir, ["diagnostics", "diagnostics-recoverable.agency"]);
  assertBlank(recResult.stderr, "[diagnostics recoverable] stderr");
  const recDiagnostic = JSON.parse(recResult.stdout);
  assert(
    recDiagnostic.line === recoverableLine,
    `[diagnostics recoverable] line was ${recDiagnostic.line}, expected ${recoverableLine}`,
  );
  assert(recDiagnostic.length === 1, `[diagnostics recoverable] length was ${recDiagnostic.length}`);
  assert(
    typeof recDiagnostic.message === "string" && recDiagnostic.message.length > 0,
    "[diagnostics recoverable] message must be a non-empty string",
  );
  // prettyMessage carries a 1-indexed "Line N" prefix, so this confirms the
  // reported line rather than only the column.
  assertIncludes(recDiagnostic.prettyMessage, `Line ${recoverableLine + 1}`);
  console.log("[cli-lang] diagnostics behavior ✓");
}

// --- Run everything -------------------------------------------------------

try {
  initProject(dir);
  installTarball(dir, tarball);

  writeFile(dir, "typecheck-good.agency", typecheckGood);
  writeFile(dir, "typecheck-bad.agency", typecheckBad);
  writeFile(dir, "format-probe.agency", formatMessy);
  writeFile(dir, "lint-probe.agency", lintProbe);
  writeFile(dir, "ast-preprocess-probe.agency", astPreprocessProbe);
  writeFile(dir, "doc-probe.agency", docProbe);
  writeFile(dir, "diagnostics-bad.agency", diagnosticsBad);
  writeFile(dir, "diagnostics-good.agency", diagnosticsGood);
  writeFile(dir, "diagnostics-recoverable.agency", diagnosticsRecoverable);
  writeFile(dir, "config-probe.json", configProbe);

  for (const testCase of commandCases) runCommandCase(testCase);
  checkFormat();
  checkAstPreprocess();
  checkDoc();
  checkConfig();
  checkDiagnostics();

  console.log("=== cli-lang test passed ===");
  cleanup(dir);
} catch (err) {
  console.error("cli-lang test failed:", err);
  console.error("Temp directory preserved at:", dir);
  process.exit(1);
}
