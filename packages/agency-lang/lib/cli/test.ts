import { parseAgency } from "@/parser.js";
import { GraphNodeDefinition } from "@/types.js";
import { getNodesOfType } from "@/utils/node.js";
import fs from "fs";
import prompts from "prompts";
import {
  execFileAsync,
  executeJudgeAsync,
  executeNode,
  executeNodeAsync,
  findRecursively,
  InterruptHandler,
  parseTarget,
  pickANode,
  promptForArgs,
  promptForTarget,
} from "./util.js";
import { color } from "@/utils/termcolors.js";
import { formatDiff } from "@/utils/diff.js";
import { AgencyConfig } from "@/config.js";
import path from "path";
import { compile, loadConfig } from "./commands.js";
type Exact = { type: "exact" };
type LLMJudge = {
  type: "llmJudge";
  judgePrompt: string;
  desiredAccuracy: number;
};
type Criteria = Exact | LLMJudge;
type TestCase = {
  nodeName: string;
  input: string;
  expectedOutput: string;
  evaluationCriteria: Criteria[];
  interruptHandlers?: InterruptHandler[];
  description?: string;
  retry?: number;
  skip?: boolean;
  // Per-test timeout in milliseconds. Overrides the file-level
  // `defaultTimeoutMs`. Falls back to DEFAULT_PER_TEST_MS when unset.
  // Clamped to TIMEOUT_CEILINGS.perTestMs.
  timeoutMs?: number;
};
type Tests = {
  sourceFile?: string;
  tests: TestCase[];
  // If true, skip every test in this file. Equivalent to setting `skip: true`
  // on each test case individually.
  skip?: boolean;
  // Optional human-readable reason for the skip; printed when the file is
  // skipped. No semantic effect.
  skipReason?: string;
  // File-level default timeout (ms) applied to every test in this file
  // unless the individual TestCase sets its own `timeoutMs`. Falls back
  // to DEFAULT_PER_TEST_MS when unset.
  defaultTimeoutMs?: number;
};

// ── Test runner timeout limits ──
// Pattern mirrors LIMIT_CEILINGS in lib/runtime/ipc.ts: hardcoded ceilings
// clamp any user-supplied value so a stray `"timeoutMs": 9999999999` in a
// fixture cannot exceed our per-test or suite-wide caps.
const TIMEOUT_CEILINGS = {
  // A single test cannot consume more than the entire suite budget.
  perTestMs: 30 * 60 * 1000, // 30 minutes
  // Suite-wide ceiling. Not currently user-configurable.
  suiteMs: 30 * 60 * 1000, // 30 minutes
} as const;

const DEFAULT_PER_TEST_MS = 2 * 60 * 1000; // 2 minutes

function resolveTimeoutMs(testCase: TestCase, fileDefaults: Tests): number {
  const requested =
    testCase.timeoutMs ?? fileDefaults.defaultTimeoutMs ?? DEFAULT_PER_TEST_MS;
  return Math.min(requested, TIMEOUT_CEILINGS.perTestMs);
}

// Format a millisecond duration as the largest unit that yields an integer.
// 120000 → "2 minutes", 90000 → "90 seconds", 500 → "500 milliseconds".
function formatTimeout(ms: number): string {
  if (ms % 60000 === 0) {
    const m = ms / 60000;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  return `${ms} millisecond${ms === 1 ? "" : "s"}`;
}

// Detect the rejection shape produced when execFile kills the child due to
// our `timeout` option. Promisified execFile attaches `killed` and `signal`
// to the error.
function isTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as any;
  return err.killed === true && err.signal === "SIGKILL";
}

// Detect the rejection shape produced when execFile is killed via the
// AbortSignal (suite ceiling or SIGINT). Node sets `code === "ABORT_ERR"`
// or surfaces the abort via `signal`.
function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as any;
  return err.name === "AbortError" || err.code === "ABORT_ERR";
}

// ── Suite-wide context ──
// Bundled per the RunSession pattern in lib/runtime/ipc.ts so helpers can
// be passed one object instead of N closure parameters.
type AbortReason = "sigint" | "ceiling";
type SuiteContext = {
  aborted: boolean;
  abortReason: AbortReason | null;
  abortController: AbortController;
  // Files that started running and whose runTestFile() returned normally.
  completed: string[];
  // Files currently being processed by a worker.
  inFlight: Set<string>;
  // Files that exist in the input set but have not yet been picked up.
  // Mutated by workers as they pull items.
  pending: Set<string>;
};

