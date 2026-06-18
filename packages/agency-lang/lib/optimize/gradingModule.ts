import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { build } from "esbuild";

import type { AgencyConfig } from "@/config.js";
import type { BaseGrader } from "./grading/baseGrader.js";
import { toGrader, type Grader } from "./grading/functionGrader.js";

let counter = 0;

/**
 * Load a user-authored TypeScript grading module and return its graders.
 * Transpiles with esbuild (leaving `agency-lang` external so the user's
 * `import { grader } from "agency-lang/optimize"` resolves to the installed
 * package), writes the bundle next to the source so Node finds the project's
 * node_modules, imports the default export, and normalizes it to BaseGrader[].
 */
export async function loadGradingModule(filePath: string, _config: AgencyConfig): Promise<BaseGrader[]> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Grading module not found: ${absolute}`);
  }
  counter += 1;
  const out = path.join(path.dirname(absolute), `.agency-grading-${process.pid}-${counter}.mjs`);
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
