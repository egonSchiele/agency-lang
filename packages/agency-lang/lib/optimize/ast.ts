import { stringParser } from "@/parsers/parsers.js";
import type { AgencyNode, AgencyProgram, PromptSegment, SourceLocation, Tag } from "@/types.js";
import { expressionToString, walkNodesArray } from "@/utils/node.js";

export type OptimizeTarget = {
  node: AgencyNode;
  llmCall: AgencyNode | null;
  promptNode: AgencyNode | null;
  tag: Tag;
  promptValue?: string;
  configKeys?: string[];
};

export function getPromptValue(target: OptimizeTarget): string {
  return target.promptNode ? promptNodeValue(target.promptNode) : "";
}

export function updatePrompt(target: OptimizeTarget, newPrompt: string): void {
  if (target.promptNode && isStringPromptNode(target.promptNode)) {
    target.promptNode.segments = parsePromptToSegments(newPrompt);
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
  return walkNodesArray(node.body, [node])
    .map((item) => buildOptimizeTarget(item.node, item.ancestors))
    .filter((target): target is OptimizeTarget => target !== null);
}

function buildOptimizeTarget(node: AgencyNode, ancestors: AgencyNode[]): OptimizeTarget | null {
  if (node.type !== "assignment" && node.type !== "functionCall") return null;
  const optimizeTag = findOptimizeTag(node);
  if (!optimizeTag) return null;
  const llmCall = findTaggedLlmCall(node);

  const target: OptimizeTarget = {
    node,
    llmCall,
    promptNode: findPromptNode(llmCall, node, ancestors),
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

function findPromptNode(llmCall: AgencyNode | null, taggedNode: AgencyNode, ancestors: AgencyNode[]): AgencyNode | null {
  if (!llmCall || llmCall.type !== "functionCall") return null;
  const promptArg = llmCall.arguments[0];
  if (isStringPromptNode(promptArg)) return promptArg;
  if (promptArg?.type !== "variableName") return null;
  return findLocalStringAssignment(promptArg.value, taggedNode, ancestors);
}

function findLocalStringAssignment(name: string, taggedNode: AgencyNode, ancestors: AgencyNode[]): AgencyNode | null {
  const body = nearestBody(ancestors);
  if (!body) return null;
  const tagIndex = body.indexOf(taggedNode);
  if (tagIndex === -1) return null;
  for (let index = tagIndex - 1; index >= 0; index -= 1) {
    const candidate = body[index];
    if (candidate.type === "assignment" && candidate.variableName === name && isStringPromptNode(candidate.value)) {
      return candidate.value;
    }
  }
  return null;
}

function nearestBody(ancestors: AgencyNode[]): AgencyNode[] | null {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if ("body" in ancestor && Array.isArray(ancestor.body)) return ancestor.body;
  }
  return null;
}

function isStringPromptNode(node: unknown): node is AgencyNode & { type: "string" | "multiLineString"; segments: PromptSegment[] } {
  return !!node && typeof node === "object" && "type" in node && (node.type === "string" || node.type === "multiLineString");
}

function promptNodeValue(node: AgencyNode): string {
  if (!isStringPromptNode(node)) return "";
  return node.segments
    .map((segment: PromptSegment) =>
      segment.type === "text" ? segment.value : `\${${expressionToString(segment.expression)}}`,
    )
    .join("");
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
