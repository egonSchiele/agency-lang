// The diagnostics for the `@capabilities` tag. A tag goes on a `def` or a
// `node` and names capabilities from the fixed list; anything else is one of
// the errors below. The checker sees the raw program, where a tag is still a
// sibling node above its declaration, so tags are read with `tagsAbove` and
// joined with any the preprocessor attached. See
// docs/dev/language/capabilities.md.

import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext, TypeCheckError } from "./types.js";
import type { Tag } from "../types/tag.js";
import { tagsAbove, type NodeWithTagsAbove } from "../utils/tagsAbove.js";
import { CAPABILITIES } from "../host/host.js";
import {
  callablesWithTags,
  isCapabilitiesTag,
  readCapabilities,
  type CapabilitiesTagProblem,
  type TaggedCallable,
} from "./capabilitiesTag.js";

export function checkCapabilitiesTags(ctx: TypeCheckerContext): void {
  ctx.errors.push(...tagProblemDiagnostics(ctx), ...strayTagDiagnostics(ctx));
}

/** AG3024 to AG3026: the tag is in the right place and something inside it
 *  is wrong. */
function tagProblemDiagnostics(ctx: TypeCheckerContext): TypeCheckError[] {
  return callablesWithTags(ctx.programNodes).flatMap((callable) =>
    readCapabilities(callable.tags).problems.map((problem) => problemDiagnostic(callable, problem)),
  );
}

function problemDiagnostic(
  callable: TaggedCallable,
  problem: CapabilitiesTagProblem,
): TypeCheckError {
  const loc = problem.loc ?? callable.node.loc ?? null;
  const name = callable.name;
  if (problem.kind === "unknownName") {
    return diagnostic(
      "capabilityUnknown",
      {
        name: problem.name ?? "",
        callable: name,
        suggestion: problem.suggestion ?? "",
        known: CAPABILITIES.join(", "),
      },
      loc,
    );
  }
  if (problem.kind === "repeatedTag") {
    return diagnostic("capabilitiesRepeatedTag", { callable: name }, loc);
  }
  return diagnostic("capabilitiesBadArgument", { callable: name }, loc);
}

/** A `@capabilities` tag on anything that is not a `def` or a `node`, or
 *  standing alone at the end of a list: one rule, with one hint for the
 *  effect declaration, where F3 taught people to write it. */
function strayTagDiagnostics(ctx: TypeCheckerContext): TypeCheckError[] {
  return tagsAbove(ctx.programNodes).flatMap((entry) =>
    strayCapabilitiesTags(entry).map((tag) =>
      diagnostic("capabilitiesStrayTag", { hint: hintFor(entry) }, tag.loc ?? null),
    ),
  );
}

function strayCapabilitiesTags(entry: NodeWithTagsAbove): Tag[] {
  if (entry.node?.type === "function" || entry.node?.type === "graphNode") {
    return [];
  }
  const attached = (entry.node as { tags?: Tag[] } | null)?.tags ?? [];
  return [...entry.tags, ...attached].filter(isCapabilitiesTag);
}

function hintFor(entry: NodeWithTagsAbove): string {
  if (entry.node?.type === "effectDeclaration") {
    return " Move it to the function that raises the effect.";
  }
  return "";
}
