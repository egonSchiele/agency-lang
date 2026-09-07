import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { isMlxUri, parseMlxUri, modelDirEntries } from "../stdlib/modelBackend.js";
import {
  _resolveModel,
  _mlxServedName,
  defaultCacheDir,
  readClientConfig,
} from "../stdlib/localModels.js";
import { mlxModelDir, readMlxModelRecord, isMlxModelComplete } from "../stdlib/mlxModelRecord.js";
import { startFrontDoor, type FrontDoor, type Route } from "./mlxFrontDoor.js";

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
  /** Resolves with what happened ("mlx_lm.server for X exited with 1") when
   *  the process exits. Readiness stops waiting and rejects. */
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
      throw new Error(`${exited} before it was ready.`);
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

// ---------------------------------------------------------------------------
// runServe: resolve, check, start one process per model, open the door.
// ---------------------------------------------------------------------------

export type Child = {
  on: (ev: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
  kill: () => unknown;
};

export type ServeDeps = {
  spawn: (python: string, args: string[]) => Child;
  fetch: typeof fetch;
  exec: Exec;
  totalmem: () => number;
  log: (line: string) => void;
  freePort: () => Promise<number>;
  cacheDir: string;
  home: string;
  env: Record<string, string | undefined>;
  configuredPython: string | undefined;
};

export type ServeHandle = {
  port: number;
  models: string[];
  /** Resolves with a message when a process dies after it was ready. */
  failure: Promise<string>;
  close: () => Promise<void>;
};

export type ServeFlags = { port?: number; maxTokens?: number; python?: string };

function realSpawn(python: string, args: string[]): Child {
  return spawn(python, args, {
    stdio: "inherit",
    env: { ...process.env, HF_HUB_OFFLINE: "1" },
  });
}

function realDeps(): ServeDeps {
  return {
    spawn: realSpawn,
    fetch,
    exec: execSync,
    totalmem: os.totalmem,
    log: console.log,
    freePort,
    cacheDir: defaultCacheDir(),
    home: os.homedir(),
    env: process.env,
    configuredPython: readClientConfig().mlx?.python,
  };
}

type Planned = { name: string; dir: string; sizeBytes: number };

/** One model to serve: the name requests will use, the directory to start
 *  the process on, and its size for the memory warning. */
function planModel(value: string, cacheDir: string): Planned {
  const resolved = _resolveModel(value);
  if (resolved.backend === "llama-cpp") {
    throw new Error(
      `"${value}" is a GGUF model. agency local serve is for MLX models; ` +
        `run it with agency run --local ${value} instead.`,
    );
  }
  const name = _mlxServedName(resolved);
  if (isMlxUri(resolved.target)) {
    const { repo } = parseMlxUri(resolved.target);
    const dir = mlxModelDir(cacheDir, repo);
    const record = readMlxModelRecord(dir);
    if (record === null || !isMlxModelComplete(record)) {
      throw new Error(`${repo} is not downloaded. Run:\n  agency local download mlx:${repo}`);
    }
    const sizeBytes = Object.values(record.files).reduce((sum, f) => sum + f.size, 0);
    return { name, dir, sizeBytes };
  }
  const dir = path.resolve(resolved.target);
  const sizeBytes = modelDirEntries(dir).reduce((sum, f) => sum + f.size, 0);
  return { name, dir, sizeBytes };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Resolves with a description once the child exits. */
function exitOf(child: Child, name: string): Promise<string> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      const how = signal !== null ? `was killed by ${signal}` : `exited with ${code}`;
      resolve(`mlx_lm.server for ${name} ${how}`);
    });
  });
}

export function servingBanner(port: number, models: string[]): string[] {
  const lines = [
    `Serving ${models.length} model${models.length === 1 ? "" : "s"} on http://127.0.0.1:${port}/v1:`,
  ];
  for (const m of models) {
    lines.push(`  ${m}`);
  }
  const first = models[0];
  const spelled = path.isAbsolute(first) ? first : `mlx:${first}`;
  lines.push(
    "",
    `  agency run --local ${spelled} your.agency`,
    `  agency agent --local ${spelled}`,
  );
  return lines;
}

export async function runServe(
  values: string[],
  flags: ServeFlags,
  deps: ServeDeps = realDeps(),
): Promise<ServeHandle> {
  const port = flags.port ?? 8080;
  const maxTokens = flags.maxTokens ?? 16384;
  const planned = values.map((v) => planModel(v, deps.cacheDir));
  const names = planned.map((p) => p.name);
  const repeated = names.find((n, i) => names.indexOf(n) !== i);
  if (repeated !== undefined) {
    throw new Error(`${repeated} is named twice.`);
  }
  const warning = memoryWarning(
    planned.map((p) => p.sizeBytes),
    deps.totalmem(),
  );
  if (warning !== null) {
    deps.log(warning);
  }
  const python = choosePython(
    flags.python,
    deps.configuredPython,
    deps.env.AGENCY_MLX_PYTHON,
    deps.home,
  );
  if (!checkPython(python, deps.exec)) {
    throw new Error(pythonMissingMessage(python, deps.home));
  }

  const children: Child[] = [];
  const exits: Promise<string>[] = [];
  let stopping = false;
  const killAll = () => {
    stopping = true;
    for (const child of children) {
      child.kill();
    }
  };
  const routes: Route[] = [];
  for (const model of planned) {
    const internalPort = await deps.freePort();
    const child = deps.spawn(python, serveArgs(model.dir, internalPort, maxTokens));
    children.push(child);
    const gone = exitOf(child, model.name);
    exits.push(gone);
    deps.log(`Loading ${model.name} (${gb(model.sizeBytes)})…`);
    const started = Date.now();
    try {
      await waitUntilLoaded(internalPort, model.dir, { fetch: deps.fetch, gone });
    } catch (err) {
      killAll();
      throw err;
    }
    deps.log(`  ready in ${formatElapsed(Date.now() - started)}`);
    routes.push({ model: model.name, upstreamModel: model.dir, port: internalPort });
  }

  let door: FrontDoor;
  try {
    door = await startFrontDoor(port, routes);
  } catch (err) {
    killAll();
    throw err;
  }
  for (const line of servingBanner(door.port, names)) {
    deps.log(line);
  }
  const failure = Promise.race(exits).then((why) =>
    stopping ? new Promise<string>(() => {}) : `${why}.`,
  );
  return {
    port: door.port,
    models: names,
    failure,
    close: async () => {
      killAll();
      await door.close();
    },
  };
}

/** The CLI entry: serve until Ctrl-C, or until a process dies. */
export async function localServe(values: string[], flags: ServeFlags): Promise<void> {
  let handle: ServeHandle;
  try {
    handle = await runServe(values, flags);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const stop = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const why = await handle.failure;
  console.error(why);
  await handle.close();
  process.exit(1);
}