function createSuiteContext(allFiles: string[]): SuiteContext {
  return {
    aborted: false,
    abortReason: null,
    abortController: new AbortController(),
    completed: [],
    inFlight: new Set(),
    pending: new Set(allFiles),
  };
}

function triggerSuiteAbort(suite: SuiteContext, reason: AbortReason): void {
  if (suite.aborted) return;
  suite.aborted = true;
  suite.abortReason = reason;
  suite.abortController.abort();
}

function readFile(filename: string): string {
  console.log("Trying to read file", filename, "...");
  const data = fs.readFileSync(filename);
  const contents = data.toString("utf8");
  return contents;
}

function writeTestCase(
  agencyFilename: string,
  nodeName: string,
  input: string,
  expectedOutput: string,
  evaluationCriteria: Criteria[],
  interruptHandlers?: InterruptHandler[],
) {
  const testFilePath = agencyFilename.replace(".agency", ".test.json");
  let tests: Tests;
  if (fs.existsSync(testFilePath)) {
    tests = JSON.parse(fs.readFileSync(testFilePath, "utf-8"));
  } else {
    tests = { tests: [] };
  }
  const testCase: TestCase = {
    nodeName,
    input,
    expectedOutput,
    evaluationCriteria,
  };
  if (interruptHandlers && interruptHandlers.length > 0) {
    testCase.interruptHandlers = interruptHandlers;
  }
  tests.tests.push(testCase);
  fs.writeFileSync(testFilePath, JSON.stringify(tests, null, 2));
  return testFilePath;
}

const onCancel = () => {
  process.exit(0);
};

function exitIfSignal(e: unknown): void {
  if (
    e instanceof Error &&
    "signal" in e &&
    ((e as any).signal === "SIGINT" || (e as any).signal === "SIGTERM")
  ) {
    process.exit(1);
  }
}

