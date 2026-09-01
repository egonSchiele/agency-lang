import { readFileSync } from "fs";
import path from "path";
import { parseAgency } from "../parser.js";
import { getPackageRoot } from "../importPaths.js";
import type { AgencyMultiLineComment, TypeAlias, UnionType, VariableType } from "../types.js";

/** One built-in capability set from `stdlib/capabilities.agency`. */
export type EffectSetInfo = {
  name: string;
  /** The declaration's doc comment, whitespace-trimmed. */
  doc: string;
  /** Effect names only; nested sets resolved to their members. */
  members: string[];
  /** The other sets this one was declared from, e.g. FileSystem's
   *  ["FileRead", "FileWrite"]. Empty for a set declared from effects. */
  composedOf: string[];
};

// Parsed once per process. Derived from a shipped file that cannot change
// mid-process — the same footing as the always-scope registry
// (alwaysScope.ts), not per-run mutable state.
let cache: Record<string, EffectSetInfo> | null = null;

/**
 * The built-in capability sets, keyed by name (null-prototype record —
 * callers look up CLI-supplied names). Parses `stdlib/capabilities.agency`
 * from the install on first use: the doc comments live only in the source,
 * so the source is the single definition discovery and flag expansion
 * share. Throws when the shipped file is missing or fails to parse — a
 * broken install should be loud, never an empty table.
 */
export function builtinEffectSets(): Record<string, EffectSetInfo> {
  if (cache === null) {
    const file = path.join(getPackageRoot(), "stdlib", "capabilities.agency");
    cache = parseEffectSets(readFileSync(file, "utf-8"), file);
  }
  return cache;
}

type RawSet = { name: string; doc: string; items: VariableType[] };

/** Build the set table from Agency source. Exported for tests; production
 *  use goes through `builtinEffectSets`. */
export function parseEffectSets(source: string, origin: string): Record<string, EffectSetInfo> {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`stdlib capabilities file failed to parse (${origin}): ${parsed.message}`);
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
