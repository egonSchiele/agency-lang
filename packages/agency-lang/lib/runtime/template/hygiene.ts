import { AgencyNode, Hole, Scope } from "../../types.js";
import { declaredName } from "../../types/hole.js";
import { walkNodesArray } from "../../utils/node.js";
import { Code, isCode } from "./code.js";

/** Reserved identifier prefix for hygienic renames. ASCII on purpose:
 *  renamed names get printed to source and re-parsed by a subprocess, so
 *  they must stay legal identifiers (`lib/parsers/parsers.ts` varNameChar).
 *  Collisions with renamed names are impossible by construction because
 *  the fresh-name counter seeds ABOVE every `__hyg<n>` already present in
 *  the template and the fillers (see maxHygieneIndex) — which is also what
 *  lets previously renamed output be filled again. */
export const RESERVED_PREFIX = "__hyg";

/** A rename that applies only within one scope of the template. The scope
 *  key comes from the walk's scope chain (`fn:name` / `node:name` /
 *  `global`), so renaming `tmp` in `def b` cannot touch `tmp` in `def a`
 *  — a flat name→name map cannot express that distinction. */
export type ScopedRename = { scopeKey: string; from: string; to: string };

export type RenamePlan = {
  template: ScopedRename[];
  /** Per-graft flat maps, keyed by hole name (and element index for
   *  splices, as `name[i]`). A filler is one fragment grafted into one
   *  place, so its whole tree is the scope. */
  fillers: Record<string, Record<string, string>>;
};

function scopeKeyOfChain(scopes: Scope[]): string {
  // Innermost frame wins, so walk a reversed copy.
  for (const scope of [...scopes].reverse()) {
    if (scope.type === "function") return `fn:${scope.functionName}`;
    if (scope.type === "node") return `node:${scope.nodeName}`;
  }
  return "global";
}

function chainKeysOf(scopes: Scope[]): string[] {
  const keys = ["global"];
  for (const scope of scopes) {
    if (scope.type === "function") keys.push(`fn:${scope.functionName}`);
    if (scope.type === "node") keys.push(`node:${scope.nodeName}`);
  }
  return keys;
}

/** Names a single node binds, if any: `let`/`const` targets, function and
 *  node parameters, for-loop binders. Destructuring patterns are not
 *  covered in v1 — a pattern binder that collides is missed; the templates
 *  guide notes it. */
function bindersOfNode(node: AgencyNode): string[] {
  if (node.type === "assignment" && node.declKind && !node.accessChain) {
    return [node.variableName];
  }
  if (node.type === "function" || node.type === "graphNode") {
    return node.parameters.map((param) => param.name);
  }
  if (node.type === "forLoop") {
    const names: string[] = [];
    if (typeof node.itemVar === "string") names.push(node.itemVar);
    if (node.indexVar) names.push(node.indexVar);
    return names;
  }
  return [];
}

/** All binders anywhere in a fragment, deduplicated. */
export function bindersOf(code: Code): string[] {
  const names: string[] = [];
  for (const { node } of walkNodesArray(code.nodes)) {
    names.push(...bindersOfNode(node));
  }
  return names.filter((name, index) => names.indexOf(name) === index);
}

/** Names a fragment USES but does not bind — the side of capture an
 *  earlier plan draft got wrong: comparing binders to binders finds
 *  nothing, because `tmp` used as an expression binds nothing.
 *
 *  LOAD-BEARING DEPENDENCY: this is exactly as complete as `walkNodes`'
 *  descent (lib/utils/node.ts). A node kind whose expression children the
 *  walker misses under-reports free names here, no test fails, and a
 *  filler silently captures a template binder — the precise bug hygiene
 *  exists to prevent, failing open. (The guardBlock head-argument gap
 *  fixed in this feature's PR is the historical example.) The tripwire
 *  for this path is the walker-coverage corpus invariants in
 *  lib/utils/expressionSlots.test.ts ("walker coverage" describe block):
 *  they check, structurally and in both parse modes, that walkNodes
 *  reaches every expression position — no hand enumeration to forget.
 *  Gaps they have found but not yet fixed are listed there in
 *  KNOWN_WALKER_GAPS; hygiene inherits each one until its walker-fix PR
 *  lands. */
export function freeNamesOf(code: Code): string[] {
  const bound = bindersOf(code);
  const used: string[] = [];
  for (const { node } of walkNodesArray(code.nodes)) {
    if (node.type === "variableName") used.push(node.value);
  }
  return used
    .filter((name) => !bound.includes(name))
    .filter((name, index, all) => all.indexOf(name) === index);
}

/** Every name a node declares or mentions: binders, variable uses, AND
 *  declaration names (function, node, type alias). The declaration names
 *  matter for the reserved-prefix check below — `fresh()` starts at
 *  `__hyg1_`, so a filler declaring `def __hyg1_tmp()` could collide with
 *  the very first rename if declarations went unchecked. */
function allNamesOfNode(node: AgencyNode): string[] {
  const names = [...bindersOfNode(node)];
  if (node.type === "variableName") names.push(node.value);
  if (node.type === "function") names.push(declaredName(node.functionName));
  if (node.type === "graphNode") names.push(declaredName(node.nodeName));
  if (node.type === "typeAlias") names.push(node.aliasName);
  return names;
}

