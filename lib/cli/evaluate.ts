import prompts from "prompts";
import fs, { readFileSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { agencyParser, parseAgency } from "@/parser.js";
import { getNodesOfType } from "@/utils/node.js";
import { GraphNodeDefinition, VariableType } from "@/types.js";
import { compile } from "./commands.js";
import renderEvaluate from "@/templates/cli/evaluate.js";
import { exit } from "process";

type Exact = { type: "exact" };
type LLMJudge = { type: "llmJudge"; judgePrompt: string; desiredAccuracy: number };
type Criteria = Exact | LLMJudge;
type TestCase = { nodeName: string; input: string; expectedOutput: string; evaluationCriteria: Criteria[] };
type Tests = { sourceFile: string; tests: TestCase[] };

function readFile(filename: string): string {
  console.log("Trying to read file", filename, "...");
  const data = fs.readFileSync(filename);
  const contents = data.toString("utf8");
  return contents;
}

function formatTypeHint(vt: VariableType): string {
  switch (vt.type) {
    case "primitiveType":
      return vt.value;
    case "arrayType":
      return `${formatTypeHint(vt.elementType)}[]`;
    case "stringLiteralType":
      return `"${vt.value}"`;
    case "numberLiteralType":
      return vt.value;
    case "booleanLiteralType":
      return vt.value;
    case "unionType":
      return vt.types.map(formatTypeHint).join(" | ");
    case "objectType":
      return `{ ${vt.properties.map((p) => `${p.key}: ${formatTypeHint(p.value)}`).join(", ")} }`;
    case "typeAliasVariable":
      return vt.aliasName;
  }
}

function serializeArgValue(value: string): string {
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return value;
  if (value === "true" || value === "false") return value;
  return JSON.stringify(value);
}

function writeTestCase(
  agencyFilename: string,
  nodeName: string,
  input: string,
  expectedOutput: string,
  evaluationCriteria: Criteria[],
) {
  const testFilePath = agencyFilename.replace(".agency", ".test.json");
  let tests: Tests;
  if (fs.existsSync(testFilePath)) {
    tests = JSON.parse(fs.readFileSync(testFilePath, "utf-8"));
  } else {
    tests = { sourceFile: agencyFilename, tests: [] };
  }
  tests.tests.push({ nodeName, input, expectedOutput, evaluationCriteria });
  fs.writeFileSync(testFilePath, JSON.stringify(tests, null, 2));
  return testFilePath;
}

function executeNode(
  agencyFile: string,
  nodeName: string,
  hasArgs: boolean,
  argsString: string,
): { data: any; [key: string]: any } {
  const outFile = agencyFile.replace(".agency", ".ts");
  compile({}, agencyFile, outFile);
  const evaluateScript = renderEvaluate({
    filename: outFile,
    nodeName,
    hasArgs,
    args: argsString,
  });
  const evaluateFile = "__evaluate.ts";
  fs.writeFileSync(evaluateFile, evaluateScript);
  execSync(`npx tsx ${evaluateFile}`, { stdio: "inherit" });
  const results = readFileSync("__evaluate.json", "utf-8");
  return JSON.parse(results);
}

export async function evaluate(target?: string) {
  let filename: string;
  let nodeName: string = "";

  if (target) {
    // Parse "file.agency:nodeName" format
    const colonIndex = target.lastIndexOf(":");
    if (colonIndex === -1) {
      console.error("Error: target must be in the format file.agency:nodeName");
      return;
    }
    filename = target.slice(0, colonIndex);
    nodeName = target.slice(colonIndex + 1);
  } else {
    // Find all .agency files in the current directory
    const agencyFiles = fs
      .readdirSync(process.cwd())
      .filter((file) => file.endsWith(".agency"))
      .map((file) => ({
        title: file,
        value: file,
      }));

    const choices = [
      { title: "📝 Enter custom filename...", value: "__custom__" },
      ...agencyFiles,
    ];

    const response = await prompts({
      type: "select",
      name: "filename",
      message: "Select an Agency file to read:",
      choices: choices,
    });

    filename = response.filename;

    // If user chose custom option, prompt for filename
    if (filename === "__custom__") {
      const customResponse = await prompts({
        type: "text",
        name: "filename",
        message: "Enter the filename to read:",
      });
      filename = customResponse.filename;
    }
  }

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

  if (!target) {
    const response2 = await prompts({
      type: "select",
      name: "node",
      message: "Pick a node:",
      choices: nodes.map((node) => ({
        title: node.nodeName,
        value: node.nodeName,
      })),
    });
    nodeName = response2.node;
  }

  // Find the selected node and prompt for args
  const selectedNode = nodes.find((n) => n.nodeName === nodeName)!;
  let hasArgs = false;
  let argsString = "";

  if (selectedNode.parameters.length > 0) {
    const paramNames = selectedNode.parameters
      .map((p) => p.name)
      .join(", ");
    const confirmArgs = await prompts({
      type: "confirm",
      name: "provideArgs",
      message: `This node has parameters (${paramNames}). Provide arguments?`,
      initial: true,
    });

    if (confirmArgs.provideArgs) {
      const argValues: string[] = [];
      for (const param of selectedNode.parameters) {
        const typeLabel = param.typeHint
          ? ` (${formatTypeHint(param.typeHint)})`
          : "";
        const argResponse = await prompts({
          type: "text",
          name: "value",
          message: `Value for ${param.name}${typeLabel}:`,
        });
        argValues.push(serializeArgValue(argResponse.value));
      }
      argsString = argValues.join(", ");
      hasArgs = true;
    }
  }

  console.log("Running program from entrypoint", nodeName);
  const json = executeNode(filename, nodeName, hasArgs, argsString);

  console.log("\nOutput:");
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
  const testFilePath = writeTestCase(filename, nodeName, inputStr, expectedOutput, criteria);
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
    console.log(`\nTest ${i + 1}/${total}: node=${testCase.nodeName} input=${testCase.input || "(none)"}`);

    const result = executeNode(tests.sourceFile, testCase.nodeName, hasArgs, testCase.input);

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
        console.log("  ⚠ LLM Judge evaluation not yet supported, skipping");
      }
    }

    if (testPassed) passed++;
  }

  console.log(`\n${passed}/${total} tests passed`);
}