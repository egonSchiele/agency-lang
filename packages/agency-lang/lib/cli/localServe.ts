import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import prompts from "prompts";
import { isMlxUri, parseMlxUri, modelDirEntries } from "../stdlib/modelBackend.js";
import {
  _resolveModel,
  _mlxServedName,
  _localModelCategory,
  _listDownloadedModels,
  _findDownloadedMlxModel,
  defaultCacheDir,
  readClientConfig,
  formatGB,
  type DownloadedModel,
} from "../stdlib/localModels.js";
import { startFrontDoor, type FrontDoor, type Route } from "./mlxServer.js";
import { formatElapsed } from "../eval/run/statusBoard.js";
import { color, plainColor, autoUseColor } from "../utils/termcolors.js";

export { formatElapsed };

export type ServeKind = "chat" | "embedding";

/** Inputs an embedding model accepts, in tokens: the Qwen3 Embedding
 *  card's value. */
const EMBED_MAX_LENGTH = 8192;

export type ServeOptions = {
  port: number;
  maxTokens: number;
  python?: string;
  logPrompts?: boolean;
};

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

/** The argv for one embedding server process, after the Python path. */
export function embedServeArgs(
  script: string,
  modelDir: string,
  internalPort: number,
  maxLength: number,
): string[] {
  return [
    script,
    "--model",
    modelDir,
    "--host",
    "127.0.0.1",
    "--port",
    String(internalPort),
    "--max-length",
    String(maxLength),
  ];
}

/** How a process is named in messages: which program, for which model. */
function processLabel(kind: ServeKind, name: string): string {
  return kind === "embedding" ? `the embedding server for ${name}` : `mlx_lm.server for ${name}`;
}

export function defaultMlxEnv(home: string): string {
  return path.join(home, ".agency-agent", "mlx-env");
}

/** The embedding server shipped next to this file. `make build` copies it
 *  into dist, so the path holds for a development checkout and an install. */
export function embedServerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mlxEmbedServer.py");
}

/** The mlx-audio release the speech server's rules were written against.
 *  A test checks it matches MLX_AUDIO_VERSION in lib/cli/mlxSpeechRules.py;
 *  the server refuses any other version. */
export const MLX_AUDIO_VERSION = "0.5.4";

/** The speech server shipped next to this file, copied into dist like
 *  the embedding one. */
export function speechServerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mlxSpeechServer.py");
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
  /** An embedding process cannot answer a chat completion, so it is probed
   *  with an embeddings request instead. Default chat. */
  kind?: ServeKind;
};

/** The one-request probe for each kind of process. Both name the model the
 *  process was started with and ask for as little work as possible. */
