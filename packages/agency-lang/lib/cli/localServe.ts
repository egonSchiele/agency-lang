import * as path from "node:path";
import * as net from "node:net";
import { spawnSync } from "node:child_process";
import { isMlxUri } from "../stdlib/modelBackend.js";

export type ServeOptions = { port: number; maxTokens: number; python?: string };

/** The argv for one `mlx_lm.server` process, after the Python path. */
export function serveArgs(modelDir: string, internalPort: number, maxTokens: number): string[] {
  return [
    "-m",
    "mlx_lm.server",
    "--model",
    modelDir,
    "--host",
    "127.0.0.1",
    "--port",
    String(internalPort),
    "--max-tokens",
    String(maxTokens),
    "--log-level",
    "INFO",
  ];
}

export function defaultMlxEnv(home: string): string {
  return path.join(home, ".agency-agent", "mlx-env");
}

/** `--python`, then `client.mlx.python`, then `AGENCY_MLX_PYTHON`, then the
 *  default environment under the home directory. */
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

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** A line to print when the models add up to more than the machine has.
 *  Null when they fit. The caller prints it and continues. */
export function memoryWarning(sizesBytes: number[], totalMemBytes: number): string | null {
  const total = sizesBytes.reduce((sum, n) => sum + n, 0);
  if (total <= totalMemBytes) {
    return null;
  }
  return `Warning: these models total ${gb(total)} and this machine has ${gb(totalMemBytes)} of memory.`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The 404 body for a request naming a model this server was not started
 *  with. A repo id is restarted with its `mlx:` URI; a directory with its
 *  path. */
export function notServedMessage(served: string[], requested: string): string {
  const startWith =
    path.isAbsolute(requested) || isMlxUri(requested) ? requested : `mlx:${requested}`;
  return (
    `This server is serving ${joinNames(served)}. It is not serving ${requested}. ` +
    `Start it with: agency local serve ${startWith}`
  );
}

/** What to print when `<python> -c "import mlx_lm"` fails. The venv
 *  commands create the default environment; a user who pointed --python at
 *  their own Python is told the flag is the other way out. */
export function pythonMissingMessage(python: string, home: string): string {
  const venv = defaultMlxEnv(home);
  return [
    `${python} cannot import mlx_lm.`,
    "Agency does not install Python. Create an environment once:",
    "",
    `  python3.12 -m venv ${venv}`,
    `  ${path.join(venv, "bin", "pip")} install mlx-lm`,
    "",
    "Python 3.11 or newer is required. Or point --python at a Python that has",
    "mlx-lm installed.",
  ].join("\n");
}

export type ReadinessOptions = {
  fetch?: typeof fetch;
  retryMs?: number;
  /** Resolves with a description when the process exits. Readiness stops
   *  waiting and rejects. */
  gone?: Promise<string>;
};

/** `mlx_lm.server` prints nothing when its model has loaded. The only
 *  readiness signal is a completion request that answers. Send a one-token
 *  one, naming the model the process was started with, and retry while the
 *  port is not open. */
export async function waitUntilLoaded(
  port: number,
  upstreamModel: string,
  options: ReadinessOptions = {},
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const retryMs = options.retryMs ?? 500;
  let exited: string | null = null;
  if (options.gone !== undefined) {
    void options.gone.then((why) => {
      exited = why;
    });
  }
  const body = JSON.stringify({
    model: upstreamModel,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
  });
  for (;;) {
    if (exited !== null) {
      throw new Error(`mlx_lm.server for ${upstreamModel} ${exited} before it was ready.`);
    }
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

export type Exec = (cmd: string, args: string[]) => { status: number | null };

function execSync(cmd: string, args: string[]): { status: number | null } {
  return { status: spawnSync(cmd, args, { stdio: "ignore" }).status };
}

/** Whether `python` can import mlx_lm. */
export function checkPython(python: string, exec: Exec = execSync): boolean {
  return exec(python, ["-c", "import mlx_lm"]).status === 0;
}

/** A port nothing is listening on right now, for one mlx_lm.server. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}
