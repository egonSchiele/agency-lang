import type { Tag } from "../types/tag.js";
import type { Expression } from "../types.js";
import { CAPABILITIES, type Capability } from "../host/host.js";
import { levenshtein } from "../levenshtein.js";
import { sameCapabilities } from "../runtime/effectCapabilities.js";
export { sameCapabilities };

/** `@capabilities(fileRead, subprocess)` on an effect declaration names
 *  what the host must have for the effect's function to work. The names
 *  come from `CAPABILITIES` in lib/host/host.ts; nothing else is allowed.
 *  An effect with no tag needs nothing. See docs/dev/language/capabilities.md. */
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
  return tag.arguments
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
    if (!tag.arguments.every(isIdentifier)) {
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
