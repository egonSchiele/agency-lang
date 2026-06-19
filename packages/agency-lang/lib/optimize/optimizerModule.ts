import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { build } from "esbuild";

import type { OptimizerFactory } from "./optimizer.js";

let counter = 0;

/**
 * Load a user-authored TypeScript optimizer module and return its factory.
 * Transpiles with esbuild (leaving `agency-lang` external so the user's
 * `import { BaseOptimizer } from "agency-lang/optimize"` resolves to the
 * installed package), writes the bundle next to the source so Node finds the
 * project's node_modules, and returns the default-exported factory.
 */
export async function loadOptimizerModule(filePath: string): Promise<OptimizerFactory> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Optimizer module not found: ${absolute}`);
  }
  counter += 1;
  const out = path.join(path.dirname(absolute), `.agency-optimizer-${process.pid}-${counter}.mjs`);
  try {
    await build({
      entryPoints: [absolute],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outfile: out,
      write: true,
      logLevel: "silent",
      external: ["agency-lang", "agency-lang/*"],
    });
    // eslint-disable-next-line no-restricted-syntax -- CLI-layer loading of a user artifact; the bundle path is only known at runtime
    const mod = await import(pathToFileURL(out).href);
    const factory = mod.default;
    if (factory === undefined) {
      throw new Error(`Optimizer module ${absolute} must default-export a factory function (config) => Optimizer.`);
    }
    if (typeof factory !== "function") {
      throw new Error(`Optimizer module ${absolute} must default-export a factory function, got ${typeof factory}.`);
    }
    return factory as OptimizerFactory;
  } finally {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }
}
