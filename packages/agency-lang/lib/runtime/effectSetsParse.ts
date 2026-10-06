// The parse of stdlib/effectSets.agency into the effect set table. Only
// scripts/generate-effect-sets.mjs and the tests use it; the runtime reads
// the generated data file through effectSets.ts.
import { parseAgency } from "../parser.js";
import type { EffectSetInfo } from "./effectSets.js";
import type { AgencyMultiLineComment, TypeAlias, UnionType, VariableType } from "../types.js";

type RawSet = { name: string; doc: string; items: VariableType[] };

/** Build the set table from Agency source. Exported for tests; production
 *  use goes through `builtinEffectSets`. */
export function parseEffectSets(source: string, origin: string): Record<string, EffectSetInfo> {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`stdlib effect sets file failed to parse (${origin}): ${parsed.message}`);
  }

  // Doc comments are standalone nodes after a bare parse (attachment to
  // the following declaration is the preprocessor's job, which we don't
  // run) — pair each doc comment with the effectSet declaration that
  // follows it.
  const raw: RawSet[] = [];
  let pendingDoc = "";
  for (const node of parsed.result.nodes) {
    if (node.type === "multiLineComment") {
      const comment = node as AgencyMultiLineComment;
      pendingDoc = comment.isDoc && !comment.isModuleDoc ? cleanDoc(comment.content) : "";
      continue;
    }
    if (node.type === "typeAlias" && (node as TypeAlias).isEffectSet) {
      const alias = node as TypeAlias;
      // Only the `<a, b>` literal form is a member list. `<*>` parses to
      // the `any` primitive; a set declared that way has no enumerable
      // members and cannot be expanded, so refuse it at the source.
      if (alias.aliasedType.type !== "unionType" || !alias.aliasedType.isEffectSet) {
        throw new Error(
          `effect set '${alias.aliasName}' in ${origin} is not a member list (<a, b>); ` +
            `'${alias.aliasedType.type}' cannot be expanded`,
        );
      }
      raw.push({
        name: alias.aliasName,
        doc: pendingDoc,
        items: (alias.aliasedType as UnionType).types,
      });
    }
    pendingDoc = "";
  }

  const byName: Record<string, RawSet> = Object.create(null);
  for (const set of raw) {
    byName[set.name] = set;
  }

  const result: Record<string, EffectSetInfo> = Object.create(null);
  for (const set of raw) {
    result[set.name] = {
      name: set.name,
      doc: set.doc,
      members: resolveMembers(set, byName, [], origin),
      composedOf: set.items
        .filter((item) => item.type === "typeAliasVariable")
        .map((item) => item.aliasName),
    };
  }
  return result;
}

/** Flatten one set's items to effect names, resolving nested sets. */
function resolveMembers(
  set: RawSet,
  byName: Record<string, RawSet>,
  seen: string[],
  origin: string,
): string[] {
  if (seen.includes(set.name)) {
    throw new Error(`effect set cycle involving '${set.name}' in ${origin}`);
  }
  const members: string[] = [];
  for (const item of set.items) {
    if (item.type === "stringLiteralType") {
      // A namespaced label: a plain effect name.
      members.push(item.value);
    } else if (item.type === "typeAliasVariable") {
      // A bare label: a reference to another set in this file.
      const target = byName[item.aliasName];
      if (target === undefined) {
        throw new Error(
          `effect set '${set.name}' references unknown set '${item.aliasName}' in ${origin}`,
        );
      }
      members.push(...resolveMembers(target, byName, [...seen, set.name], origin));
    } else {
      throw new Error(
        `effect set '${set.name}' has a member of unexpected shape '${item.type}' in ${origin}`,
      );
    }
  }
  // A member can arrive twice through overlapping nested sets.
  return members.filter((m, i) => members.indexOf(m) === i);
}

/** Strip comment markup: leading/trailing whitespace and the per-line
 *  ` * ` continuation prefix. */
function cleanDoc(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
    .join("\n")
    .trim();
}
