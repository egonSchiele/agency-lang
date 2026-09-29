import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readClientConfig } from "./localModels.js";

/** The Python environment `agency local serve` sets up by default, under
 *  the home directory. */
export function defaultMlxEnv(home: string): string {
  return path.join(home, ".agency-agent", "mlx-env");
}

/** `--python`, then `client.mlx.python`, then `AGENCY_MLX_PYTHON`, then the
 *  default environment under the home directory. The one order every
 *  caller uses: `serve`, the one-shot image tools, and packages that run
 *  Python of their own. */
export function choosePython(
  flag: string | undefined,
  configured: string | undefined,
  env: string | undefined,
  home: string,
): string {
  for (const candidate of [flag, configured, env]) {
    if (candidate !== undefined && candidate !== "") {
      return candidate;
    }
  }
  return path.join(defaultMlxEnv(home), "bin", "python");
}

/** The Python a stdlib helper runs with, from the config and the
 *  environment of this process. */
export function configuredPython(): string {
  return choosePython(
    undefined,
    readClientConfig().mlx?.python,
    process.env.AGENCY_MLX_PYTHON,
    os.homedir(),
  );
}

/** The folder holding the local servers' rules modules, such as
 *  `diffusersImageRules.py`. A package that runs Python of its own puts
 *  this folder on its `sys.path` and imports the same checks the servers
 *  make, instead of keeping a copy. The makefile copies the modules into
 *  `dist/lib/cli`, so the folder sits beside this one in both trees. */
export function serverRulesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli");
}
