import type { BaseOptimizerConfig, Optimizer, OptimizerFactory } from "./optimizer.js";
import { ExampleOptimizer } from "./optimizers/example.js";
import { Gepa, type GepaConfig } from "./optimizers/gepa.js";
import { GreedyReflective } from "./optimizers/greedyReflective.js";

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
registerOptimizer("gepa", (config) => new Gepa(config as GepaConfig));
// A minimal, single-round optimizer kept as a copy-paste template for users
// writing their own. See lib/optimize/optimizers/example.ts.
registerOptimizer("example", (config) => new ExampleOptimizer(config));
