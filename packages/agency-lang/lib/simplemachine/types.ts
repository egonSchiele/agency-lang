import { JSONEdge } from "@/types.js";

export type SimpleMachineConfig<T> = {
  debug?: {
    log?: boolean;
    logData?: boolean;
  };
  validation?: {
    func?: (data: T) => Promise<boolean>;
    maxRetries?: number;
  };
  hooks?: {
    beforeNode?: (nodeId: string, data: T) => Promise<T>;
    afterNode?: (nodeId: string, data: T) => Promise<T>;
  };
  statelog?: {
    host: string;
    apiKey: string;
    projectId: string;
    traceId?: string;
    debugMode?: boolean;
  };
};

export type NodeId = string;
export type Edge<T, N extends string> = RegularEdge<N> | ConditionalEdge<T, N>;

export type RegularEdge<N extends string> = {
  type: "regular";
  to: N;
};

export type ConditionalFunc<T, N extends string> = (
  data: T,
) => Promise<NoInfer<N>>;
export type ConditionalEdge<T, N extends string> = {
  type: "conditional";
  condition?: ConditionalFunc<T, N>;
  adjacentNodes: readonly N[];
};

export function regularEdge<N extends string>(to: N): RegularEdge<N> {
  return { type: "regular", to };
}

export function conditionalEdge<T, N extends string>(
  condition: ConditionalFunc<T, N> | undefined,
  adjacentNodes: readonly N[],
): ConditionalEdge<T, N> {
  return { type: "conditional", condition, adjacentNodes };
}

export function isRegularEdge<T, N extends string>(
  edge: Edge<T, N>,
): edge is RegularEdge<N> {
  return edge.type === "regular";
}

export function isConditionalEdge<T, N extends string>(
  edge: Edge<T, N>,
): edge is ConditionalEdge<T, N> {
  return edge.type === "conditional";
}

export function edgeToJSON<T, N extends string>(edge: Edge<T, N>): JSONEdge {
  if (isRegularEdge(edge)) {
    return { type: "regular", to: edge.to };
  } else {
    return {
      type: "conditional",
      adjacentNodes: edge.adjacentNodes,
    };
  }
}
