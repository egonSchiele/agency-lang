import prompts from "prompts";
import fs from "fs";
import path from "path";
import { agencyParser, parseAgency } from "@/parser.js";
import { getNodesOfType } from "@/utils/node.js";
import { GraphNodeDefinition } from "@/types.js";

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
}