export async function fixtures(config: AgencyConfig, target?: string) {
  let { filename, nodeName } = target
    ? parseTarget(target)
    : await promptForTarget();

  const contents = readFile(filename);
  const parsed = parseAgency(contents);
  if (!parsed.success) {
    console.error(
      "Could not parse agency code in file",
      filename,
      "error:",
      parsed.message,
    );
    return;
  }
  const agencyProgram = parsed.result;
  const body = agencyProgram.nodes;
  const nodes = getNodesOfType(body, "graphNode") as GraphNodeDefinition[];

  if (nodes.length === 0) {
    console.log(
      "No graph nodes found in the program. At least one graph node is required as an entrypoint.",
    );
    return;
  }

  if (!nodeName) {
    nodeName = await pickANode(nodes);
  }

  // Find the selected node and prompt for args
  const selectedNode = nodes.find((n) => n.nodeName === nodeName)!;
  let { hasArgs, argsString } = await promptForArgs(selectedNode);

  console.log("Running program from entrypoint", nodeName);
  let json = executeNode({
    config,
    agencyFile: filename,
    nodeName,
    hasArgs,
    argsString,
  });

  // Handle interrupt discovery
  const interruptHandlers: InterruptHandler[] = [];

  while (
    json.data &&
    typeof json.data === "object" &&
    json.data.type === "interrupt"
  ) {
    console.log(`\n⚠️  Interrupt detected: "${json.data.data}"`);

    const actionResponse = await prompts(
      {
        type: "select",
        name: "action",
        message: "How should the test handle this interrupt?",
        choices: [
          { title: "Approve", value: "approve" },
          { title: "Reject", value: "reject" },
          { title: "Modify arguments", value: "modify" },
          { title: "Resolve (provide value)", value: "resolve" },
        ],
      },
      { onCancel },
    );

    if (!actionResponse.action) {
      console.log("Interrupt handling cancelled.");
      return;
    }

    const handler: InterruptHandler = {
      action: actionResponse.action,
      expectedMessage: json.data.data, // Capture the actual message
    };

    if (actionResponse.action === "resolve") {
      const resolveResponse = await prompts(
        {
          type: "text",
          name: "value",
          message: "Enter the resolved value (JSON or plain string):",
        },
        { onCancel },
      );
      if (resolveResponse.value === undefined) {
        console.log("Interrupt handling cancelled.");
        return;
      }
      try {
        handler.resolvedValue = JSON.parse(resolveResponse.value);
      } catch {
        handler.resolvedValue = resolveResponse.value;
      }
    } else if (actionResponse.action === "modify") {
      let invalidJSON = true;
      while (invalidJSON) {
        const modifyResponse = await prompts(
          {
            type: "text",
            name: "args",
            message: "Enter modified arguments as JSON object:",
          },
          { onCancel },
        );
        if (!modifyResponse.args) {
          console.log("Interrupt handling cancelled.");
          return;
        }
        try {
          handler.modifiedArgs = JSON.parse(modifyResponse.args);
          invalidJSON = false;
        } catch (e) {
          console.error("Invalid JSON:", e);
          return;
        }
      }
    }

    interruptHandlers.push(handler);

    // Continue execution with this handler to see if there are more interrupts
    json = executeNode({
      config,
      agencyFile: filename,
      nodeName,
      hasArgs,
      argsString,
      interruptHandlers,
    });
  }

  console.log("\nFinal Output:");
  console.log(JSON.stringify(json.data, null, 2));

  const correctResponse = await prompts(
    {
      type: "confirm",
      name: "correct",
      message: "Does this output look correct?",
      initial: true,
    },
    { onCancel },
  );

  let expectedOutput: string;
  if (correctResponse.correct) {
    expectedOutput = JSON.stringify(json.data);
  } else {
    const expectedResponse = await prompts(
      {
        type: "text",
        name: "expected",
        message: "What should the correct output look like?",
      },
      { onCancel },
    );
    expectedOutput = expectedResponse.expected;
  }

  const criteriaResponse = await prompts(
    {
      type: "select",
      name: "criteria",
      message: "Select evaluation criteria:",
      choices: [
        { title: "Exact match", value: "exact" },
        { title: "LLM Judge", value: "llmJudge" },
      ],
    },
    { onCancel },
  );

  let criteria: Criteria[];
  if (criteriaResponse.criteria === "exact") {
    criteria = [{ type: "exact" }];
  } else {
    const judgeResponse = await prompts(
      [
        {
          type: "text",
          name: "judgePrompt",
          message: "Enter the judge prompt (what should the LLM evaluate?):",
        },
        {
          type: "number",
          name: "desiredAccuracy",
          message: "Desired accuracy (0-100):",
          initial: 80,
        },
      ],
      { onCancel },
    );
    criteria = [
      {
        type: "llmJudge",
        judgePrompt: judgeResponse.judgePrompt,
        desiredAccuracy: judgeResponse.desiredAccuracy,
      },
    ];
  }

  const inputStr = hasArgs ? argsString : "";
  const testFilePath = writeTestCase(
    filename,
    nodeName,
    inputStr,
    expectedOutput,
    criteria,
    interruptHandlers.length > 0 ? interruptHandlers : undefined,
  );
  console.log(`Test case saved to ${testFilePath}`);
}

export type SlowTest = {
  name: string;
  durationMs: number;
};

export type TestStats = {
  passed: number;
  failed: number;
  filesPassed: number;
  filesFailed: number;
  failedFiles: string[];
  slowTests: SlowTest[];
};

function emptyStats(): TestStats {
  return {
    passed: 0,
    failed: 0,
    filesPassed: 0,
    filesFailed: 0,
    failedFiles: [],
    slowTests: [],
  };
}

export function mergeStats(a: TestStats, b: TestStats): TestStats {
  return {
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    filesPassed: a.filesPassed + b.filesPassed,
    filesFailed: a.filesFailed + b.filesFailed,
    failedFiles: [...a.failedFiles, ...b.failedFiles],
    slowTests: [...a.slowTests, ...b.slowTests],
  };
}

type Logger = (msg: string, stream?: "stdout" | "stderr") => void;

function createBufferedLogger(): { log: Logger; flush: () => void } {
  const lines: { msg: string; stream: "stdout" | "stderr" }[] = [];
  return {
    log: (msg: string, stream: "stdout" | "stderr" = "stdout") =>
      lines.push({ msg, stream }),
    flush: () => {
      for (const line of lines) {
        if (line.stream === "stderr") {
          console.error(line.msg);
        } else {
          console.log(line.msg);
        }
      }
    },
  };
}

