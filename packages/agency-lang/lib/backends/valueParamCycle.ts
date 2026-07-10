import type { TypeAliasEntry, VariableType } from "../types.js";
import type { TypeAlias } from "../types/typeHints.js";
import { visitTypes } from "../typeChecker/typeWalker.js";

/**
 * Reject value-parameterized aliases whose bodies cycle back to a
 * value-parameterized alias already on the walk (directly or mutually).
 * Their instantiations are INLINED by the zod mapper and the descriptor
 * builder — unlike plain aliases, which emit named consts and defer
 * cycles with z.lazy — so a cycle has no representation: expansion
 * recurses until the stack blows (#484). Detected at declaration so the
 * error names the alias instead of surfacing as a RangeError at some
 * use site.
 *
 * The walk deliberately follows ONLY value-parameterized entries: a plain
 * alias in the chain emits a named const and is referenced by name, which
 * breaks the inline cycle naturally (probe-verified — such programs
 * compile and run).
 *
 * Called from `processTypeAlias` for every value-parameterized alias,
 * which covers top-level declarations AND function/node-body aliases
 * (those are hoisted through the same method).
 */
export function rejectValueParamCycle(
  node: TypeAlias,
  aliasesFull: Record<string, TypeAliasEntry>,
): void {
  const walk = (body: VariableType, seen: string[]): void => {
    visitTypes(body, (t) => {
      const refName =
        t.type === "typeAliasVariable"
          ? t.aliasName
          : t.type === "genericType"
            ? t.name
            : undefined;
      if (refName === undefined) return;
      const entry = aliasesFull[refName];
      if (!entry?.valueParams) return;
      if (seen.includes(refName)) {
        throw new Error(
          `Type alias '${node.aliasName}' is a recursive value-parameterized alias (cycle: ${[...seen, refName].join(" -> ")}). Value-param instantiations are inlined into their use sites and cannot recurse; use a plain recursive alias instead.`,
        );
      }
      walk(entry.body, [...seen, refName]);
    });
  };
  walk(node.aliasedType, [node.aliasName]);
}
