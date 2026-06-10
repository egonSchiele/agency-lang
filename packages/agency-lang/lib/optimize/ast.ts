import fs from "fs";

import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { exprParser } from "@/parsers/parsers.js";
import type { AgencyNode, AgencyProgram, PromptSegment, Tag } from "@/types.js";
import { expressionToString } from "@/utils/node.js";

export type OptimizeTarget = {
  node: AgencyNode;
  llmCall: AgencyNode | null;
  tag: Tag;
  promptValue?: string;
  configKeys?: string[];
};

export function getPromptValue(target: OptimizeTarget): string {
  if (target.llmCall && target.llmCall.type === "functionCall" && target.llmCall.arguments[0]?.type === "string") {
    return target.llmCall.arguments[0].segments
      .map((segment: PromptSegment) =>
        segment.type === "text" ? segment.value : `\${${expressionToString(segment.expression)}}`,
      )
      .join("");
  }
  return "";
}

export function updatePrompt(target: OptimizeTarget, newPrompt: string): void {
  if (target.llmCall && target.llmCall.type === "functionCall" && target.llmCall.arguments[0]?.type === "string") {
    target.llmCall.arguments[0].segments = parsePromptToSegments(newPrompt);
  }
}

export function writeBack(filename: string, program: AgencyProgram): void {
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
): void {
  for (const node of body) {
    if (node.type !== "assignment" && node.type !== "functionCall") continue;
    const tags: Tag[] = node.tags || [];
    const optimizeTag = tags.find((tag: Tag) => tag.name === "optimize");
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
      if (optimizeTag.arguments.length === 0) {
        target.configKeys = ["prompt"];
      } else {
        target.configKeys = optimizeTag.arguments.map((argument) => {
          if (argument.type !== "variableName") {
            const where = argument.loc ? ` (line ${argument.loc.line}, col ${argument.loc.col})` : "";
            throw new Error(
              `@optimize(...) arguments must be plain config-key identifiers${where}; got ${argument.type}.`,
            );
          }
          return argument.value;
        });
      }
      targets.push(target);
    }
  }
}