function sanitizeParallel(parallel: number): number {
  return Number.isFinite(parallel) && Number.isInteger(parallel) && parallel > 0
    ? parallel
    : 1;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onError: (item: T, error: unknown) => R,
  shouldAbort?: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      // Safe: nextIndex++ is synchronous and JS is single-threaded,
      // so no two workers can read the same value before the increment.
      const index = nextIndex++;
      // Suite abort: stop pulling new items. Items already in flight
      // continue to settle (via their own AbortSignal-killed children),
      // but no new files start.
      if (shouldAbort && shouldAbort()) return;
      try {
        results[index] = await fn(items[index]);
      } catch (e) {
        results[index] = onError(items[index], e);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// Outcome of a single test attempt. "aborted" means the suite-wide
// AbortSignal fired (ceiling or SIGINT) — distinct from a per-test
// timeout, because the runner shouldn't keep retrying or print a per-test
// failure message in that case.
type SingleTestOutcome = "passed" | "failed" | "aborted";

async function runSingleTest(
  config: AgencyConfig,
  testFile: string,
  testCase: TestCase,
  timeoutMs: number,
  signal: AbortSignal,
  log: Logger,
): Promise<SingleTestOutcome> {
  const hasArgs = testCase.input !== "";
  const relativeSourceFilePath = testFile.replace(".test.json", ".agency");
  let result: { data: any; stdout: string; stderr: string };
  try {
    result = await executeNodeAsync({
      config,
      agencyFile: relativeSourceFilePath,
      nodeName: testCase.nodeName,
      hasArgs,
      argsString: testCase.input,
      interruptHandlers: testCase.interruptHandlers,
      timeoutMs,
      signal,
    });
    if (result.stdout) log(result.stdout.trimEnd());
    if (result.stderr) log(result.stderr.trimEnd(), "stderr");
  } catch (e) {
    if (isAbortError(e)) {
      // Don't print a failure — the suite-abort summary will explain.
      return "aborted";
    }
    if (isTimeoutError(e)) {
      log(color.red(`  ✗ Test exceeded ${formatTimeout(timeoutMs)} timeout`));
      return "failed";
    }
    exitIfSignal(e);
    log(color.red(`  ✗ Test execution error: ${e}`));
    return "failed";
  }

  let testPassed = true;
  const baseName = relativeSourceFilePath.replace(".agency", "");
  for (const criterion of testCase.evaluationCriteria) {
    if (criterion.type === "exact") {
      const actual = JSON.stringify(result.data);
      if (actual === testCase.expectedOutput) {
        log(color.green("  ✓ Exact match passed"));
      } else {
        log(color.red("  ✗ Exact match failed"));
        log(formatDiff(testCase.expectedOutput, actual));
        testPassed = false;
      }
    } else if (criterion.type === "llmJudge") {
      const actual = JSON.stringify(result.data) || "undefined";
      try {
        const judgeResult = await executeJudgeAsync(baseName, {
          actualOutput: actual,
          expectedOutput: testCase.expectedOutput,
          judgePrompt: criterion.judgePrompt,
        });
        if (judgeResult.stdout) log(judgeResult.stdout.trimEnd());
        if (judgeResult.stderr) log(judgeResult.stderr.trimEnd(), "stderr");
        const passed = judgeResult.score >= criterion.desiredAccuracy;
        if (passed) {
          log(
            color.green(
              `  ✓ LLM Judge passed (score: ${judgeResult.score}/${criterion.desiredAccuracy})`,
            ),
          );
          log(`    Reasoning: ${judgeResult.reasoning}`);
        } else {
          log(
            color.red(
              `  ✗ LLM Judge failed (score: ${judgeResult.score}/${criterion.desiredAccuracy})`,
            ),
          );
          log(`    Reasoning: ${judgeResult.reasoning}`);
          log(`    Actual Output:\n${actual}`);
          testPassed = false;
        }
      } catch (e) {
        log(color.red(`  ✗ LLM Judge error: ${e}`));
        testPassed = false;
      }
    }
  }
  return testPassed ? "passed" : "failed";
}

function collectTestFiles(inputPath: string): string[] {
  const fileStats = fs.statSync(inputPath);
  if (!fileStats.isDirectory()) {
    if (inputPath.endsWith(".agency")) {
      const testFile = inputPath.replace(/\.agency$/, ".test.json");
      if (!fs.existsSync(testFile)) {
        console.error(`Error: No test file found for '${inputPath}' (expected '${testFile}')`);
        process.exit(1);
      }
      return [testFile];
    }
    return [inputPath];
  }
  const files: string[] = [];
  for (const { path: filePath } of findRecursively(inputPath, ".test.json")) {
    files.push(filePath);
  }
  return files;
}

// Run a single test through its retry loop. Returns the final outcome.
// "aborted" short-circuits the retry loop — no point retrying when the
// suite is shutting down.
async function runTestWithRetries(
  config: AgencyConfig,
  testFile: string,
  testCase: TestCase,
  timeoutMs: number,
  signal: AbortSignal,
  log: Logger,
): Promise<SingleTestOutcome> {
  const maxAttempts = (testCase.retry ?? 0) + 1;
  let outcome: SingleTestOutcome = "failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      log(color.yellow(`  Retry ${attempt - 1}/${testCase.retry}...`));
    }
    try {
      outcome = await runSingleTest(config, testFile, testCase, timeoutMs, signal, log);
      if (outcome === "passed" || outcome === "aborted") break;
    } catch (e) {
      exitIfSignal(e);
      log(color.red(`  ✗ Test error: ${e}`));
      outcome = "failed";
    }
  }
  return outcome;
}

