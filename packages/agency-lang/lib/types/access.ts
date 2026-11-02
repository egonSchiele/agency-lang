import { AgencyNode, Expression, FunctionCall } from "../types.js";
import { BaseNode } from "./base.js";

export type AccessChainElement =
  | { kind: "property"; name: string }
  | { kind: "index"; index: Expression }
  | { kind: "slice"; start?: Expression; end?: Expression }
  | { kind: "methodCall"; functionCall: FunctionCall }
  | ({ kind: "call" } & Pick<FunctionCall, "arguments" | "block" | "argumentTrivia">)
  /** The `?` operator: unwrap the Result so far, or return its failure
   *  from the enclosing function. Lowered away by the hoist pass; see
   *  docs/dev/language/unwrap-operator.md. */
  | { kind: "unwrap" };

export type ValueAccess = BaseNode & {
  type: "valueAccess";
  base: AgencyNode;
  chain: AccessChainElement[];
  async?: boolean;
};

export function isUnwrapElement(element: AccessChainElement): element is { kind: "unwrap" } {
  return element.kind === "unwrap";
}

/** True when the chain holds a `?` operator anywhere. */
export function hasUnwrap(access: ValueAccess): boolean {
  return access.chain.some(isUnwrapElement);
}

export type ChainPieces = {
  /** The elements before each unwrap, one list per `?`; a list is empty
   *  when the `?` follows the base or another `?` directly. */
  pieces: AccessChainElement[][];
  /** The elements after the last unwrap. The whole chain when there is none. */
  trailing: AccessChainElement[];
};

/** The chain split at every `?`: `[?, b, ?, c]` gives `pieces [[], [b]]` and
 *  `trailing [c]`. The hoist pass lowers each piece to its own step. */
export function chainPieces(chain: AccessChainElement[]): ChainPieces {
  const pieces: AccessChainElement[][] = [];
  let current: AccessChainElement[] = [];
  for (const element of chain) {
    if (isUnwrapElement(element)) {
      pieces.push(current);
      current = [];
    } else {
      current = [...current, element];
    }
  }
  return { pieces, trailing: current };
}
