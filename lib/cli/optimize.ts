import { AgencyConfig } from "@/config.js";
import { executeNodeAsync, parseTarget } from "./util.js";
import { resetCompilationCache } from "./commands.js";
import { parseAgency } from "@/parser.js";
import { Tag, AgencyProgram, AgencyNode } from "@/types.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { expressionToString } from "@/utils/node.js";
import * as smoltalk from "smoltalk";
import prompts from "prompts";
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

async function getUserInput(
  nodeName: string,
  parameters: { name: string; typeHint?: any }[],
): Promise<Record<string, any>> {
  console.log(`Provide input for node "${nodeName}":`);
  const args: Record<string, any> = {};
  for (const param of parameters) {
    const typeLabel = param.typeHint ? ` (${JSON.stringify(param.typeHint)})` : "";
    const response = await prompts({
      type: "text",
      name: "value",
      message: `${param.name}${typeLabel}:`,
    });
    if (response.value === undefined) process.exit(0);
    try {
      args[param.name] = JSON.parse(response.value);
    } catch {
      args[param.name] = response.value;
    }
  }
  return args;
}

async function collectFeedback(): Promise<{ score: number | null; feedback: string }> {
  const response = await prompts({
    type: "text",
    name: "feedback",
    message: "Score (1-10) and/or feedback (or 'done' to finish):",
  });
  if (!response.feedback || response.feedback.toLowerCase() === "done") {
    return { score: null, feedback: "done" };
  }
  const match = response.feedback.match(/^(\d+)\s*[,.]?\s*(.*)/);
  if (match) {
    return { score: parseInt(match[1], 10), feedback: match[2] || "" };
  }
  return { score: null, feedback: response.feedback };
}

async function proposeImprovement(
  currentPrompt: string,
  goal: string,
  history: FeedbackEntry[],
  config: AgencyConfig,
): Promise<string> {
  const historyText = history.map((entry, i) => {
    const scoreText = entry.score !== null ? `Score: ${entry.score}/10` : "No score";
    return `--- Attempt ${i + 1} ---\nPrompt: "${entry.promptUsed}"\nInput: ${JSON.stringify(entry.input)}\nOutput: ${JSON.stringify(entry.output)}\n${scoreText}\nFeedback: ${entry.feedback || "none"}`;
  }).join("\n\n");

  const optimizerPrompt = `You are a prompt optimization assistant. Your job is to improve an LLM prompt based on user feedback.

GOAL: ${goal}

CURRENT PROMPT: "${currentPrompt}"

HISTORY OF ATTEMPTS AND FEEDBACK:
${historyText}

Based on the feedback, propose an improved version of the prompt. The prompt may contain template variables like \${variableName} — preserve these exactly as they are.

Respond with ONLY the improved prompt text, nothing else. Do not wrap it in quotes.`;

  const model = config.client?.defaultModel || "gpt-4o-mini";

  const result = await smoltalk.textSync({
    messages: [smoltalk.userMessage(optimizerPrompt)],
    model,
  });

  if (!result.success) {
    throw new Error(`Error from LLM during optimization: ${result.error}`);
  }

  return (result.value.output || "").trim();
}

function updatePrompt(target: OptimizeTarget, newPrompt: string) {
  if (target.llmCall && target.llmCall.type === "functionCall" && target.llmCall.arguments[0]?.type === "string") {
    target.llmCall.arguments[0].segments = parsePromptToSegments(newPrompt);
  }
}

function writeBack(filename: string, program: AgencyProgram) {
  const generator = new AgencyGenerator();
  const result = generator.generate(program);
  fs.writeFileSync(filename, result.output);
}

export function parsePromptToSegments(prompt: string): any[] {
  const segments: any[] = [];
  const regex = /\$\{([^}]+)\}/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: prompt.slice(lastIndex, match.index) });
    }
    segments.push({
      type: "interpolation",
      expression: { type: "variableName", value: match[1].trim() },
    });
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

  // 3. Interactive optimization loop
  const targetNode = program.nodes.find(
    (n: any) => n.type === "graphNode" && n.nodeName === nodeName,
  ) as any;

  const history: FeedbackEntry[] = [];
  let currentPrompt = optimizeTargets[0].promptValue || "";
  let bestScore = -Infinity;
  let stagnantIterations = 0;

  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    console.log(`\n--- Iteration ${iteration}/${options.iterations} ---\n`);

    // a. Get input
    const input = await getUserInput(nodeName, targetNode.parameters);

    // b. Build args string
    const argsString = targetNode.parameters
      .map((p: any) => {
        const val = input[p.name];
        return typeof val === "string" ? JSON.stringify(val) : String(val);
      })
      .join(", ");

    // c. Run the node (reset compilation cache so the updated .agency file is recompiled)
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

    // d. Show output
    console.log("\nOutput:");
    console.log(JSON.stringify(result.data, null, 2));

    // e. Get feedback
    const { score, feedback } = await collectFeedback();
    if (feedback === "done") {
      console.log("\nStopping optimization.");
      break;
    }

    history.push({ input, output: result.data, score, feedback, promptUsed: currentPrompt });

    // f. Early stopping
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

    // g. Propose improvement
    if (iteration < options.iterations) {
      console.log("\nProposing improved prompt...");
      const proposed = await proposeImprovement(currentPrompt, goal, history, config);
      console.log(`\nProposed prompt:\n  "${proposed}"\n`);

      const acceptResponse = await prompts({
        type: "confirm",
        name: "accept",
        message: "Accept this prompt?",
        initial: true,
      });

      if (acceptResponse.accept) {
        currentPrompt = proposed;
        updatePrompt(optimizeTargets[0], proposed);
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
    console.log(`Final prompt: "${currentPrompt}"`);
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
              s.type === "text" ? s.value : `\${${expressionToString(s.expression)}}`,
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