async function runTestFile(
  config: AgencyConfig,
  testFile: string,
  suite: SuiteContext,
): Promise<TestStats> {
  const logger = createBufferedLogger();
  const log = logger.log;

  suite.inFlight.add(testFile);
  suite.pending.delete(testFile);

  try {
    log(color.yellow(`Running tests for ${testFile}...`));

    const tests: Tests = JSON.parse(fs.readFileSync(testFile, "utf-8"));

    let passed = 0;
    const total = tests.tests.length;

    // File-level skip: if the .test.json has `"skip": true` at the top
    // level, skip every test in the file. This makes top-level skip work
    // the way authors typically expect (skip the whole file). The same
    // `skip` field can also be set per test case for finer-grained control.
    if (tests.skip) {
      const reasonStr = tests.skipReason ? ` (${tests.skipReason})` : "";
      log(color.yellow(`  ⊘ Skipped ${total} test(s) in ${testFile}${reasonStr}`));
      return {
        passed: 0,
        failed: 0,
        filesPassed: 1,
        filesFailed: 0,
        failedFiles: [],
        slowTests: [],
      };
    }

    let skipped = 0;
    const slowTests: SlowTest[] = [];
    let aborted = false;

    for (let i = 0; i < total; i++) {
      // Bail between test cases if the suite is aborting. The currently
      // in-flight execFile (if any) is killed via its AbortSignal.
      if (suite.aborted) {
        aborted = true;
        break;
      }

      const testCase = tests.tests[i];
      const interruptInfo = testCase.interruptHandlers
        ? ` interrupts=${testCase.interruptHandlers.length}`
        : "";
      const testNum = color.cyan(`Test ${i + 1}/${total}:`);
      log(
        `\n${testNum} node=${testCase.nodeName} input=${testCase.input || "(none)"}${interruptInfo}`,
      );
      if (testCase.description) {
        log(color.cyan("Description:", testCase.description) + "\n");
      }

      if (testCase.skip) {
        log(color.yellow(`  ⊘ Skipped`));
        skipped++;
        continue;
      }

      const timeoutMs = resolveTimeoutMs(testCase, tests);
      const startTime = performance.now();
      const outcome = await runTestWithRetries(
        config,
        testFile,
        testCase,
        timeoutMs,
        suite.abortController.signal,
        log,
      );
      const durationMs = performance.now() - startTime;

      if (outcome === "aborted") {
        aborted = true;
        break;
      }

      const testName = testCase.description
        ? `${testFile} > ${testCase.nodeName} > ${testCase.description}`
        : `${testFile} > ${testCase.nodeName}(${testCase.input || ""})`;
      slowTests.push({ name: testName, durationMs });

      if (outcome === "passed") passed++;
    }

    const ran = total - skipped;
    const failed = ran - passed;
    const skipMsg = skipped > 0 ? ` (${skipped} skipped)` : "";
    if (!aborted) {
      log(`\n${passed}/${ran} tests passed${skipMsg}`);
      suite.completed.push(testFile);
    } else {
      log(color.yellow(`\n  ⚠️  ${testFile} aborted (${passed}/${ran} tests passed before abort)`));
    }

    return {
      passed,
      failed,
      filesPassed: failed === 0 ? 1 : 0,
      filesFailed: failed === 0 ? 0 : 1,
      failedFiles: failed > 0 ? [testFile] : [],
      slowTests,
    };
  } finally {
    suite.inFlight.delete(testFile);
    logger.flush();
  }
}

