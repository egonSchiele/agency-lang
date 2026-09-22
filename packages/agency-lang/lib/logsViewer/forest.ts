import type { TreeNode } from "./types.js";

export type TreeIndex = {
  byId: Record<string, TreeNode>;
  parentIds: Record<string, string>;
};

/** One DFS over the tree. Both records have null prototypes because ids
 * come from statelog content. */
export function buildTreeIndex(root: TreeNode): TreeIndex {
  const byId: Record<string, TreeNode> = Object.create(null);
  const parentIds: Record<string, string> = Object.create(null);
  for (const node of walkNodes(root)) {
    byId[node.id] = node;
    for (const child of node.children) {
      parentIds[child.id] = node.id;
    }
  }
  return { byId, parentIds };
}

/** Every node under `root`, root included, parents before children. */
export function walkNodes(
  root: TreeNode,
  descend: (node: TreeNode) => boolean = () => true,
): TreeNode[] {
  const nodes: TreeNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    if (!descend(node)) {
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index--) {
      pending.push(node.children[index]);
    }
  }
  return nodes;
}

export function findNode(roots: TreeNode[], id: string): TreeNode | undefined {
  return roots.flatMap((root) => walkNodes(root)).find((node) => node.id === id);
}

/** Nearest first, the trace root last. */
export function ancestorsOf(node: TreeNode, index: TreeIndex): TreeNode[] {
  const ancestors: TreeNode[] = [];
  let current = parentOf(node, index);
  while (current !== undefined) {
    ancestors.push(current);
    current = parentOf(current, index);
  }
  return ancestors;
}

export function nearestAncestor(
  node: TreeNode,
  index: TreeIndex,
  matches: (ancestor: TreeNode) => boolean,
): TreeNode | undefined {
  let current = parentOf(node, index);
  while (current !== undefined) {
    if (matches(current)) {
      return current;
    }
    current = parentOf(current, index);
  }
  return undefined;
}

export function rootOf(node: TreeNode, index: TreeIndex): TreeNode {
  return ancestorsOf(node, index).at(-1) ?? node;
}

function parentOf(node: TreeNode, index: TreeIndex): TreeNode | undefined {
  const parentId = index.parentIds[node.id];
  return parentId === undefined ? undefined : index.byId[parentId];
}
