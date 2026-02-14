import { parseAgency } from "@/parser.js";
import { GraphNodeDefinition } from "@/types.js";
import { getNodesOfType } from "@/utils/node.js";
import fs from "fs";
import prompts from "prompts";
import {
  executeJudge,
  executeNode,
  parseTarget,
  pickANode,
  promptForArgs,
  promptForTarget,
} from "./util.js";

type Exact = { type: "exact" };
type LLMJudge = {
  type: "llmJudge";
  judgePrompt: string;
  desiredAccuracy: number;
};
type Criteria = Exact | LLMJudge;
type InterruptHandler = {
  action: "approve" | "reject" | "modify";
  modifiedArgs?: Record<string, any>;
  expectedMessage?: string;
};
type TestCase = {
  nodeName: string;
  input: string;
  expectedOutput: string;
  evaluationCriteria: Criteria[];
  interruptHandlers?: InterruptHandler[];
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
    tests = { sourceFile: agencyFilename, tests: [] };
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

export async function fixtures(target?: string) {
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
  let json = executeNode(filename, nodeName, hasArgs, argsString);

  // Handle interrupt discovery
  const interruptHandlers: InterruptHandler[] = [];

  while (json.data && typeof json.data === "object" && json.data.type === "interrupt") {
    console.log(`\n⚠️  Interrupt detected: "${json.data.data}"`);

    const actionResponse = await prompts({
      type: "select",
      name: "action",
      message: "How should the test handle this interrupt?",
      choices: [
        { title: "Approve", value: "approve" },
        { title: "Reject", value: "reject" },
        { title: "Modify arguments", value: "modify" },
      ],
    });

    if (!actionResponse.action) {
      console.log("Interrupt handling cancelled.");
      return;
    }

    const handler: InterruptHandler = {
      action: actionResponse.action,
      expectedMessage: json.data.data, // Capture the actual message
    };

    if (actionResponse.action === "modify") {
      const modifyResponse = await prompts({
        type: "text",
        name: "args",
        message: "Enter modified arguments as JSON object:",
      });
      if (!modifyResponse.args) {
        console.log("Interrupt handling cancelled.");
        return;
      }
      try {
        handler.modifiedArgs = JSON.parse(modifyResponse.args);
      } catch (e) {
        console.error("Invalid JSON:", e);
        return;
      }
    }

    interruptHandlers.push(handler);

    // Continue execution with this handler to see if there are more interrupts
    json = executeNode(filename, nodeName, hasArgs, argsString, interruptHandlers);
  }

  console.log("\nFinal Output:");
  console.log(JSON.stringify(json.data, null, 2));

  const correctResponse = await prompts({
    type: "confirm",
    name: "correct",
    message: "Does this output look correct?",
    initial: true,
  });

  let expectedOutput: string;
  if (correctResponse.correct) {
    expectedOutput = JSON.stringify(json.data);
  } else {
    const expectedResponse = await prompts({
      type: "text",
      name: "expected",
      message: "What should the correct output look like?",
    });
    expectedOutput = expectedResponse.expected;
  }

  const criteriaResponse = await prompts({
    type: "select",
    name: "criteria",
    message: "Select evaluation criteria:",
    choices: [
      { title: "Exact match", value: "exact" },
      { title: "LLM Judge", value: "llmJudge" },
    ],
  });

  let criteria: Criteria[];
  if (criteriaResponse.criteria === "exact") {
    criteria = [{ type: "exact" }];
  } else {
    const judgeResponse = await prompts([
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
    ]);
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

export async function test(testFile?: string) {
  let selectedFile: string;

  if (testFile) {
    selectedFile = testFile;
  } else {
    const testFiles = fs
      .readdirSync(process.cwd())
      .filter((file) => file.endsWith(".test.json"))
      .map((file) => ({
        title: file,
        value: file,
      }));

    if (testFiles.length === 0) {
      console.log("No .test.json files found in the current directory.");
      return;
    }

    const response = await prompts({
      type: "select",
      name: "filename",
      message: "Select a test file to run:",
      choices: testFiles,
    });

    if (!response.filename) return;
    selectedFile = response.filename;
  }

  const tests: Tests = JSON.parse(fs.readFileSync(selectedFile, "utf-8"));
  let passed = 0;
  const total = tests.tests.length;

  for (let i = 0; i < total; i++) {
    const testCase = tests.tests[i];
    const hasArgs = testCase.input !== "";
    const interruptInfo = testCase.interruptHandlers
      ? ` interrupts=${testCase.interruptHandlers.length}`
      : "";
    console.log(
      `\nTest ${i + 1}/${total}: node=${testCase.nodeName} input=${testCase.input || "(none)"}${interruptInfo}`,
    );

    const result = executeNode(
      tests.sourceFile,
      testCase.nodeName,
      hasArgs,
      testCase.input,
      testCase.interruptHandlers,
    );

    let testPassed = true;
    for (const criterion of testCase.evaluationCriteria) {
      if (criterion.type === "exact") {
        const actual = JSON.stringify(result.data);
        if (actual === testCase.expectedOutput) {
          console.log("  ✓ Exact match passed");
        } else {
          console.log("  ✗ Exact match failed");
          console.log("    Expected:", testCase.expectedOutput);
          console.log("    Actual:  ", actual);
          testPassed = false;
        }
      } else if (criterion.type === "llmJudge") {
        const actual = JSON.stringify(result.data);
        try {
          const judgeResult = executeJudge(
            actual,
            testCase.expectedOutput,
            criterion.judgePrompt,
          );
          if (judgeResult.score >= criterion.desiredAccuracy) {
            console.log(
              `  ✓ LLM Judge passed (score: ${judgeResult.score}/${criterion.desiredAccuracy})`,
            );
            console.log(`    Reasoning: ${judgeResult.reasoning}`);
          } else {
            console.log(
              `  ✗ LLM Judge failed (score: ${judgeResult.score}/${criterion.desiredAccuracy})`,
            );
            console.log(`    Reasoning: ${judgeResult.reasoning}`);
            testPassed = false;
          }
        } catch (e) {
          console.log(`  ✗ LLM Judge error: ${e}`);
          testPassed = false;
        }
      }
    }

    if (testPassed) passed++;
  }

  console.log(`\n${passed}/${total} tests passed`);
}
