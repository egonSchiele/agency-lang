import { GreedyReflective } from "./greedyReflective.js";
import type { BaseOptimizerConfig, Optimizer, OptimizerFactory } from "./optimizer.js";

export const DEFAULT_OPTIMIZER = "greedy";

// Null-prototype: `name` is user-controlled (the --optimizer flag), so reserved keys
// like "__proto__"/"constructor" must not resolve via the prototype chain.
const registry: Record<string, OptimizerFactory> = Object.create(null);

export function registerOptimizer(name: string, factory: OptimizerFactory): void {
  registry[name] = factory;
}

export function listOptimizers(): string[] {
  return Object.keys(registry).sort();
}

export function getOptimizer(name: string, config: BaseOptimizerConfig): Optimizer {
  if (!Object.hasOwn(registry, name)) {
    throw new Error(
      `Unknown optimizer "${name}". Available optimizers: ${listOptimizers().join(", ")}.`,
    );
  }
  return registry[name](config);
}

registerOptimizer("greedy", (config) => new GreedyReflective(config));