// Print the suite-abort summary after the runner has drained.
// Three categories: completed, in-flight when abort fired, never started.
function printSuiteAbortSummary(suite: SuiteContext): void {
  const header =
    suite.abortReason === "sigint"
      ? "⚠️  Interrupted by user"
      : `⚠️  Suite-wide timeout of ${formatTimeout(TIMEOUT_CEILINGS.suiteMs)} exceeded`;
  console.log(color.yellow(`\n${header}. Aborting.\n`));

  if (suite.completed.length > 0) {
    console.log("Completed test files:");
    for (const f of suite.completed) console.log(`  ✓ ${f}`);
  }
  if (suite.inFlight.size > 0) {
    console.log("\nTest files in flight when aborted:");
    for (const f of suite.inFlight) console.log(color.yellow(`  - ${f}`));
  }
  if (suite.pending.size > 0) {
    console.log("\nTest files that did not start:");
    for (const f of suite.pending) console.log(color.yellow(`  - ${f}`));
  }
}

export async function test(
  config: AgencyConfig,
  inputPaths: string[],
  parallel: number = 1,
): Promise<TestStats> {
  const testFiles: string[] = [];
  for (const inputPath of inputPaths) {
    testFiles.push(...collectTestFiles(inputPath));
  }

  const suite = createSuiteContext(testFiles);

  // Suite-wide ceiling. When fired, flips the abort flag, which causes:
  //   - workers to stop pulling new files (runWithConcurrency check)
  //   - in-flight execFile children to be SIGKILL'd (AbortSignal)
  //   - runTestFile loops to break between cases
  const ceilingTimer = setTimeout(() => {
    triggerSuiteAbort(suite, "ceiling");
  }, TIMEOUT_CEILINGS.suiteMs);
  // Don't keep the process alive just for this timer.
  ceilingTimer.unref?.();

  // Graceful Ctrl+C: first SIGINT triggers the same drain-and-summarize
  // flow as the ceiling. A SECOND SIGINT falls through to Node's default
  // handler (immediate exit) — critical safety valve so the user can
  // always escape if our drain logic itself hangs.
  const sigintHandler = () => {
    triggerSuiteAbort(suite, "sigint");
  };
  process.once("SIGINT", sigintHandler);

  let results: TestStats[] = [];
  try {
    results = await runWithConcurrency(
      testFiles,
      sanitizeParallel(parallel),
      (testFile) => runTestFile(config, testFile, suite),
      (testFile, error) => {
        console.error(color.red(`  ✗ Test file error: ${testFile}: ${error}`));
        return {
          passed: 0,
          failed: 1,
          filesPassed: 0,
          filesFailed: 1,
          failedFiles: [testFile],
          slowTests: [],
        };
      },
      () => suite.aborted,
    );
  } finally {
    clearTimeout(ceilingTimer);
    process.removeListener("SIGINT", sigintHandler);
  }

  let stats = emptyStats();
  for (const result of results) {
    if (result) stats = mergeStats(stats, result);
  }

  if (suite.aborted) printSuiteAbortSummary(suite);

  return stats;
}

function findTsTestDirs(_inputPath: string): string[] {
  const stats = fs.statSync(_inputPath);
  let inputPath = _inputPath;
  if (!stats.isDirectory()) {
    if (inputPath.endsWith("test.js")) {
      inputPath = path.dirname(inputPath);
    } else {
      console.error(`Error: ${inputPath} is not a directory or a test.js file`);
      process.exit(1);
    }
  }

  // Check if inputPath itself is a test dir (contains test.js)
  if (fs.existsSync(path.join(inputPath, "test.js"))) {
    return [inputPath];
  }

  // Otherwise find subdirectories containing test.js
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(inputPath)) {
    const fullPath = path.join(inputPath, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      dirs.push(...findTsTestDirs(fullPath));
    }
  }
  return dirs;
}