/**
 * The highest `__hyg<n>` index appearing anywhere in a fragment's names —
 * binders, uses, and declaration names alike. Fresh renames start ABOVE
 * the max across the template and every filler, which is what makes a
 * rename collision impossible by construction. This replaced an earlier
 * reject-any-`__hyg`-input rule: rejection cannot tell a renamer-produced
 * name from a caller-supplied one, so it broke the compose workflow — a
 * second fill rejected the first fill's own output.
 */
export function maxHygieneIndex(code: Code): number {
  let max = 0;
  const pattern = new RegExp(`^${RESERVED_PREFIX}(\\d+)_`);
  for (const { node } of walkNodesArray(code.nodes)) {
    for (const name of allNamesOfNode(node)) {
      const match = pattern.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

type GraftSite = {
  /** `name` for a plain filler, `name[i]` for a splice element. */
  fillerKey: string;
  code: Code;
  /** Scope keys enclosing the hole, outermost first. */
  chainKeys: string[];
  /** Innermost scope key — where the graft lands. */
  landingKey: string;
  /** Hoisted here so the collision loops below are set intersections
   *  over precomputed arrays instead of O(n^2) re-walks of every sibling
   *  fragment — the non-colliding (normal) case paid the full quadratic
   *  cost because nothing short-circuited. */
  binders: string[];
  freeNames: string[];
};

/** Every Code graft the fill will perform, with the scope context of the
 *  hole it lands in. Splice arrays contribute one site per element. */
function graftSites(template: Code, values: Record<string, unknown>): GraftSite[] {
  const sites: GraftSite[] = [];
  for (const visit of walkNodesArray(template.nodes)) {
    if (visit.node.type !== "hole") continue;
    const hole = visit.node as Hole;
    if (!Object.hasOwn(values, hole.name)) continue;
    const value = values[hole.name];
    const chainKeys = chainKeysOf(visit.scopes);
    const landingKey = scopeKeyOfChain(visit.scopes);
    if (isCode(value)) {
      sites.push({
        fillerKey: hole.name,
        code: value,
        chainKeys,
        landingKey,
        binders: bindersOf(value),
        freeNames: freeNamesOf(value),
      });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isCode(item)) {
          sites.push({
            fillerKey: `${hole.name}[${index}]`,
            code: item,
            chainKeys,
            landingKey,
            binders: bindersOf(item),
            freeNames: freeNamesOf(item),
          });
        }
      });
    }
  }
  return sites;
}

/**
 * The three collision sets, each computed against the binders VISIBLE AT
 * THE HOLE — never `bindersOf(template)`, which is the whole file:
 *
 * 1. visible template binder ∩ filler free name → rename the TEMPLATE's
 *    binder, within its own scope only (the filler meant something else
 *    by that name).
 * 2. filler binder ∩ visible template binder → rename the FILLER's binder
 *    (the template keeps its spelling; the filler owns the noise).
 * 3. the same name bound by more than one filler grafted into the same
 *    scope → each filler gets its own fresh name.
 *
 * Renaming is selective — only colliding names change — so generated code
 * normally reads as written.
 */
export function computeRenames(
  template: Code,
  values: Record<string, unknown>,
): RenamePlan {
  // Seed the counter above every __hyg<n> already present — in the
  // template (a previous fill's renames) and in every Code filler (a
  // previously filled fragment) — so fresh names cannot collide with
  // them. See maxHygieneIndex for why this is seeding, not rejection.
  let counter = maxHygieneIndex(template);
  for (const value of Object.values(values)) {
    if (isCode(value)) counter = Math.max(counter, maxHygieneIndex(value));
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isCode(item)) counter = Math.max(counter, maxHygieneIndex(item));
      }
    }
  }
  const fresh = (name: string): string => `${RESERVED_PREFIX}${(counter += 1)}_${name}`;

  // One walk of the template: which binders live in which scope. A def or
  // node's parameters belong to ITS scope, not the enclosing one.
  // Null-prototype dictionaries throughout: scope keys and filler keys
  // derive from user-controlled names ("__proto__" is a legal hole or
  // function name) — house pattern, see lib/optimize/registry.ts.
  const bindersByScope: Record<string, { name: string; scopeKey: string }[]> =
    Object.create(null);
  for (const visit of walkNodesArray(template.nodes)) {
    for (const name of bindersOfNode(visit.node)) {
      const owner =
        visit.node.type === "function"
          ? `fn:${declaredName(visit.node.functionName)}`
          : visit.node.type === "graphNode"
            ? `node:${declaredName(visit.node.nodeName)}`
            : scopeKeyOfChain(visit.scopes);
      (bindersByScope[owner] ??= []).push({ name, scopeKey: owner });
    }
  }

  const sites = graftSites(template, values);
  const templateRenames: ScopedRename[] = [];
  const fillerRenames: Record<string, Record<string, string>> = Object.create(null);

  for (const site of sites) {
    const visible = site.chainKeys.flatMap((key) => bindersByScope[key] ?? []);
    const visibleNames = visible.map((binder) => binder.name);
    const free = site.freeNames;
    const own = site.binders;

    // Case 1.
    for (const binder of visible) {
      if (!free.includes(binder.name)) continue;
      const already = templateRenames.some(
        (rename) => rename.scopeKey === binder.scopeKey && rename.from === binder.name,
      );
      if (!already) {
        templateRenames.push({
          scopeKey: binder.scopeKey,
          from: binder.name,
          to: fresh(binder.name),
        });
      }
    }

    // Case 2.
    const map: Record<string, string> = Object.create(null);
    for (const name of own) {
      if (visibleNames.includes(name)) map[name] = fresh(name);
    }
    fillerRenames[site.fillerKey] = map;
  }

  // Case 3 — skipping names case 2 already renamed.
  for (const site of sites) {
    const siblings = sites.filter(
      (other) => other !== site && other.landingKey === site.landingKey,
    );
    if (siblings.length === 0) continue;
    const map = fillerRenames[site.fillerKey];
    for (const name of site.binders) {
      if (map[name]) continue;
      const shared = siblings.some((other) => other.binders.includes(name));
      if (shared) map[name] = fresh(name);
    }
  }

  return { template: templateRenames, fillers: fillerRenames };
}

