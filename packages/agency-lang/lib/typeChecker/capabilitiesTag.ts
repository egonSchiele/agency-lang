import { positionalTagArguments, type Tag } from "../types/tag.js";
import type { AgencyNode, Expression } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import { CAPABILITIES, type Capability } from "../host/host.js";
import { levenshtein } from "../levenshtein.js";
import { declaredName } from "../types/hole.js";
import { tagsAbove } from "../utils/tagsAbove.js";

/** `@capabilities(fileRead, subprocess)` on a `def` or a `node` names what
 *  the host must have for that function to work. The names come from
 *  `CAPABILITIES` in lib/host/host.ts; nothing else is allowed. A function
 *  with no tag declares nothing of its own, and what it needs is then only
 *  what the functions it calls need. See docs/dev/language/capabilities.md. */
export const CAPABILITIES_TAG = "capabilities";

export type CapabilitiesProblemKind = "badArgument" | "repeatedTag" | "unknownName";
export type CapabilitiesTagProblem = {
  kind: CapabilitiesProblemKind;
  loc: Tag["loc"];
  /** For `unknownName`: the name as written and the closest known one. */
  name?: string;
  suggestion?: string;
};
export type CapabilitiesRead = {
  /** Whether any `@capabilities` tag is present. A tag with no arguments
   *  is present and names nothing. */
  tagged: boolean;
  capabilities: Capability[];
  problems: CapabilitiesTagProblem[];
};

export function isCapabilitiesTag(tag: Tag): boolean {
  return tag.name === CAPABILITIES_TAG;
}

export function hasCapabilitiesTag(tags: Tag[] = []): boolean {
  return tags.some(isCapabilitiesTag);
}

function isIdentifier(argument: Expression): boolean {
  return argument.type === "variableName";
}

function argumentNames(tag: Tag): string[] {
  return positionalTagArguments(tag)
    .filter(isIdentifier)
    .map((argument) => (argument as { value: string }).value);
}

function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name);
}

/** The known capability closest to `name`: the edit distance, ignoring
 *  case, divided by the longer length, so a short name like `llm` does not
 *  win every comparison by being short (`flies` is closer to `fileRead`
 *  than to `llm` this way). There are seven names, so there is always one
 *  to suggest. */
export function closestCapability(name: string): Capability {
  let best: Capability = CAPABILITIES[0];
  let bestDistance = Infinity;
  for (const candidate of CAPABILITIES) {
    const longer = Math.max(name.length, candidate.length);
    const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase()) / longer;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Read the `@capabilities` tags on one declaration. Unknown names are
 *  dropped from `capabilities` and reported in `problems`; a name written
 *  twice counts once. */
export function readCapabilities(tags: Tag[] = []): CapabilitiesRead {
  const capabilityTags = tags.filter(isCapabilitiesTag);
  const problems: CapabilitiesTagProblem[] = [];
  const capabilities: Capability[] = [];
  for (const tag of capabilityTags) {
    if (!positionalTagArguments(tag).every(isIdentifier)) {
      problems.push({ kind: "badArgument", loc: tag.loc });
    }
    for (const name of argumentNames(tag)) {
      if (!isCapability(name)) {
        problems.push({
          kind: "unknownName",
          loc: tag.loc,
          name,
          suggestion: closestCapability(name),
        });
      } else if (!capabilities.includes(name)) {
        capabilities.push(name);
      }
    }
  }
  if (capabilityTags.length > 1) {
    problems.push({ kind: "repeatedTag", loc: capabilityTags[1].loc });
  }
  return { tagged: capabilityTags.length > 0, capabilities, problems };
}

export type CallableDeclaration = FunctionDefinition | GraphNodeDefinition;

/** One `def` or `node`, with the tags written above it and the tags the
 *  preprocessor may already have attached, in one list. */
export type TaggedCallable = { name: string; node: CallableDeclaration; tags: Tag[] };

export function callableName(node: CallableDeclaration): string {
  return declaredName(node.type === "function" ? node.functionName : node.nodeName);
}

/**
 * Every function and node in the program, each with its tags. The symbol
 * table and the type checker see the raw parse tree, where a tag is still a
 * sibling node above its declaration, so the tags are read with `tagsAbove`
 * and joined with any the preprocessor attached. A copy; nothing is
 * mutated.
 */
export function callablesWithTags(nodes: AgencyNode[]): TaggedCallable[] {
  return tagsAbove(nodes)
    .filter(
      (entry): entry is { node: CallableDeclaration; tags: Tag[] } =>
        entry.node?.type === "function" || entry.node?.type === "graphNode",
    )
    .map((entry) => ({
      name: callableName(entry.node),
      node: entry.node,
      tags: [...(entry.node.tags ?? []), ...entry.tags],
    }));
}

/** The capabilities each function or node declares with its own tag, by
 *  name. A function with no tag is not listed. */
export function ownCapabilities(nodes: AgencyNode[]): Record<string, Capability[]> {
  // Null prototype: the keys are names the user wrote.
  const own: Record<string, Capability[]> = Object.create(null);
  for (const { name, tags } of callablesWithTags(nodes)) {
    const read = readCapabilities(tags);
    if (read.tagged) {
      own[name] = read.capabilities;
    }
  }
  return own;
}
