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
  formatGB,
} from "../stdlib/localModels.js";
import { mlxModelDir, readMlxModelRecord, isMlxModelComplete } from "../stdlib/mlxModelRecord.js";
import { startFrontDoor, type FrontDoor, type Route } from "./mlxServer.js";
import { formatElapsed } from "../eval/run/statusBoard.js";

export { formatElapsed };

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

/** A line to print when the models add up to more than the machine has.
 *  Null when they fit. The caller prints it and continues. */
export function memoryWarning(sizesBytes: number[], totalMemBytes: number): string | null {
  const total = sizesBytes.reduce((sum, n) => sum + n, 0);
  if (total <= totalMemBytes) {
    return null;
  }
  return `Warning: these models total ${formatGB(total)} and this machine has ${formatGB(totalMemBytes)} of memory.`;
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

export type PythonProblem = "missing" | "no-mlx-lm";

/** What to print when the chosen Python is not there, or cannot import
 *  mlx_lm. The venv commands create the default environment; a user who
 *  pointed --python at their own Python is told the flag is the other way
 *  out. */
export function pythonMissingMessage(python: string, home: string, problem: PythonProblem): string {
  const venv = defaultMlxEnv(home);
  const what =
    problem === "missing" ? `${python} does not exist.` : `${python} cannot import mlx_lm.`;
  return [
    what,
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
 *  port is not open. A reply other than 2xx is a misconfigured server, and
 *  the wait fails with the status and body. */
export async function waitUntilLoaded(
  port: number,
  upstreamModel: string,
  options: ReadinessOptions = {},
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const retryMs = options.retryMs ?? 500;
  // Raced against every attempt, so a process that exits while a request is
  // still open (the server blocks while loading) ends the wait at once.
  const goneFails: Promise<never> =
    options.gone === undefined
      ? new Promise<never>(() => {})
      : options.gone.then((why) => Promise.reject(new Error(`${why} before it was ready.`)));
  goneFails.catch(() => {});
  const body = JSON.stringify({
    model: upstreamModel,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
  });
  const attempt = async (): Promise<"ready" | "retry"> => {
    let res: Response;
    try {
      res = await fetchFn(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      return "retry";
    }
    if (res.ok) {
      return "ready";
    }
    const text = (await res.text()).slice(0, 500);
    throw new Error(
      `mlx_lm.server for ${upstreamModel} answered ${res.status} to the readiness request: ${text}`,
    );
  };
  for (;;) {
    const outcome = await Promise.race([attempt(), goneFails]);
    if (outcome === "ready") {
      return;
    }
    await Promise.race([new Promise((r) => setTimeout(r, retryMs)), goneFails]);
  }
}

export type ExecResult = { status: number | null; error?: { code?: string } };
export type Exec = (cmd: string, args: string[]) => ExecResult;

function execSync(cmd: string, args: string[]): ExecResult {
  const run = spawnSync(cmd, args, { stdio: "ignore" });
  return { status: run.status, error: run.error as { code?: string } | undefined };
}

/** Whether `python` exists and can import mlx_lm. */
export function checkPython(python: string, exec: Exec = execSync): PythonProblem | "ok" {
  const run = exec(python, ["-c", "import mlx_lm"]);
  if (run.error?.code === "ENOENT") {
    return "missing";
  }
  return run.status === 0 ? "ok" : "no-mlx-lm";
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
    const { repo, revision } = parseMlxUri(resolved.target);
    const dir = mlxModelDir(cacheDir, repo);
    const record = readMlxModelRecord(dir);
    if (record === null || !isMlxModelComplete(record)) {
      throw new Error(
        `${repo} is not downloaded. Run:\n  agency local download ${resolved.target}`,
      );
    }
    if (revision !== undefined && !record.revision.startsWith(revision)) {
      throw new Error(
        `${dir} holds ${repo} at ${record.revision.slice(0, 7)}, and you asked for ${revision}. Run:\n` +
          `  agency local download ${resolved.target}`,
      );
    }
    const sizeBytes = Object.values(record.files).reduce((sum, f) => sum + f.size, 0);
    return { name, dir, sizeBytes };
  }
  const dir = path.resolve(resolved.target);
  const sizeBytes = modelDirEntries(dir).reduce((sum, f) => sum + f.size, 0);
  return { name, dir, sizeBytes };
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
  const problem = checkPython(python, deps.exec);
  if (problem !== "ok") {
    throw new Error(pythonMissingMessage(python, deps.home, problem));
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
    exits.push(exitOf(child, model.name));
    deps.log(`Loading ${model.name} (${formatGB(model.sizeBytes)})…`);
    const started = Date.now();
    try {
      // Any process started so far dying ends the wait, not only this one.
      await waitUntilLoaded(internalPort, model.dir, {
        fetch: deps.fetch,
        gone: Promise.race(exits),
      });
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
  // A terminal Ctrl-C reaches the children before this process, so a
  // child's exit can arrive before the signal handler runs. Wait a moment
  // before calling it a failure.
  const failure = Promise.race(exits).then(async (why) => {
    await new Promise((r) => setTimeout(r, 250));
    return stopping ? new Promise<string>(() => {}) : `${why}.`;
  });
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
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const why = await handle.failure;
  console.error(why);
  await handle.close();
  process.exit(1);
}