// ---------------------------------------------------------------------------
// Applying renames.
//
// Rewriting binder fields (assignment.variableName, parameter names,
// for-loop binders) is why this cannot ride on expressionSlots/bodySlots:
// those tables enumerate expression and body positions, and binder fields
// are neither. walkNodesArray is read-only. So these are bespoke rewriting
// walks — the same recorded exception node.ts documents for its own
// expression descent.
// ---------------------------------------------------------------------------

function isNameField(source: Record<string, unknown>, key: string): boolean {
  return (
    (source.type === "variableName" && key === "value") ||
    (source.type === "assignment" && key === "variableName") ||
    (source.type === "functionParameter" && key === "name") ||
    (source.type === "forLoop" && (key === "itemVar" || key === "indexVar"))
  );
}

function renameNode(value: unknown, renames: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => renameNode(item, renames));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const field = source[key];
    if (isNameField(source, key) && typeof field === "string" && field in renames) {
      out[key] = renames[field];
    } else {
      out[key] = renameNode(field, renames);
    }
  }
  return out;
}

/** Flat rename over a whole fragment — for fillers, where the fragment IS
 *  the scope. Rewrites binders and uses alike, so a filler that both
 *  declares and uses a renamed name stays internally consistent. */
export function applyRenames(code: Code, renames: Record<string, string>): Code {
  if (Object.keys(renames).length === 0) return code;
  return { ...code, nodes: renameNode(code.nodes, renames) as AgencyNode[] };
}

/** The binders a def/node introduces directly: its parameters plus its
 *  body-level declarations (not those of nested defs). Used for shadowing:
 *  an inner scope that rebinds a name stops an outer rename at its door. */
function directBinders(node: AgencyNode): string[] {
  if (node.type !== "function" && node.type !== "graphNode") return [];
  const names = node.parameters.map((param) => param.name);
  for (const stmt of node.body) {
    if (stmt.type === "assignment" && stmt.declKind && !stmt.accessChain) {
      names.push(stmt.variableName);
    }
  }
  return names;
}

/** Scope-aware rename over the template: each rename applies only inside
 *  its owning scope's subtree, and stops at an inner def/node that rebinds
 *  the same name (the inner binding shadows it). The active-rename list is
 *  threaded through the recursion so a deactivation holds for the whole
 *  inner subtree, not just the node where it was decided. */
export function applyScopedRenames(code: Code, renames: ScopedRename[]): Code {
  if (renames.length === 0) return code;

  function walk(value: unknown, active: ScopedRename[]): unknown {
    if (Array.isArray(value)) return value.map((item) => walk(item, active));
    if (value === null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;

    let scopedActive = active;
    if (source.type === "function" || source.type === "graphNode") {
      const node = value as AgencyNode;
      const own =
        source.type === "function"
          ? `fn:${declaredName((source as { functionName: string | Hole }).functionName)}`
          : `node:${declaredName((source as { nodeName: string | Hole }).nodeName)}`;
      const rebound = directBinders(node);
      scopedActive = [
        // Outer renames survive into this scope unless it rebinds the name.
        ...active.filter((rename) => !rebound.includes(rename.from)),
        // Renames owned by this scope always apply within it.
        ...renames.filter((rename) => rename.scopeKey === own),
      ];
    }

    const map: Record<string, string> = Object.create(null);
    for (const rename of scopedActive) map[rename.from] = rename.to;

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const field = source[key];
      if (isNameField(source, key) && typeof field === "string" && field in map) {
        out[key] = map[field];
      } else {
        out[key] = walk(field, scopedActive);
      }
    }
    return out;
  }

  const globalActive = renames.filter((rename) => rename.scopeKey === "global");
  return { ...code, nodes: walk(code.nodes, globalActive) as AgencyNode[] };
}