function findAgencyFile(dir: string): string | null {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".agency"));
  return files.length > 0 ? files[0] : null;
}

async function runTsTestDir(
  config: AgencyConfig,
  dir: string,
): Promise<{ success: boolean; dir: string }> {
  const logger = createBufferedLogger();
  const log = logger.log;

  try {
    const dirName = path.basename(dir);

    if (fs.existsSync(path.join(dir, "skip"))) {
      log(color.yellow(`\nSkipping JS test: ${dirName}`));
      return { success: true, dir };
    }

    log(color.yellow(`\nRunning JS test: ${dirName}`));

    const agencyFile = findAgencyFile(dir);
    if (!agencyFile) {
      log(color.red(`  ✗ No .agency file found in ${dir}`));
      return { success: false, dir };
    }

    const agencyPath = path.join(dir, agencyFile);
    const localConfigPath = path.join(dir, "agency.json");
    let mergedConfig = config;
    if (fs.existsSync(localConfigPath)) {
      mergedConfig = { ...config, ...loadConfig(localConfigPath) };
    }
    try {
      compile(mergedConfig, agencyPath);
    } catch (e) {
      log(color.red(`  ✗ Compilation failed: ${e}`));
      return { success: false, dir };
    }

    // Remove stale result file from previous runs
    const resultFile = path.join(dir, "__result.json");
    try { fs.unlinkSync(resultFile); } catch { }

    const testFile = "test.js";
    try {
      const { stdout, stderr } = await execFileAsync("node", [testFile], {
        cwd: dir,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stdout) log(stdout.trimEnd());
      if (stderr) log(stderr.trimEnd(), "stderr");
    } catch (e) {
      exitIfSignal(e);
      log(color.red(`  ✗ Test script execution failed: ${e}`));
      return { success: false, dir };
    }

    if (!fs.existsSync(resultFile)) {
      log(color.red(`  ✗ Test script did not produce __result.json`));
      return { success: false, dir };
    }

    const result = fs.readFileSync(resultFile, "utf-8");
    const fixtureFile = path.join(dir, "fixture.json");

    if (!fs.existsSync(fixtureFile)) {
      log(color.yellow(`  No fixture.json found. Result:`));
      log(result);
      log(color.red(`  ✗ No fixture to compare against`));
      return { success: false, dir };
    }

    const expected = fs.readFileSync(fixtureFile, "utf-8");
    const resultParsed = JSON.parse(result);
    const expectedParsed = JSON.parse(expected);

    if (JSON.stringify(resultParsed) === JSON.stringify(expectedParsed)) {
      log(color.green(`  ✓ Fixture match passed`));
      return { success: true, dir };
    } else {
      log(color.red(`  ✗ Fixture match failed`));
      log(formatDiff(
        JSON.stringify(expectedParsed, null, 2),
        JSON.stringify(resultParsed, null, 2),
      ));
      return { success: false, dir };
    }
  } finally {
    logger.flush();
  }
}

export async function testTs(config: AgencyConfig, inputPaths: string[], parallel: number = 1) {
  const allDirs: string[] = [];
  for (const inputPath of inputPaths) {
    const testDirs = findTsTestDirs(inputPath);
    if (testDirs.length === 0) {
      console.log(
        color.yellow(`No TypeScript test directories found in ${inputPath}`),
      );
    } else {
      allDirs.push(...testDirs);
    }
  }

  const results = await runWithConcurrency(
    allDirs,
    sanitizeParallel(parallel),
    (dir) => runTsTestDir(config, dir),
    (dir, error) => {
      console.error(color.red(`  ✗ JS test error: ${dir}: ${error}`));
      return { success: false, dir };
    },
  );

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  if (failures.length > 0) {
    console.log("");
    for (const { dir } of failures) {
      console.log(color.red(` FAIL  ${dir}`));
    }
  }
  console.log(
    `\n${successes.length}/${results.length} TS tests passed`,
  );
  if (failures.length > 0) {
    process.exit(1);
  }
}
