import { parseAgency } from "@/parser.js";
import { GraphNodeDefinition } from "@/types.js";
import { getNodesOfType } from "@/utils/node.js";
import fs from "fs";
import { nanoid } from "nanoid";
import prompts from "prompts";
import {
  executeNode,
  formatTypeHint,
  parseTarget,
  pickANode,
  promptForTarget,
} from "./util.js";

type Case = {
  id: string;
  name?: string;
  description?: string;
  skip?: boolean;
  args: Record<string, any>;
};

type ArgsFile = { cases: Case[] };

type EvalCase = {
  id: string;
  name?: string;
  description?: string;
  args: Record<string, any>;
  output: any;
  rating: number;
};

type EvalResultFile = { cases: EvalCase[] };

function readFile(filename: string): string {
  const data = fs.readFileSync(filename);
  return data.toString("utf8");
}

function saveResults(path: string, results: EvalResultFile): void {
  fs.writeFileSync(path, JSON.stringify(results, null, 2));
}

function getNextResultsFilename(agencyFilename: string): string {
  const base = agencyFilename.replace(".agency", "");
  let n = 0;
  while (fs.existsSync(`${base}.eval.results_${n}.json`)) {
    n++;
  }
  return `${base}.eval.results_${n}.json`;
}

function serializeValue(value: any): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function argsRecordToString(
  args: Record<string, any>,
  parameters: { name: string }[],
): string {
  return parameters.map((p) => serializeValue(args[p.name])).join(", ");
}

function parseArgValue(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function createArgsFileInteractively(
  filename: string,
  selectedNode: GraphNodeDefinition,
): Promise<ArgsFile> {
  const cases: Case[] = [];

  let addMore = true;
  while (addMore) {
    const id = nanoid();

    const nameResponse = await prompts({
      type: "text",
      name: "name",
      message: "Case name (optional, press enter to skip):",
    });

    const args: Record<string, any> = {};
    for (const param of selectedNode.parameters) {
      const typeLabel = param.typeHint
        ? ` (${formatTypeHint(param.typeHint)})`
        : "";
      const argResponse = await prompts({
        type: "text",
        name: "value",
        message: `Value for ${param.name}${typeLabel}:`,
      });
      if (argResponse.value === undefined) break;
      args[param.name] = parseArgValue(argResponse.value);
    }

    const c: Case = { id, args };
    if (nameResponse.name) {
      c.name = nameResponse.name;
    }
    cases.push(c);

    const moreResponse = await prompts({
      type: "confirm",
      name: "more",
      message: "Add another case?",
      initial: true,
    });
    addMore = moreResponse.more === true;
  }

  const argsFile: ArgsFile = { cases };
  fs.writeFileSync(filename, JSON.stringify(argsFile, null, 2));
  console.log(`Args file saved to ${filename}`);
  return argsFile;
}

export async function evaluate(
  target?: string,
  argsFilePath?: string,
  resultsFilePath?: string,
) {
  // A. Resolve target
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

  const selectedNode = nodes.find((n) => n.nodeName === nodeName)!;

  // B. Load or create args file
  let argsFile: ArgsFile;

  if (argsFilePath) {
    argsFile = JSON.parse(fs.readFileSync(argsFilePath, "utf-8"));
  } else if (selectedNode.parameters.length === 0) {
    // No parameters: single case with empty args
    argsFile = { cases: [{ id: nanoid(), args: {} }] };
  } else {
    // Interactive args file creation
    const defaultFilename = filename.replace(".agency", ".eval.json");
    const filenameResponse = await prompts({
      type: "text",
      name: "filename",
      message: "Args file name:",
      initial: defaultFilename,
    });
    if (!filenameResponse.filename) return;

    if (fs.existsSync(filenameResponse.filename)) {
      argsFile = JSON.parse(
        fs.readFileSync(filenameResponse.filename, "utf-8"),
      );
      console.log(
        `Loaded existing args file with ${argsFile.cases.length} cases`,
      );
    } else {
      argsFile = await createArgsFileInteractively(
        filenameResponse.filename,
        selectedNode,
      );
    }
  }

  // C. Load or initialize results file
  let resultsPath: string;
  let results: EvalResultFile;

  if (resultsFilePath) {
    resultsPath = resultsFilePath;
    results = JSON.parse(fs.readFileSync(resultsFilePath, "utf-8"));
  } else {
    resultsPath = getNextResultsFilename(filename);
    results = { cases: [] };
  }

  const ratedIds = new Set(results.cases.map((c) => c.id));

  // D. Execute and rate each case
  const totalCases = argsFile.cases.length;
  let rated = 0;

  for (let i = 0; i < totalCases; i++) {
    const c = argsFile.cases[i];

    if (c.skip) {
      console.log(`\nCase ${i + 1}/${totalCases}: skipped (skip=true)`);
      continue;
    }

    if (ratedIds.has(c.id)) {
      console.log(
        `\nCase ${i + 1}/${totalCases}: skipped (already rated)`,
      );
      continue;
    }

    const label = c.name ? `"${c.name}"` : c.id;
    console.log(`\n--- Case ${i + 1}/${totalCases}: ${label} ---`);

    const hasArgs = selectedNode.parameters.length > 0;
    const argsString = hasArgs
      ? argsRecordToString(c.args, selectedNode.parameters)
      : "";

    const json = executeNode(filename, nodeName, hasArgs, argsString, undefined);

    console.log("\nOutput:");
    console.log(JSON.stringify(json.data, null, 2));

    const ratingResponse = await prompts({
      type: "number",
      name: "rating",
      message: "Rate this output (1-5):",
      validate: (v) =>
        v >= 1 && v <= 5 ? true : "Rating must be between 1 and 5",
    });

    if (ratingResponse.rating === undefined) {
      console.log("\nEvaluation cancelled.");
      break;
    }

    const evalCase: EvalCase = {
      id: c.id,
      args: c.args,
      output: json.data,
      rating: ratingResponse.rating,
    };
    if (c.name) evalCase.name = c.name;
    if (c.description) evalCase.description = c.description;

    results.cases.push(evalCase);
    saveResults(resultsPath, results);
    rated++;
  }

  // E. Print summary
  if (results.cases.length > 0) {
    const avg =
      results.cases.reduce((sum, c) => sum + c.rating, 0) /
      results.cases.length;
    console.log(`\n--- Summary ---`);
    console.log(`Cases rated: ${results.cases.length}/${totalCases}`);
    console.log(`Average rating: ${avg.toFixed(2)}`);
    console.log(`Results saved to: ${resultsPath}`);
  } else {
    console.log("\nNo cases were rated.");
  }
}
