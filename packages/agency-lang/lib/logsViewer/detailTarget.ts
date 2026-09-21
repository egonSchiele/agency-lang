import { findNode } from "./forest.js";
import { parseRoundId, roundsOf } from "./timeline/rounds.js";
import type { TreeNode } from "./types.js";

export function resolveDetailNode(roots: TreeNode[], rowId: string): TreeNode | undefined {
  if (parseRoundId(rowId) === undefined) {
    return findNode(roots, rowId);
  }
  return roots.flatMap((root) => roundsOf(root)).find((round) => round.id === rowId)?.node;
}
