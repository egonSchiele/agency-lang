import prompts from "prompts";
import fs, { readFileSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { GraphNodeDefinition, VariableType } from "@/types.js";
import renderEvaluate from "@/templates/cli/evaluate.js";
import renderJudgeEvaluate from "@/templates/cli/judgeEvaluate.js";
import { compile } from "./commands.js";
export function parseTarget(target: string): {
  filename: string;
  nodeName: string;
} {
  const colonIndex = target.lastIndexOf(":");
  if (colonIndex === -1) {
    return { filename: target, nodeName: "" };
  }
  const filename = target.slice(0, colonIndex);
  const nodeName = target.slice(colonIndex + 1);
  return { filename, nodeName };
}

export async function promptForTarget(): Promise<{
  filename: string;
  nodeName: string;
}> {
  let filename: string = "";
  let nodeName: string = "";
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

  return { filename, nodeName };
}

export async function pickANode(nodes: GraphNodeDefinition[]): Promise<string> {
  const response = await prompts({
    type: "select",
    name: "node",
    message: "Pick a node:",
    choices: nodes.map((node) => ({
      title: node.nodeName,
      value: node.nodeName,
    })),
  });
  return response.node;
}

export async function promptForArgs(
  selectedNode: GraphNodeDefinition,
): Promise<{
  hasArgs: boolean;
  argsString: string;
}> {
  let hasArgs = false;
  let argsString = "";

  if (selectedNode.parameters.length > 0) {
    const paramNames = selectedNode.parameters.map((p) => p.name).join(", ");
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

  return { hasArgs, argsString };
}

export function executeNode(
  agencyFile: string,
  nodeName: string,
  hasArgs: boolean,
  argsString: string,
  interruptHandlers?: Array<{
    action: "approve" | "reject" | "modify";
    modifiedArgs?: Record<string, any>;
    expectedMessage?: string;
  }>,
): { data: any; [key: string]: any } {
  const outFile = agencyFile.replace(".agency", ".ts");
  compile({}, agencyFile, outFile);
  const evaluateScript = renderEvaluate({
    filename: outFile,
    nodeName,
    hasArgs,
    args: argsString,
    hasInterruptHandlers: !!interruptHandlers,
    interruptHandlersJSON: interruptHandlers
      ? JSON.stringify(interruptHandlers)
      : undefined,
  });
  const evaluateFile = "__evaluate.ts";
  fs.writeFileSync(evaluateFile, evaluateScript);
  execSync(`npx tsx ${evaluateFile}`, { stdio: "inherit" });
  const results = readFileSync("__evaluate.json", "utf-8");
  return JSON.parse(results);
}

export function formatTypeHint(vt: VariableType): string {
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

export function executeJudge(
  actualOutput: string,
  expectedOutput: string,
  judgePrompt: string,
): { score: number; reasoning: string } {
  // Resolve the judge.agency file bundled in dist/lib/agents/
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const judgeAgencyFile = path.resolve(currentDir, "../agents/judge.agency");

  const judgeOutFile = "__judge.ts";
  compile({}, judgeAgencyFile, judgeOutFile);

  const judgeScript = renderJudgeEvaluate({
    judgeFilename: judgeOutFile,
    actualOutput: JSON.stringify(actualOutput),
    expectedOutput: JSON.stringify(expectedOutput),
    judgePrompt: JSON.stringify(judgePrompt),
  });

  const judgeEvaluateFile = "__judge_evaluate.ts";
  fs.writeFileSync(judgeEvaluateFile, judgeScript);
  execSync(`npx tsx ${judgeEvaluateFile}`, { stdio: "inherit" });
  const results = readFileSync("__judge_evaluate.json", "utf-8");
  return JSON.parse(results).data;
}
