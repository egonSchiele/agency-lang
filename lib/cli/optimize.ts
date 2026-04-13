import { AgencyConfig } from "@/config.js";
import { executeNodeAsync, parseTarget } from "./util.js";
import { resetCompilationCache } from "./commands.js";
import { parseAgency } from "@/parser.js";
import { exprParser } from "@/parsers/expression.js";
import { Tag, AgencyProgram, AgencyNode, PromptSegment, FunctionParameter, GraphNodeDefinition } from "@/types.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { expressionToString } from "@/utils/node.js";
import { OptimizerIO, DefaultOptimizerIO } from "./optimizerIO.js";
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

export type FeedbackEntry = {
  input: Record<string, any>;
  output: any;
  score: number | null;
  feedback: string;
  promptUsed: string;
};

export function getPromptValue(target: OptimizeTarget): string {
  if (target.llmCall && target.llmCall.type === "functionCall" && target.llmCall.arguments[0]?.type === "string") {
    return target.llmCall.arguments[0].segments
      .map((s: PromptSegment) =>
        s.type === "text" ? s.value : `\${${expressionToString(s.expression)}}`,
      )
      .join("");
  }
  return "";
}

export function updatePrompt(target: OptimizeTarget, newPrompt: string) {
  if (target.llmCall && target.llmCall.type === "functionCall" && target.llmCall.arguments[0]?.type === "string") {
    target.llmCall.arguments[0].segments = parsePromptToSegments(newPrompt);
  }
}

export function writeBack(filename: string, program: AgencyProgram) {
  const generator = new AgencyGenerator();
  const result = generator.generate(program);
  fs.writeFileSync(filename, result.output);
}

export function parsePromptToSegments(prompt: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  const regex = /\$\{([^}]+)\}/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: prompt.slice(lastIndex, match.index) });
    }
    const exprStr = match[1].trim();
    const parsed = exprParser(exprStr);
    if (!parsed.success) {
      throw new Error(`Failed to parse interpolation expression: ${exprStr}`);
    }
    segments.push({ type: "interpolation", expression: parsed.result });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < prompt.length) {
    segments.push({ type: "text", value: prompt.slice(lastIndex) });
  }
  return segments;
}

export async function optimize(
  config: AgencyConfig,
  target: string,
  opts: Partial<OptimizeOptions> = {},
  io?: OptimizerIO,
) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const _io = io || new DefaultOptimizerIO(config);
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

  if (optimizeTargets.length > 1) {
    console.error(
      `Multiple @optimize targets found in node "${nodeName}". Only one @optimize target is supported in v1.`,
    );
    process.exit(1);
  }

  const optimizeTarget = optimizeTargets[0];
  const nonPromptKeys = (optimizeTarget.configKeys || []).filter(k => k !== "prompt");
  if (nonPromptKeys.length > 0) {
    console.warn(
      `Warning: @optimize(${nonPromptKeys.join(", ")}) — only prompt optimization is supported in v1. Parameter tuning for ${nonPromptKeys.join(", ")} will be ignored.`,
    );
  }

  const goal = goalTag.arguments[0];
  console.log(`Goal: ${goal}`);
  console.log(`Running up to ${options.iterations} iterations...\n`);

  const targetNode = program.nodes.find(
    (n): n is GraphNodeDefinition => n.type === "graphNode" && n.nodeName === nodeName,
  )!;

  const history: FeedbackEntry[] = [];
  let bestScore = -Infinity;
  let stagnantIterations = 0;

  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    console.log(`\n--- Iteration ${iteration}/${options.iterations} ---\n`);

    const input = await _io.getUserInput(nodeName, targetNode.parameters);
    const argsString = targetNode.parameters
      .map((p: FunctionParameter) => {
        const val = input[p.name];
        return typeof val === "string" ? JSON.stringify(val) : String(val);
      })
      .join(", ");

    resetCompilationCache();
    console.log("Running agent...");
    let result: { data: any; stdout: string; stderr: string };
    try {
      result = await executeNodeAsync({
        config,
        agencyFile: filename,
        nodeName,
        hasArgs: targetNode.parameters.length > 0,
        argsString,
      });
    } catch (e) {
      console.error("Execution error:", e);
      continue;
    }

    console.log("\nOutput:");
    console.log(JSON.stringify(result.data, null, 2));

    const { score, feedback } = await _io.collectFeedback();
    if (feedback === "done") {
      console.log("\nStopping optimization.");
      break;
    }

    history.push({ input, output: result.data, score, feedback, promptUsed: getPromptValue(optimizeTarget) });

    if (score !== null) {
      const improvement = bestScore > -Infinity ? (score - bestScore) / Math.abs(bestScore) : 1;
      if (score > bestScore) bestScore = score;
      if (improvement < options.earlyStopThreshold) {
        stagnantIterations++;
      } else {
        stagnantIterations = 0;
      }
      if (stagnantIterations >= options.earlyStopPatience) {
        console.log(`\nScore hasn't improved significantly for ${options.earlyStopPatience} iterations. Stopping.`);
        break;
      }
    }

    if (iteration < options.iterations) {
      console.log("\nProposing improved prompt...");
      const proposed = await _io.proposeImprovement(getPromptValue(optimizeTarget), goal, history);

      if (await _io.confirmProposal(proposed)) {
        updatePrompt(optimizeTarget, proposed);
        writeBack(filename, program);
        console.log(`Updated ${filename}`);
      }
    }
  }

  // Final summary
  if (history.length > 0) {
    console.log("\n--- Optimization Summary ---");
    console.log(`Iterations: ${history.length}`);
    if (bestScore > -Infinity) console.log(`Best score: ${bestScore}/10`);
    console.log(`Final prompt: "${getPromptValue(optimizeTarget)}"`);
  }
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
    if (node.type !== "assignment" && node.type !== "functionCall") continue;
    const tags: Tag[] = node.tags || [];
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
      target.promptValue = getPromptValue(target);
      target.configKeys = optimizeTag.arguments.length === 0 ? ["prompt"] : optimizeTag.arguments;
      targets.push(target);
    }
  }
}
