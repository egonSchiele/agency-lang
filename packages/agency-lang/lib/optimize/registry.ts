import { GreedyReflective } from "./greedyReflective.js";
import type { Optimizer, OptimizerFactory } from "./optimizer.js";

export const DEFAULT_OPTIMIZER = "greedy";

const registry: Record<string, OptimizerFactory> = {};

export function registerOptimizer(name: string, factory: OptimizerFactory): void {
  registry[name] = factory;
}

export function listOptimizers(): string[] {
  return Object.keys(registry).sort();
}

export function getOptimizer(name: string): Optimizer {
  const factory = registry[name];
  if (!factory) {
    throw new Error(
      `Unknown optimizer "${name}". Available optimizers: ${listOptimizers().join(", ")}.`,
    );
  }
  return factory();
}

registerOptimizer("greedy", () => new GreedyReflective());
