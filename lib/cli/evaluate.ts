import prompts from "prompts";
import fs, { readFileSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { agencyParser, parseAgency } from "@/parser.js";
import { getNodesOfType } from "@/utils/node.js";
import { GraphNodeDefinition } from "@/types.js";
import { compile } from "./commands.js";
import renderEvaluate from "@/templates/cli/evaluate.js";
import { exit } from "process";
import { improve } from "../../agents/improve.js";
function readFile(filename: string): string {
  console.log("Trying to read file", filename, "...");
  const data = fs.readFileSync(filename);
  const contents = data.toString("utf8");
  return contents;
}

export async function evaluate() {
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

  let filename = response.filename;

  // If user chose custom option, prompt for filename
  if (filename === "__custom__") {
    const customResponse = await prompts({
      type: "text",
      name: "filename",
      message: "Enter the filename to read:",
    });
    filename = customResponse.filename;
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

  const response2 = await prompts({
    type: "select",
    name: "node",
    message: "Pick a node:",
    choices: nodes.map((node) => ({
      title: node.nodeName,
      value: node.nodeName,
    })),
  });

  console.log("Running program from entrypoint", response2.node);
  const outFile = filename.replace(".agency", ".ts");
  compile({}, filename, outFile);
  console.log("Compiled TypeScript output written to", outFile);
  const evaluateScript = renderEvaluate({
    filename: outFile,
    nodeName: response2.node,
  });

  const evaluateFile = "__evaluate.ts";
  fs.writeFileSync(evaluateFile, evaluateScript);
  console.log("Evaluation script written to", evaluateFile);

  console.log("Running evaluation script...");
  execSync(`npx tsx ${evaluateFile}`, { stdio: "inherit" });

  const results = readFileSync("__evaluate.json", "utf-8");
  const json = JSON.parse(results);
  console.log("Evaluation results:", json);

  const rating = await prompts({
    type: "select",
    name: "rating",
    message: "How would you rate the result?",
    choices: [
      { title: "Good", value: "good" },
      { title: "Needs Improvement", value: "needs_improvement" },
    ],
  });

  if (rating.rating === "good") {
    console.log("Great! Glad it worked well.");
    exit(0);
  }

  console.log("How would you improve the result? Please provide feedback:");
  const feedbackResponse = await prompts({
    type: "text",
    name: "feedback",
    message: "Your feedback:",
  });

  printMessages(json.messages.messages);
  console.log("Your feedback:", feedbackResponse.feedback);

  const response3 = await improve(
    JSON.stringify(json.messages.messages),
    feedbackResponse.feedback,
    json.data,
  );
  console.log("Improvement suggestions:", JSON.stringify(response3, null, 2));
}

function printMessages(messages: any[]) {
  for (const message of messages) {
    console.log(`${message.role}: ${message.content}`);
  }
}
