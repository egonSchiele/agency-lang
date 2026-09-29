import * as os from "node:os";
import * as path from "node:path";
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
