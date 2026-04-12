import { AgencyConfig } from "@/config.js";
import { parseTarget } from "./util.js";
import { parseAgency } from "@/parser.js";
import { Tag, AgencyProgram, AgencyNode } from "@/types.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import fs from "fs";

type OptimizeOptions = {
  iterations: number;
  earlyStopThreshold: number;
  earlyStopPatience: number;
};

const DEFAULT_OPTIONS: OptimizeOptions = {
  iterations: 5,
  earlyStopThreshold: 0.02,
  earlyStopPatience: 2,
};

export type OptimizeTarget = {
  node: AgencyNode;
  llmCall: AgencyNode | null;
  tag: Tag;
  promptValue?: string;
  configKeys?: string[];
};

export async function optimize(
  config: AgencyConfig,
  target: string,
  opts: Partial<OptimizeOptions> = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const { filename, nodeName } = parseTarget(target);

  // 1. Parse the file and run preprocessor to attach tags to nodes
  const contents = fs.readFileSync(filename, "utf-8");
  const parsed = parseAgency(contents);
  if (!parsed.success) {
    console.error("Parse error:", parsed.message);
    process.exit(1);
  }

  const info = collectProgramInfo(parsed.result);
  const preprocessor = new TypescriptPreprocessor(parsed.result, config, info);
  const program = preprocessor.preprocess();

  // 2. Find @goal and @optimize tags
  const goalTag = findGoalTag(program, nodeName);
  const optimizeTargets = findOptimizeTargets(program, nodeName);

  if (!goalTag) {
    console.error(
      `No @goal tag found on node "${nodeName}". Add @goal("description") to define what success looks like.`,
    );
    process.exit(1);
  }

  if (optimizeTargets.length === 0) {
    console.error(
      `No @optimize tags found in node "${nodeName}". Mark statements with @optimize to tell the optimizer what to tune.`,
    );
    process.exit(1);
  }

  const goal = goalTag.arguments[0];
  console.log(`Goal: ${goal}`);
  console.log(`Found ${optimizeTargets.length} optimization target(s)`);
  console.log(`Running up to ${options.iterations} iterations...\n`);

  // 3. Interactive optimization loop — TODO: implement in Task 6
}

export function findGoalTag(
  program: AgencyProgram,
  nodeName: string,
): Tag | null {
  for (const node of program.nodes) {
    if (node.type === "graphNode" && node.nodeName === nodeName) {
      const tags: Tag[] = node.tags || [];
      return tags.find((t: Tag) => t.name === "goal") || null;
    }
  }
  return null;
}

export function findOptimizeTargets(
  program: AgencyProgram,
  nodeName: string,
): OptimizeTarget[] {
  const targets: OptimizeTarget[] = [];
  for (const node of program.nodes) {
    if (node.type === "graphNode" && node.nodeName === nodeName) {
      collectOptimizeTargets(node.body, targets);
    }
  }
  return targets;
}

function collectOptimizeTargets(
  body: AgencyNode[],
  targets: OptimizeTarget[],
) {
  for (const node of body) {
    const tags: Tag[] = (node as any).tags || [];
    const optimizeTag = tags.find((t: Tag) => t.name === "optimize");
    if (optimizeTag) {
      let llmCall: AgencyNode | null = null;

      if (
        node.type === "assignment" &&
        node.value?.type === "functionCall" &&
        node.value.functionName === "llm"
      ) {
        llmCall = node.value;
      } else if (node.type === "functionCall" && node.functionName === "llm") {
        llmCall = node;
      }

      const target: OptimizeTarget = { node, llmCall, tag: optimizeTag };

      if (llmCall && llmCall.type === "functionCall") {
        if (llmCall.arguments[0]?.type === "string") {
          target.promptValue = llmCall.arguments[0].segments
            .map((s: any) =>
              s.type === "text" ? s.value : `\${${s.expression}}`,
            )
            .join("");
        }
        if (optimizeTag.arguments.length === 0) {
          target.configKeys = ["prompt"];
        } else {
          target.configKeys = optimizeTag.arguments;
        }
      }
      targets.push(target);
    }
  }
}
