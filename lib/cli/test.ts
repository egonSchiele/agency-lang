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
};
type Tests = { sourceFile: string; tests: TestCase[] };

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
    tests = { sourceFile: path.basename(agencyFilename), tests: [] };
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

export type TestStats = {
  passed: number;
  failed: number;
  filesPassed: number;
  filesFailed: number;
  failedFiles: string[];
};

function emptyStats(): TestStats {
  return {
    passed: 0,
    failed: 0,
    filesPassed: 0,
    filesFailed: 0,
    failedFiles: [],
  };
}

export function mergeStats(a: TestStats, b: TestStats): TestStats {
  return {
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    filesPassed: a.filesPassed + b.filesPassed,
    filesFailed: a.filesFailed + b.filesFailed,
    failedFiles: [...a.failedFiles, ...b.failedFiles],
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

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onError: (item: T, error: unknown) => R,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      // Safe: nextIndex++ is synchronous and JS is single-threaded,
      // so no two workers can read the same value before the increment.
      const index = nextIndex++;
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

async function runSingleTest(
  config: AgencyConfig,
  testFile: string,
  tests: Tests,
  testCase: TestCase,
  log: Logger,
): Promise<boolean> {
  const hasArgs = testCase.input !== "";
  const relativeSourceFilePath = path.join(
    path.dirname(testFile),
    tests.sourceFile,
  );
  let result: { data: any; stdout: string; stderr: string };
  try {
    result = await executeNodeAsync({
      config,
      agencyFile: relativeSourceFilePath,
      nodeName: testCase.nodeName,
      hasArgs,
      argsString: testCase.input,
      interruptHandlers: testCase.interruptHandlers,
    });
    if (result.stdout) log(result.stdout.trimEnd());
    if (result.stderr) log(result.stderr.trimEnd(), "stderr");
  } catch (e) {
    exitIfSignal(e);
    log(color.red(`  ✗ Test execution error: ${e}`));
    return false;
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
        log("    Expected: " + testCase.expectedOutput);
        log("    Actual:   " + actual);
        testPassed = false;
      }
    } else if (criterion.type === "llmJudge") {
      const actual = JSON.stringify(result.data);
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
  return testPassed;
}

function collectTestFiles(inputPath: string): string[] {
  const fileStats = fs.statSync(inputPath);
  if (!fileStats.isDirectory()) {
    return [inputPath];
  }
  const files: string[] = [];
  for (const { path: filePath } of findRecursively(inputPath, ".test.json")) {
    files.push(filePath);
  }
  return files;
}

async function runTestFile(
  config: AgencyConfig,
  testFile: string,
): Promise<TestStats> {
  const logger = createBufferedLogger();
  const log = logger.log;

  try {
    log(color.yellow(`Running tests for ${testFile}...`));

    const tests: Tests = JSON.parse(fs.readFileSync(testFile, "utf-8"));
    let passed = 0;
    const total = tests.tests.length;

    for (let i = 0; i < total; i++) {
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

      const maxAttempts = (testCase.retry ?? 0) + 1;
      let testPassed = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          log(color.yellow(`  Retry ${attempt - 1}/${testCase.retry}...`));
        }
        try {
          testPassed = await runSingleTest(config, testFile, tests, testCase, log);
          if (testPassed) break;
        } catch (e) {
          exitIfSignal(e);
          log(color.red(`  ✗ Test error: ${e}`));
          testPassed = false;
        }
      }

      if (testPassed) passed++;
    }

    const failed = total - passed;
    log(`\n${passed}/${total} tests passed`);

    return {
      passed,
      failed,
      filesPassed: failed === 0 ? 1 : 0,
      filesFailed: failed === 0 ? 0 : 1,
      failedFiles: failed > 0 ? [testFile] : [],
    };
  } finally {
    logger.flush();
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

  const safeParallel =
    Number.isFinite(parallel) && Number.isInteger(parallel) && parallel > 0
      ? parallel
      : 1;

  const results = await runWithConcurrency(
    testFiles,
    safeParallel,
    (testFile) => runTestFile(config, testFile),
    (testFile, error) => {
      console.error(color.red(`  ✗ Test file error: ${testFile}: ${error}`));
      return {
        passed: 0,
        failed: 1,
        filesPassed: 0,
        filesFailed: 1,
        failedFiles: [testFile],
      };
    },
  );

  let stats = emptyStats();
  for (const result of results) {
    stats = mergeStats(stats, result);
  }
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

export async function testTs(config: AgencyConfig, inputPaths: string[]) {
  const successes: string[] = [];
  const failures: string[] = [];

  for (const inputPath of inputPaths) {
    const testDirs = findTsTestDirs(inputPath);

    if (testDirs.length === 0) {
      console.log(
        color.yellow(`No TypeScript test directories found in ${inputPath}`),
      );
      continue;
    }

    for (const dir of testDirs) {
      const dirName = path.basename(dir);

      if (fs.existsSync(path.join(dir, "skip"))) {
        console.log(color.yellow(`\nSkipping JS test: ${dirName}`));
        continue;
      }

      console.log(color.yellow(`\nRunning JS test: ${dirName}`));

      const agencyFile = findAgencyFile(dir);
      if (!agencyFile) {
        console.log(color.red(`  ✗ No .agency file found in ${dir}`));
        failures.push(dir);
        continue;
      }

      // Compile the .agency file, merging any local agency.json config
      const agencyPath = path.join(dir, agencyFile);
      const localConfigPath = path.join(dir, "agency.json");
      let mergedConfig = config;
      if (fs.existsSync(localConfigPath)) {
        mergedConfig = { ...config, ...loadConfig(localConfigPath) };
      }
      try {
        compile(mergedConfig, agencyPath);
      } catch (e) {
        console.log(color.red(`  ✗ Compilation failed: ${e}`));
        failures.push(dir);
        continue;
      }

      // Execute test.js
      const testFile = "test.js";
      try {
        const { stdout, stderr } = await execFileAsync("node", [testFile], {
          cwd: dir,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (stdout) console.log(stdout.trimEnd());
        if (stderr) console.error(stderr.trimEnd());
      } catch (e) {
        exitIfSignal(e);
        console.log(color.red(`  ✗ Test script execution failed: ${e}`));
        failures.push(dir);
        continue;
      }

      // Read __result.json
      const resultFile = path.join(dir, "__result.json");
      if (!fs.existsSync(resultFile)) {
        console.log(color.red(`  ✗ Test script did not produce __result.json`));
        failures.push(dir);
        continue;
      }

      const result = fs.readFileSync(resultFile, "utf-8");

      // Compare against fixture.json
      const fixtureFile = path.join(dir, "fixture.json");
      if (!fs.existsSync(fixtureFile)) {
        console.log(color.yellow(`  No fixture.json found. Result:`));
        console.log(result);
        const response = await prompts({
          type: "confirm",
          name: "save",
          message: "Save this as the fixture?",
          initial: true,
        });
        if (response.save) {
          fs.writeFileSync(fixtureFile, result);
          console.log(color.green(`  Fixture saved to ${fixtureFile}`));
          successes.push(dir);
        } else {
          failures.push(dir);
        }
      } else {
        const expected = fs.readFileSync(fixtureFile, "utf-8");
        const resultParsed = JSON.parse(result);
        const expectedParsed = JSON.parse(expected);

        if (JSON.stringify(resultParsed) === JSON.stringify(expectedParsed)) {
          console.log(color.green(`  ✓ Fixture match passed`));
          successes.push(dir);
        } else {
          console.log(color.red(`  ✗ Fixture match failed`));
          console.log("    Expected:", JSON.stringify(expectedParsed, null, 2));
          console.log("    Actual:  ", JSON.stringify(resultParsed, null, 2));
          failures.push(dir);
        }
      }
    }
  }

  if (failures.length > 0) {
    console.log("");
    for (const dir of failures) {
      console.log(color.red(` FAIL  ${dir}`));
    }
  }
  console.log(
    `\n${successes.length}/${successes.length + failures.length} TS tests passed`,
  );
  if (failures.length > 0) {
    process.exit(1);
  }
}