function readinessRequest(kind: ServeKind, upstreamModel: string): { path: string; body: string } {
  if (kind === "embedding") {
    return { path: "/v1/embeddings", body: JSON.stringify({ model: upstreamModel, input: "hi" }) };
  }
  return {
    path: "/v1/chat/completions",
    body: JSON.stringify({
      model: upstreamModel,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    }),
  };
}

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
  const kind = options.kind ?? "chat";
  const probe = readinessRequest(kind, upstreamModel);
  const attempt = async (): Promise<"ready" | "retry"> => {
    let res: Response;
    try {
      res = await fetchFn(`http://127.0.0.1:${port}${probe.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: probe.body,
      });
    } catch {
      return "retry";
    }
    if (res.ok) {
      return "ready";
    }
    const text = (await res.text()).slice(0, 500);
    throw new Error(
      `${processLabel(kind, upstreamModel)} answered ${res.status} to the readiness request: ${text}`,
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
// The picker: what `agency local serve` offers when it is given no model.
// ---------------------------------------------------------------------------

export type ServeChoice = { title: string; value: string };

/** The models `serve` can start without downloading anything: the MLX ones
 *  under the models directory whose record says every file is there. A GGUF
 *  model runs in the Agency process instead, so it is never a choice here,
 *  and an embedding model needs --embedding, which the picker cannot say. */
export function serveChoices(downloaded: DownloadedModel[]): ServeChoice[] {
  // One row per repo id. The same model can sit in both layouts, and two rows
  // with the same value would let you pick it twice, which `runServe` refuses.
  const byRepo: Record<string, DownloadedModel> = {};
  for (const model of downloaded) {
    if (
      model.backend === "mlx" &&
      model.complete &&
      byRepo[model.name] === undefined &&
      _localModelCategory(`mlx:${model.name}`) !== "embedding"
    ) {
      byRepo[model.name] = model;
    }
  }
  return Object.values(byRepo)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ title: `${m.name}  (${formatGB(m.sizeBytes)})`, value: `mlx:${m.name}` }));
}

export type PickDeps = {
  downloaded: () => DownloadedModel[];
  /** Both ends of the terminal are a TTY, so a prompt can be drawn and read. */
  tty: boolean;
  /** Asks which models to serve. Null when the prompt was cancelled. */
  ask: (choices: ServeChoice[]) => Promise<string[] | null>;
};

/** The models to serve when the command line named none. An empty array
 *  means the user cancelled or ticked nothing, and the caller should exit
 *  without serving. Throws when there is nothing to offer, or when there is
 *  no terminal to ask on. */
export async function pickModelsToServe(deps: PickDeps): Promise<string[]> {
  const choices = serveChoices(deps.downloaded());
  if (choices.length === 0) {
    throw new Error("No MLX models are downloaded. Run:\n  agency local download mlx:<org>/<repo>");
  }
  if (!deps.tty) {
    // A script asked for a server and named no model. Say what it could
    // have named rather than waiting on a prompt nobody can answer.
    const names = choices.map((c) => `  ${c.value}`).join("\n");
    throw new Error(`Pass a model: agency local serve <name>\nDownloaded MLX models:\n${names}`);
  }
  const picked = await deps.ask(choices);
  return picked ?? [];
}

function realPickDeps(cacheDir: string): PickDeps {
  return {
    downloaded: () => _listDownloadedModels(cacheDir),
    tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: async (choices) => {
      const answer = await prompts({
        type: "multiselect",
        name: "models",
        message: "Which models do you want to serve?",
        hint: "space to select, enter to confirm",
        instructions: false,
        choices,
      });
      // Cancellation can surface as a missing key or as null.
      return (answer.models as string[] | undefined) ?? null;
    },
  };
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
  /** Whether the request log is colored. Off when stdout is not a terminal. */
  useColor: boolean;
};

export type ServeHandle = {
  port: number;
  models: string[];
  /** Resolves with a message when a process dies after it was ready. */
  failure: Promise<string>;
  close: () => Promise<void>;
};

export type ServeFlags = {
  port?: number;
  maxTokens?: number;
  python?: string;
  /** Print each request's prompt and reply under its summary line. The CLI
   *  spells this `--log-prompts`, since `--verbose` is already the whole
   *  CLI's own flag. */
  logPrompts?: boolean;
  /** Models to serve with the embedding server rather than mlx_lm.server. */
  embedding?: string[];
};

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
    useColor: autoUseColor(),
  };
}

type Planned = { name: string; dir: string; sizeBytes: number; kind: ServeKind };

/** The catalog knows what some models are for. Serving an embedding model
 *  as a chat model, or the reverse, fails only after a long load, so refuse
 *  it up front when the catalog can tell, from the name or from what it
 *  resolves to. */
function checkKind(value: string, target: string, kind: ServeKind): void {
  const category = _localModelCategory(value) ?? _localModelCategory(target);
  if (category === "embedding" && kind === "chat") {
    throw new Error(
      `${value} is an embedding model. Serve it with: agency local serve --embedding ${value}`,
    );
  }
  if (category !== undefined && category !== "embedding" && kind === "embedding") {
    throw new Error(
      `${value} is a ${category} model, not an embedding model. Pass it without --embedding.`,
    );
  }
}

/** One model to serve: the name requests will use, the directory to start
 *  the process on, its size for the memory warning, and which program
 *  serves it. */
function planModel(value: string, cacheDir: string, kind: ServeKind): Planned {
  const resolved = _resolveModel(value);
  checkKind(value, resolved.target, kind);
  if (resolved.backend === "llama-cpp") {
    throw new Error(
      `"${value}" is a GGUF model. agency local serve is for MLX models; ` +
        `run it with agency run --local ${value} instead.`,
    );
  }
  const name = _mlxServedName(resolved);
  if (isMlxUri(resolved.target)) {
    const { repo, revision } = parseMlxUri(resolved.target);
    // Whichever layout holds it, at the revision asked for: our own directory
    // with a record, or a Hugging Face cache someone else downloaded into.
    const found = _findDownloadedMlxModel(repo, cacheDir, revision);
    if (found !== null) {
      return { name, dir: found.path, sizeBytes: found.sizeBytes, kind };
    }
    const anyRevision = _findDownloadedMlxModel(repo, cacheDir);
    if (anyRevision === null) {
      throw new Error(
        `${repo} is not downloaded. Run:\n  agency local download ${resolved.target}`,
      );
    }
    const at = (anyRevision.revision ?? "").slice(0, 7);
    throw new Error(
      `${anyRevision.path} holds ${repo} at ${at}, and you asked for ${revision}. Run:\n` +
        `  agency local download ${resolved.target}`,
    );
  }
  const dir = path.resolve(resolved.target);
  const sizeBytes = modelDirEntries(dir).reduce((sum, f) => sum + f.size, 0);
  return { name, dir, sizeBytes, kind };
}

/** Resolves with a description once the child exits. */
function exitOf(child: Child, name: string, kind: ServeKind): Promise<string> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      const how = signal !== null ? `was killed by ${signal}` : `exited with ${code}`;
      resolve(`${processLabel(kind, name)} ${how}`);
    });
  });
}

export function servingBanner(port: number, chat: string[], embedding: string[]): string[] {
  const count = chat.length + embedding.length;
  const lines = [`Serving ${count} model${count === 1 ? "" : "s"} on http://127.0.0.1:${port}/v1:`];
  for (const m of chat) {
    lines.push(`  ${m}`);
  }
  for (const m of embedding) {
    lines.push(`  ${m}  (embeddings)`);
  }
  if (chat.length > 0) {
    const first = chat[0];
    const spelled = path.isAbsolute(first) ? first : `mlx:${first}`;
    lines.push(
      "",
      `  agency run --local ${spelled} your.agency`,
      `  agency agent --local ${spelled}`,
    );
  }
  if (embedding.length > 0) {
    lines.push(
      "",
      "  For memory, set in agency.json:",
      `    "memory": { "dir": ".agency-memory", "embeddings": { "model": "${embedding[0]}", "provider": "mlx" } }`,
    );
  }
  return lines;
}

export async function runServe(
  values: string[],
  flags: ServeFlags,
  deps: ServeDeps = realDeps(),
): Promise<ServeHandle> {
  const port = flags.port ?? 8080;
  const maxTokens = flags.maxTokens ?? 16384;
  const planned = [
    ...values.map((v) => planModel(v, deps.cacheDir, "chat")),
    ...(flags.embedding ?? []).map((v) => planModel(v, deps.cacheDir, "embedding")),
  ];
  if (planned.length === 0) {
    throw new Error("Name at least one model to serve.");
  }
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
    const args =
      model.kind === "embedding"
        ? embedServeArgs(embedServerScript(), model.dir, internalPort, EMBED_MAX_LENGTH)
        : serveArgs(model.dir, internalPort, maxTokens);
    const child = deps.spawn(python, args);
    children.push(child);
    exits.push(exitOf(child, model.name, model.kind));
    deps.log(`Loading ${model.name} (${formatGB(model.sizeBytes)})…`);
    const started = Date.now();
    try {
      // Any process started so far dying ends the wait, not only this one.
      await waitUntilLoaded(internalPort, model.dir, {
        fetch: deps.fetch,
        gone: Promise.race(exits),
        kind: model.kind,
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
    door = await startFrontDoor(port, routes, {
      log: deps.log,
      verbose: flags.logPrompts === true,
      color: deps.useColor ? color : plainColor,
    });
  } catch (err) {
    killAll();
    throw err;
  }
  const namesOf = (kind: ServeKind) => planned.filter((p) => p.kind === kind).map((p) => p.name);
  for (const line of servingBanner(door.port, namesOf("chat"), namesOf("embedding"))) {
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

/** The CLI entry: serve until Ctrl-C, or until a process dies. With no
 *  model named, ask which of the downloaded ones to serve. */
export async function localServe(values: string[], flags: ServeFlags): Promise<void> {
  let handle: ServeHandle;
  try {
    const wantsPicker = values.length === 0 && (flags.embedding ?? []).length === 0;
    const models = wantsPicker ? await pickModelsToServe(realPickDeps(defaultCacheDir())) : values;
    if (wantsPicker && models.length === 0) {
      // Cancelled, or nothing ticked: nothing to serve, and nothing wrong.
      return;
    }
    handle = await runServe(models, flags);
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
