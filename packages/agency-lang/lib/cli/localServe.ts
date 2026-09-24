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
import type { ModelCategory } from "../stdlib/modelCatalog.js";
import { startFrontDoor, type FrontDoor, type Route } from "./mlxServer.js";
import { formatElapsed } from "../eval/run/statusBoard.js";
import { color, plainColor, autoUseColor } from "../utils/termcolors.js";

export { formatElapsed };

export type ServeKind = "chat" | "embedding" | "speech";

/** Inputs an embedding model accepts, in tokens: the Qwen3 Embedding
 *  card's value. */
const EMBED_MAX_LENGTH = 8192;

export type ServeOptions = {
  port: number;
  maxTokens: number;
  python?: string;
  logPrompts?: boolean;
};

/** The argv for one chat server process, after the Python path. The
 *  script is mlx_lm.server with structured output added; it takes
 *  mlx_lm.server's own options. */
export function serveArgs(
  script: string,
  modelDir: string,
  internalPort: number,
  maxTokens: number,
): string[] {
  return [
    script,
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

/** The argv for one speech server process, after the Python path. The
 *  models directory is where the script looks for a companion repo the
 *  model loads by name, such as Orpheus's SNAC decoder. */
export function speechServeArgs(
  script: string,
  modelDir: string,
  internalPort: number,
  modelsDir: string,
): string[] {
  return [
    script,
    "--model",
    modelDir,
    "--host",
    "127.0.0.1",
    "--port",
    String(internalPort),
    "--models-dir",
    modelsDir,
  ];
}

/** The argv for one process, by its kind. */
function argsFor(
  model: Planned,
  internalPort: number,
  maxTokens: number,
  modelsDir: string,
): string[] {
  if (model.kind === "embedding") {
    return embedServeArgs(embedServerScript(), model.dir, internalPort, EMBED_MAX_LENGTH);
  }
  if (model.kind === "speech") {
    return speechServeArgs(speechServerScript(), model.dir, internalPort, modelsDir);
  }
  return serveArgs(chatServerScript(), model.dir, internalPort, maxTokens);
}

/** How a process is named in messages: which program, for which model. */
function processLabel(kind: ServeKind, name: string): string {
  if (kind === "embedding") {
    return `the embedding server for ${name}`;
  }
  if (kind === "speech") {
    return `the speech server for ${name}`;
  }
  return `mlx_lm.server for ${name}`;
}

export function defaultMlxEnv(home: string): string {
  return path.join(home, ".agency-agent", "mlx-env");
}

/** The chat server shipped next to this file: mlx_lm.server with
 *  `response_format` honoured. `make build` copies it into dist, so the
 *  path holds for a development checkout and an install. */
export function chatServerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mlxChatServer.py");
}

/** The mlx-lm release the chat server script was written against. The
 *  script reaches into mlx_lm.server's internals, so a new release needs
 *  those seams checked before the pin moves. */
export const MLX_LM_VERSION = "0.31.3";

/** The llguidance release the chat server enforces schemas with. */
export const LLGUIDANCE_VERSION = "1.8.0";

/** The embedding server shipped next to this file, copied into dist like
 *  the chat one. */
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

/** The Python modules each kind of process imports. */
const MODULES_FOR_KIND: Record<ServeKind, string[]> = {
  chat: ["mlx_lm", "llguidance"],
  embedding: ["mlx_lm"],
  speech: ["mlx_audio"],
};

/** What a module that will not import means. */
const PROBLEM_FOR_MODULE: Record<string, PythonProblem> = {
  mlx_lm: "no-mlx-lm",
  llguidance: "no-llguidance",
  mlx_audio: "no-mlx-audio",
};

/** The pip requirement that provides each module. */
const PIP_FOR_MODULE: Record<string, string> = {
  mlx_lm: `mlx-lm==${MLX_LM_VERSION}`,
  llguidance: `llguidance==${LLGUIDANCE_VERSION}`,
  mlx_audio: `mlx-audio==${MLX_AUDIO_VERSION}`,
};

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

export type PythonProblem = "missing" | "no-mlx-lm" | "no-llguidance" | "no-mlx-audio";

/** What to print when the chosen Python is not there, or cannot import a
 *  module the planned kinds need. The venv commands create the default
 *  environment with every module in `modules`; a user who pointed --python
 *  at their own Python is told the flag is the other way out. */
export function pythonMissingMessage(
  python: string,
  home: string,
  problem: PythonProblem,
  modules: string[] = ["mlx_lm"],
): string {
  const venv = defaultMlxEnv(home);
  const pip = path.join(venv, "bin", "pip");
  if (problem === "no-mlx-audio" || problem === "no-llguidance") {
    const module = problem === "no-mlx-audio" ? "mlx_audio" : "llguidance";
    const requirement = PIP_FOR_MODULE[module];
    return [
      `${python} cannot import ${module}.`,
      "Agency does not install Python. Install it once:",
      "",
      `  ${pip} install ${requirement}`,
      "",
      `Or point --python at a Python that has ${requirement} installed.`,
    ].join("\n");
  }
  const what =
    problem === "missing" ? `${python} does not exist.` : `${python} cannot import mlx_lm.`;
  return [
    what,
    "Agency does not install Python. Create an environment once:",
    "",
    `  python3.12 -m venv ${venv}`,
    `  ${pip} install ${modules.map((m) => PIP_FOR_MODULE[m]).join(" ")}`,
    "",
    "Python 3.11 or newer is required. Or point --python at a Python that has",
    `${modules.map((m) => PIP_FOR_MODULE[m]).join(" and ")} installed.`,
  ].join("\n");
}

export type ReadinessOptions = {
  fetch?: typeof fetch;
  retryMs?: number;
  /** Resolves with what happened ("mlx_lm.server for X exited with 1") when
   *  the process exits. Readiness stops waiting and rejects. */
  gone?: Promise<string>;
  /** An embedding process cannot answer a chat completion, so it is probed
   *  with an embeddings request instead, and a speech process with GET
   *  /health. Default chat. */
  kind?: ServeKind;
};

type Probe = { method: "GET" | "POST"; path: string; body?: string };

/** The one-request probe for each kind of process. The chat and embedding
 *  probes name the model the process was started with and ask for as little
 *  work as possible. The speech script speaks once before it opens its port,
 *  so an answer on /health already means it can speak; which family needs
 *  what stays in the Python rules module. */
function readinessRequest(kind: ServeKind, upstreamModel: string): Probe {
  if (kind === "embedding") {
    return {
      method: "POST",
      path: "/v1/embeddings",
      body: JSON.stringify({ model: upstreamModel, input: "hi" }),
    };
  }
  if (kind === "speech") {
    return { method: "GET", path: "/health" };
  }
  return {
    method: "POST",
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
        method: probe.method,
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

/** Whether `python` exists and can import each module. The first missing
 *  module names the problem. */
export function checkPython(
  python: string,
  exec: Exec = execSync,
  modules: string[] = ["mlx_lm"],
): PythonProblem | "ok" {
  for (const module of modules) {
    const run = exec(python, ["-c", `import ${module}`]);
    if (run.error?.code === "ENOENT") {
      return "missing";
    }
    if (run.status !== 0) {
      return PROBLEM_FOR_MODULE[module];
    }
  }
  return "ok";
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
 *  and an embedding or speech model needs a flag, which the picker cannot
 *  say. */
export function serveChoices(downloaded: DownloadedModel[]): ServeChoice[] {
  // One row per repo id. The same model can sit in both layouts, and two rows
  // with the same value would let you pick it twice, which `runServe` refuses.
  const byRepo: Record<string, DownloadedModel> = {};
  for (const model of downloaded) {
    if (
      model.backend === "mlx" &&
      model.complete &&
      byRepo[model.name] === undefined &&
      !needsFlag(_localModelCategory(`mlx:${model.name}`))
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
  /** Models to serve with the speech server on /v1/audio/speech. */
  speech?: string[];
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

/** The flag a catalog category has to be served with. Chat models take no
 *  flag. */
const FLAG_FOR_CATEGORY: Partial<Record<ModelCategory, string>> = {
  embedding: "--embedding",
  speech: "--speech",
};

/** Whether a catalog category has to be served with a flag. */
function needsFlag(category: ModelCategory | undefined): boolean {
  return category !== undefined && FLAG_FOR_CATEGORY[category] !== undefined;
}

function anArticle(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** The catalog knows what some models are for. Serving an embedding model
 *  as a chat model, or the reverse, fails only after a long load, so refuse
 *  it up front when the catalog can tell, from the name or from what it
 *  resolves to. */
function checkKind(value: string, target: string, kind: ServeKind): void {
  const category = _localModelCategory(value) ?? _localModelCategory(target);
  if (category === undefined) {
    return;
  }
  const wanted = FLAG_FOR_CATEGORY[category];
  if (kind === "chat" && wanted !== undefined) {
    throw new Error(
      `${value} is ${anArticle(category)} model. Serve it with: agency local serve ${wanted} ${value}`,
    );
  }
  if (kind !== "chat" && category !== kind) {
    // Name the flag that works, so the user is not sent through a second
    // refusal on the way there.
    const fix =
      wanted === undefined
        ? `Pass it without ${FLAG_FOR_CATEGORY[kind]}.`
        : `Serve it with: agency local serve ${wanted} ${value}`;
    throw new Error(
      `${value} is ${anArticle(category)} model, not ${anArticle(kind)} model. ${fix}`,
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

export type ServedModel = { name: string; kind: ServeKind };

/** The suffix after a model's name in the banner. Chat models get none. */
const BANNER_SUFFIX: Record<ServeKind, string> = {
  chat: "",
  embedding: "  (embeddings)",
  speech: "  (speech)",
};

/** What `serve` prints once every process is ready: the models, in plan
 *  order, and a sample command for the first model of each kind. */
export function servingBanner(port: number, models: ServedModel[]): string[] {
  const count = models.length;
  const lines = [`Serving ${count} model${count === 1 ? "" : "s"} on http://127.0.0.1:${port}/v1:`];
  for (const model of models) {
    lines.push(`  ${model.name}${BANNER_SUFFIX[model.kind]}`);
  }
  const first = (kind: ServeKind) => models.find((model) => model.kind === kind)?.name;
  const chat = first("chat");
  if (chat !== undefined) {
    const spelled = path.isAbsolute(chat) ? chat : `mlx:${chat}`;
    lines.push(
      "",
      `  agency run --local ${spelled} your.agency`,
      `  agency agent --local ${spelled}`,
    );
  }
  const embedding = first("embedding");
  if (embedding !== undefined) {
    lines.push(
      "",
      "  For memory, set in agency.json:",
      `    "memory": { "dir": ".agency-memory", "embeddings": { "model": "${embedding}", "provider": "mlx" } }`,
    );
  }
  const speech = first("speech");
  if (speech !== undefined) {
    lines.push(
      "",
      "  In Agency code:",
      `    import { speakLocal } from "std::speech"`,
      `    speakLocal("Hello there.", "${speech}")`,
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
    ...(flags.speech ?? []).map((v) => planModel(v, deps.cacheDir, "speech")),
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
  // The modules the planned kinds import, each once, in plan order.
  const modules = planned
    .flatMap((model) => MODULES_FOR_KIND[model.kind])
    .filter((module, index, all) => all.indexOf(module) === index);
  const problem = checkPython(python, deps.exec, modules);
  if (problem !== "ok") {
    throw new Error(pythonMissingMessage(python, deps.home, problem, modules));
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
    const args = argsFor(model, internalPort, maxTokens, deps.cacheDir);
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
    routes.push({
      model: model.name,
      upstreamModel: model.dir,
      port: internalPort,
      label: processLabel(model.kind, model.name),
    });
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
  for (const line of servingBanner(door.port, planned)) {
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
    const wantsPicker =
      values.length === 0 &&
      (flags.embedding ?? []).length === 0 &&
      (flags.speech ?? []).length === 0;
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
