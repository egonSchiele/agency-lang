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
export function walkNodes(root: TreeNode): TreeNode[] {
  return [root, ...root.children.flatMap(walkNodes)];
}

export function findNode(roots: TreeNode[], id: string): TreeNode | undefined {
  return roots.flatMap(walkNodes).find((node) => node.id === id);
}

/** Nearest first, the trace root last. */
export function ancestorsOf(node: TreeNode, index: TreeIndex): TreeNode[] {
  const parentId = index.parentIds[node.id];
  const parent = parentId === undefined ? undefined : index.byId[parentId];
  if (parent === undefined) {
    return [];
  }
  return [parent, ...ancestorsOf(parent, index)];
}

export function nearestAncestor(
  node: TreeNode,
  index: TreeIndex,
  matches: (ancestor: TreeNode) => boolean,
): TreeNode | undefined {
  return ancestorsOf(node, index).find(matches);
}

export function rootOf(node: TreeNode, index: TreeIndex): TreeNode {
  return ancestorsOf(node, index).at(-1) ?? node;
}

export type PlacedNode = { node: TreeNode; parent: TreeNode; depth: number };
/** Descendants in forest order, omitting a skipped node and its subtree. */
export function walkWithDepth(
  root: TreeNode,
  skip: (node: TreeNode) => boolean = () => false,
): PlacedNode[] {
  function visit(parent: TreeNode, depth: number): PlacedNode[] {
    return parent.children
      .filter((node) => !skip(node))
      .flatMap((node) => [{ node, parent, depth }, ...visit(node, depth + 1)]);
  }
  return visit(root, 0);
}
