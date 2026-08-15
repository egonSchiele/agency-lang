import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { build, stop as stopEsbuild, type BuildOptions } from "esbuild";

import type { AgencyConfig } from "@/config.js";
import type { BaseGrader } from "./baseGrader.js";
import { toGrader, type Grader } from "./functionGrader.js";

let counter = 0;

/**
 * Load a user-authored TypeScript grading module and return its graders.
 * Transpiles with esbuild (leaving `agency-lang` external so the user's
 * `import { grader } from "agency-lang/optimize"` resolves to the installed
 * package), writes the bundle next to the source so Node finds the project's
 * node_modules, imports the default export, and normalizes it to BaseGrader[].
 */
export async function loadGradingModule(
  filePath: string,
  _config: AgencyConfig,
): Promise<BaseGrader[]> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Grading module not found: ${absolute}`);
  }
  counter += 1;
  const out = path.join(path.dirname(absolute), `.agency-grading-${process.pid}-${counter}.mjs`);
  try {
    await buildSurvivingServiceDeath({
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
    const exported = mod.default;
    if (exported === undefined) {
      throw new Error(
        `Grading module ${absolute} must default-export a grader or an array of graders ` +
          `(e.g. \`export default [...]\`).`,
      );
    }
    const specs: Grader[] = Array.isArray(exported) ? exported : [exported];
    return specs.map(toGrader);
  } finally {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }
}

/**
 * esbuild runs a long-lived service subprocess, and a terminal Ctrl-C reaches
 * the whole process group — service included. An interrupted eval still
 * grades (partial results are the point of salvage-on-SIGINT), and that
 * grading may be the next build() call, which then fails with "The service is
 * no longer running": a killed service never restarts by itself. stop() +
 * retry once starts a fresh service; any other error, or a second failure,
 * propagates untouched.
 */
async function buildSurvivingServiceDeath(options: BuildOptions): Promise<void> {
  try {
    await build(options);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("service is no longer running")) {
      throw err;
    }
    await stopEsbuild();
    await build(options);
  }
}
