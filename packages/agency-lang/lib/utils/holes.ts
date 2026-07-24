import { AgencyNode, Hole, HoleSort } from "../types.js";
import { walkNodesArray } from "./node.js";
import { variableTypeToString } from "../backends/typescriptGenerator/typeToString.js";

/**
 * Hole queries shared by the compiler (AG8001 refusal), the type checker,
 * and the template runtime (`loadTemplate` / `fill` / `holesOf`). Lives in
 * utils so none of those layers has to import across the others.
 */

/** What `holesOf` reports per distinct hole name: enough for a model (the
 *  usual filler) to know what each hole accepts. */
export type HoleInfo = {
  name: string;
  sort: HoleSort;
  splice: boolean;
  /** The hole's printed type ("number", "string[] | null"), or null when no
   *  type applies (statements/decl/identifier holes) or none is known. */
  type: string | null;
  /** When this hole arrived inside a grafted fragment: the name of the hole
   *  that fragment was most recently filled into (loc.origin, stamped by
   *  fill; re-grafting overwrites, so the outermost graft wins). Null for
   *  holes written directly in the template, and best-effort null when the
   *  hole node carries no loc. */
  origin: string | null;
};

/** Every hole in the tree, in source order, including duplicates. Built on
 *  walkNodesArray (`lib/utils/node.ts`), the single source for AST walking
 *  — see the comment at `lib/stdlib/agency.ts:262`. A hole has no children,
 *  so there is nothing to prune; nested templates are unrepresentable. */
export function findHoles(nodes: AgencyNode[]): Hole[] {
  return [...walkNodesArray(nodes)]
    .map((visit) => visit.node)
    .filter((node): node is Hole => node.type === "hole");
}

/** Distinct hole names, in first-appearance order. Internal — fill's
 *  arity checks need only names; the public surface is holeInfos. */
export function holeNames(nodes: AgencyNode[]): string[] {
  // Null-prototype: hole names are user-controlled keys ("__proto__",
  // "constructor", ...) — house pattern, see lib/optimize/registry.ts.
  const seen: Record<string, true> = Object.create(null);
  const names: string[] = [];
  for (const hole of findHoles(nodes)) {
    if (seen[hole.name]) continue;
    seen[hole.name] = true;
    names.push(hole.name);
  }
  return names;
}

/** Types the hole's POSITION supplies, keyed by hole name — today the
 *  annotated-assignment position (`const x: string = #text`). This is what
 *  lets holesOf report a type the template author never wrote on the hole
 *  itself. First occurrence wins, matching holeInfos — so when the same
 *  name appears in positions of DIFFERENT types, fill-time validation
 *  checks against the first only, and a mismatch at the second position
 *  falls through to the completed program's run-time check. */
export function positionInferredTypes(nodes: AgencyNode[]): Record<string, string> {
  // Null-prototype: keyed by user-controlled hole names.
  const inferred: Record<string, string> = Object.create(null);
  for (const visit of walkNodesArray(nodes)) {
    if (visit.node.type !== "hole") continue;
    const hole = visit.node as Hole;
    if (hole.typeAnnotation || inferred[hole.name]) continue;
    const parent = visit.ancestors[visit.ancestors.length - 1] as
      | AgencyNode
      | undefined;
    if (parent && parent.type === "assignment" && parent.typeHint) {
      inferred[hole.name] = variableTypeToString(parent.typeHint, {}, true);
    }
  }
  return inferred;
}

/** One HoleInfo per distinct name, first occurrence winning. `type` is the
 *  hole's own annotation when present, else the position-inferred type. */
export function holeInfos(nodes: AgencyNode[]): HoleInfo[] {
  const all = findHoles(nodes);
  const inferred = positionInferredTypes(nodes);
  return holeNames(nodes).map((name) => {
    const hole = all.find((candidate) => candidate.name === name) as Hole;
    const annotated = hole.typeAnnotation
      ? variableTypeToString(hole.typeAnnotation, {}, true)
      : null;
    return {
      name,
      sort: hole.sort,
      splice: hole.splice,
      type: annotated ?? inferred[name] ?? null,
      origin: hole.loc?.origin?.kind === "filler" ? hole.loc.origin.name : null,
    };
  });
}
