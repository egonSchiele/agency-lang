import { stringParser } from "@/parsers/parsers.js";
import type { AgencyNode, AgencyProgram, PromptSegment, SourceLocation, Tag } from "@/types.js";
import { expressionToString, walkNodesArray } from "@/utils/node.js";

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

export function parsePromptToSegments(prompt: string): PromptSegment[] {
  const parsed = stringParser(JSON.stringify(prompt));
  if (!parsed.success || parsed.rest.length > 0) {
    throw new Error("Failed to parse prompt as an Agency string literal");
  }
  return parsed.result.segments;
}

export function findOptimizeTargets(
  program: AgencyProgram,
  nodeName: string,
): OptimizeTarget[] {
  const node = program.nodes.find((candidate) => candidate.type === "graphNode" && candidate.nodeName === nodeName);
  if (!node || node.type !== "graphNode") return [];
  return walkNodesArray(node.body)
    .map((item) => buildOptimizeTarget(item.node))
    .filter((target): target is OptimizeTarget => target !== null);
}

function buildOptimizeTarget(node: AgencyNode): OptimizeTarget | null {
  if (node.type !== "assignment" && node.type !== "functionCall") return null;
  const optimizeTag = findOptimizeTag(node);
  if (!optimizeTag) return null;

  const target: OptimizeTarget = {
    node,
    llmCall: findTaggedLlmCall(node),
    tag: optimizeTag,
    configKeys: readOptimizeConfigKeys(optimizeTag),
  };
  target.promptValue = getPromptValue(target);
  return target;
}

function findOptimizeTag(node: AgencyNode): Tag | undefined {
  return tagsOf(node).find((tag: Tag) => tag.name === "optimize");
}

function tagsOf(node: AgencyNode): Tag[] {
  return "tags" in node && Array.isArray(node.tags) ? node.tags : [];
}

function findTaggedLlmCall(node: AgencyNode): AgencyNode | null {
  if (node.type === "assignment" && node.value?.type === "functionCall" && node.value.functionName === "llm") {
    return node.value;
  }
  if (node.type === "functionCall" && node.functionName === "llm") {
    return node;
  }
  return null;
}

function readOptimizeConfigKeys(tag: Tag): string[] {
  if (tag.arguments.length === 0) return ["prompt"];
  return tag.arguments.map((argument) => {
    if (argument.type !== "variableName") {
      const where = formatSourceLocation(argument.loc ?? tag.loc);
      throw new Error(
        `@optimize(...) arguments must be plain config-key identifiers${where}; got ${argument.type}.`,
      );
    }
    return argument.value;
  });
}

function formatSourceLocation(loc?: SourceLocation): string {
  return loc ? ` (line ${loc.line + 1}, col ${loc.col + 1})` : "";
}
