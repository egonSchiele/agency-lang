import * as fs from "fs";
import * as path from "path";
import type { AgencyConfig } from "@/config/config.js";
import { outputPathFor } from "@/compiler/buildSession.js";
import { findRecursively } from "@/utils/findRecursively.js";

/** The package.json Node consults for `file`: the nearest one in `file`'s
 *  directory or any directory above it. Null when there is none. */
export function nearestPackageJson(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function declaresCommonJs(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return parsed?.type === "commonjs";
  } catch {
    // A package.json Node cannot read breaks the run with its own error.
    return false;
  }
}

/** Agency compiles to ES modules. Node refuses to run an ES module `.js` file
 *  when its nearest package.json says `"type": "commonjs"`, with an error that
 *  does not mention Agency. Returns a note explaining the fix in that case,
 *  and null otherwise.
 *
 *  A package.json with no `"type"` field is fine: Node 22.7+ detects the
 *  module syntax and prints its own warning naming the fix. */
export function moduleTypeWarning(outputFile: string): string | null {
  const packageJson = nearestPackageJson(outputFile);
  if (packageJson === null || !declaresCommonJs(packageJson)) return null;
  return [
    "",
    'Note: this package.json sets "type": "commonjs":',
    `  ${packageJson}`,
    "Agency compiles to ES modules, so Node will refuse to run the compiled",
    ".js files. To fix it, either:",
    '  - change "type" to "module" in that package.json, or',
    '  - set "outDir" in agency.json to a folder containing a package.json',
    '    with {"type": "module"}.',
    "",
  ].join("\n");
}

/** `moduleTypeWarning` for `agency compile <inputs>`: checks where each
 *  `.agency` file's output lands, expanding directories the way `compile`
 *  does. Returns the first warning, so a project gets one note. */
export function compileOutputsWarning(config: AgencyConfig, inputs: string[]): string | null {
  for (const input of inputs) {
    const sources =
      fs.existsSync(input) && fs.statSync(input).isDirectory()
        ? [...findRecursively(input)].map((found) => found.path)
        : [input];
    for (const source of sources) {
      const warning = moduleTypeWarning(outputPathFor(config, source, ".js"));
      if (warning) return warning;
    }
  }
  return null;
}
