import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import prompts from "prompts";
import {
  isServedUri,
  parseServedUri,
  modelDirSizeBytes,
  type ServedBackend,
} from "../stdlib/modelBackend.js";
import { IMAGES_PATH } from "./serveLog.js";
import {
  _resolveModel,
  _mlxServedName,
  _modelKind,
  _catalogKind,
  _listDownloadedModels,
  _findDownloadedServedModel,
  defaultCacheDir,
  configuredAdaptersDir,
  readClientConfig,
  formatGB,
  type DownloadedModel,
  type ResolvedModel,
} from "../stdlib/localModels.js";
import type { ModelKind } from "../stdlib/modelKind.js";
import { startFrontDoor, type FrontDoor, type Route } from "./mlxServer.js";
import { formatElapsed } from "../eval/run/statusBoard.js";
import { color, plainColor, autoUseColor } from "../utils/termcolors.js";

export { formatElapsed };

export type ServeKind = ModelKind;

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
  settings: ChatServerSettings,
): string[] {
  const args = [
    script,
    "--model",
    modelDir,
    "--host",
    "127.0.0.1",
    "--port",
    String(internalPort),
    "--max-tokens",
    String(settings.maxTokens),
    "--prompt-cache-bytes",
    String(settings.promptCacheBytes),
    "--prefill-step-size",
    String(settings.prefillStepSize),
    "--log-level",
    "INFO",
  ];
  for (const [key, flag] of LIMIT_FLAGS) {
    const value = settings.limits[key];
    if (value !== undefined) {
      args.push(flag, String(value));
    }
  }
  if (settings.limits.limitAnswers === true) {
    args.push("--limit-answers");
  }
  if (settings.draft !== undefined) {
    args.push(
      "--draft-model",
      settings.draft.dir,
      "--num-draft-tokens",
      String(settings.draft.tokens),
    );
  }
  return args;
}

/** What one chat server is started with, beyond its model and port. */
/** One model from the `serve` command line with the options written after
 *  it. */
export type ServeTarget = { model: string } & ModelOptions;

/** The per-model options and how each one is spelled. */
const MODEL_OPTION_FLAGS = ["--draft", "--draft-tokens"];

/** The flags that name a model rather than set an option, so the model
 *  after them is a target too. */
const MODEL_NAMING_FLAGS = ["--embedding", "--speech", "--image"];

/** Groups the arguments after `serve` into one entry per model, each with
 *  the per-model options that followed it. `agency local serve a --draft d
 *  b` drafts for `a` and not `b`. Any other flag belongs to the command as
 *  a whole and is left for the option parser; its value, if the next token
 *  is not a flag, is skipped with it. A parser, so its order is its
 *  nature; it holds nothing but what it returns. */
export function groupServeArgv(argv: string[]): ServeTarget[] {
  const targets: ServeTarget[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    const value = argv[index + 1];
    const current = targets[targets.length - 1];
    if (MODEL_OPTION_FLAGS.includes(token)) {
      if (current === undefined) {
        throw new Error(
          `${token} goes after the model it is for: agency local serve <model> ${token} ${value ?? "<value>"}`,
        );
      }
      if (token === "--draft") {
        current.draft = value;
      } else {
        current.draftTokens = Number(value);
      }
      index += 2;
    } else if (MODEL_NAMING_FLAGS.includes(token)) {
      if (value !== undefined) {
        targets.push({ model: value });
      }
      index += 2;
    } else if (token.startsWith("--")) {
      // A command-wide flag. Its value, when it has one, is the next token
      // unless that is itself a flag or the flag was written as --x=y.
      const takesValue = !token.includes("=") && value !== undefined && !value.startsWith("--");
      index += takesValue ? 2 : 1;
    } else {
      targets.push({ model: token });
      index += 1;
    }
  }
  return targets;
}

/** The per-model options from grouped targets, keyed by model, for
 *  `ServeFlags.options`. */
export function optionsByModel(targets: ServeTarget[]): Record<string, ModelOptions> {
  const out: Record<string, ModelOptions> = {};
  for (const target of targets) {
    const { model, ...options } = target;
    if (Object.keys(options).length > 0) {
      out[model] = options;
    }
  }
  return out;
}

export type ChatServerSettings = {
  maxTokens: number;
  promptCacheBytes: number;
  prefillStepSize: number;
  limits: ReplyLimits;
  /** A smaller model of the same family that drafts tokens for this one to
   *  check (speculative decoding), and how many it drafts at a time. */
  draft?: { dir: string; tokens: number };
};

/** How many tokens the draft model guesses before the main model checks
 *  them. Too few and the check happens too often; too many and most of a
 *  guess is thrown away. mlx_lm's own default is 3; 4 is a little better
 *  on the prose most replies are. */
export const DEFAULT_DRAFT_TOKENS = 4;

/** How many tokens of prompt the server reads in one pass. A long prompt
 *  is read in chunks of this size. A bigger chunk keeps the GPU busier, so
 *  a long prompt is read sooner, but the attention scores of one chunk
 *  against the whole prompt have to fit in memory at once. mlx_lm's default
 *  of 2048 suits a small machine; a machine with the memory to spare reads
 *  a 20,000-token prompt noticeably faster in chunks of 8192. */
export function prefillStepSize(totalMemBytes: number): number {
  const gb = totalMemBytes / 1024 ** 3;
  if (gb >= 128) {
    return 8192;
  }
  if (gb >= 64) {
    return 4096;
  }
  return 2048;
}

/** How far a reply may go before the chat server cuts it short. Each is a
 *  count, 0 turns one off, and an absent one leaves the script's default.
 *  See the guide on local models for what each one watches. */
export type ReplyLimits = {
  reasoningBudget?: number;
  hedgeLimit?: number;
  repeatLimit?: number;
  /** Watch answers for hedging and repeats too, not only thinking. */
  limitAnswers?: boolean;
};

const LIMIT_FLAGS: ["reasoningBudget" | "hedgeLimit" | "repeatLimit", string][] = [
  ["reasoningBudget", "--reasoning-budget"],
  ["hedgeLimit", "--hedge-limit"],
  ["repeatLimit", "--repeat-limit"],
];

/** How much memory one chat server may spend on attention state: the
 *  replies it is generating plus its cache of recent prompts, which lets a
 *  follow-up on the same conversation skip re-reading it. mlx_lm.server
 *  keeps the last ten prompts and, with no byte limit, keeps them whatever
 *  their size; a few long prompts to a large model add tens of gigabytes to
 *  a process that already holds the whole model, and the server dies of
 *  GPU memory. A sixteenth of the machine's memory is enough for about
 *  eighty thousand tokens of a 235B model on a 256GB Mac, and about sixteen
 *  thousand tokens of an 8B model on a 32GB one. */
export function promptCacheBudget(totalMemBytes: number): number {
  return Math.floor(totalMemBytes / 16);
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

/** The argv for one image server process, after the Python path. The
 *  adapters folder goes along when one is configured, so a request can
 *  name a LoRA adapter in it. */
export function imageServeArgs(
  script: string,
  modelDir: string,
  internalPort: number,
  adaptersDir: string | null = null,
): string[] {
  const args = [script, "--model", modelDir, "--host", "127.0.0.1", "--port", String(internalPort)];
  if (adaptersDir !== null) {
    args.push("--adapters-dir", adaptersDir);
  }
  return args;
}

/** The argv for one process, by its kind. */
function argsFor(
  model: Planned,
  internalPort: number,
  settings: ChatServerSettings,
  modelsDir: string,
  adaptersDir: string | null,
): string[] {
  if (model.kind === "embedding") {
    return embedServeArgs(embedServerScript(), model.dir, internalPort, EMBED_MAX_LENGTH);
  }
  if (model.kind === "speech") {
    return speechServeArgs(speechServerScript(), model.dir, internalPort, modelsDir);
  }
  if (model.kind === "image") {
    return imageServeArgs(imageServerScript(), model.dir, internalPort, adaptersDir);
  }
  return serveArgs(chatServerScript(), model.dir, internalPort, settings);
}

/** How a process is named in messages: which program, for which model. */
function processLabel(kind: ServeKind, name: string): string {
  if (kind === "embedding") {
    return `the embedding server for ${name}`;
  }
  if (kind === "speech") {
    return `the speech server for ${name}`;
  }
  if (kind === "image") {
    return `the image server for ${name}`;
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

/** The diffusers release the image server's rules were written against.
 *  A test checks it matches DIFFUSERS_VERSION in
 *  lib/cli/diffusersImageRules.py; the server refuses any other version. */
export const DIFFUSERS_VERSION = "0.40.0";

/** The releases the image server was tested with alongside diffusers. */
export const TORCH_VERSION = "2.14.0";
export const TRANSFORMERS_VERSION = "5.17.0";
export const ACCELERATE_VERSION = "1.15.0";

/** Everything the image server needs, pinned to the versions it was tested
 *  with. sentencepiece and protobuf are Chroma's T5 tokenizer. A missing
 *  image module is fixed by installing all of these at once. */
const IMAGE_REQUIREMENTS = [
  `torch==${TORCH_VERSION}`,
  `diffusers==${DIFFUSERS_VERSION}`,
  `transformers==${TRANSFORMERS_VERSION}`,
  `accelerate==${ACCELERATE_VERSION}`,
  "sentencepiece==0.2.2",
  "protobuf==7.36.2",
].join(" ");

/** The image server shipped next to this file, copied into dist like the
 *  speech one. */
export function imageServerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "diffusersImageServer.py");
}

/** The Python modules each kind of process imports. */
const MODULES_FOR_KIND: Record<ServeKind, string[]> = {
  chat: ["mlx_lm", "llguidance"],
  embedding: ["mlx_lm"],
  speech: ["mlx_audio"],
  // accelerate is optional to diffusers, but without it a model loads
  // several times slower and with more memory.
  image: ["torch", "diffusers", "transformers", "accelerate"],
};

/** The pip requirement that provides each module. */
const PIP_FOR_MODULE: Record<string, string> = {
  mlx_lm: `mlx-lm==${MLX_LM_VERSION}`,
  llguidance: `llguidance==${LLGUIDANCE_VERSION}`,
  mlx_audio: `mlx-audio==${MLX_AUDIO_VERSION}`,
  torch: IMAGE_REQUIREMENTS,
  diffusers: IMAGE_REQUIREMENTS,
  transformers: IMAGE_REQUIREMENTS,
  accelerate: IMAGE_REQUIREMENTS,
};

/** The pip requirements for `modules`, each once. The image modules share
 *  one requirement line. */
function requirementsFor(modules: string[]): string[] {
  return modules
    .map((m) => PIP_FOR_MODULE[m])
    .filter((requirement, index, all) => all.indexOf(requirement) === index);
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

/** How a model asked for on each path is served: the flag it needs and
 *  the URI prefix a bare repo id takes. A path not listed here is a chat
 *  request, which takes no flag. */
const SERVE_FOR_PATH: Record<string, { flag: string; backend: ServedBackend }> = {
  [IMAGES_PATH]: { flag: "--image", backend: "diffusers" },
  "/v1/audio/speech": { flag: "--speech", backend: "mlx" },
  "/v1/embeddings": { flag: "--embedding", backend: "mlx" },
};

/** The 404 body for a request naming a model this server was not started
 *  with. The path the request came in on says which flag the model needs
 *  and, for a bare repo id, which URI prefix; a directory is named by its
 *  path. */
export function notServedMessage(served: string[], requested: string, requestPath: string): string {
  const serve = SERVE_FOR_PATH[requestPath];
  const backend = serve?.backend ?? "mlx";
  const target =
    path.isAbsolute(requested) || isServedUri(requested) ? requested : `${backend}:${requested}`;
  const args = serve === undefined ? target : `${serve.flag} ${target}`;
  return (
    `This server is serving ${joinNames(served)}. It is not serving ${requested}. ` +
    `Start it with: agency local serve ${args}`
  );
}

/** Why a Python cannot serve: it is not there, or it cannot import a module
 *  one of the planned kinds needs. */
export type PythonProblem = { kind: "missing" } | { kind: "cannot-import"; module: string };

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
  // A Python that has mlx_lm but not another module is an environment the
  // user made and only needs one more package. Any other problem gets the
  // commands that create the default environment from nothing.
  if (problem.kind === "cannot-import" && problem.module !== "mlx_lm") {
    const requirement = PIP_FOR_MODULE[problem.module];
    return [
      `${python} cannot import ${problem.module}.`,
      "Agency does not install Python. Install it once:",
      "",
      `  ${pip} install ${requirement}`,
      "",
      `Or point --python at a Python that has ${requirement} installed.`,
    ].join("\n");
  }
  const what =
    problem.kind === "missing" ? `${python} does not exist.` : `${python} cannot import mlx_lm.`;
  return [
    what,
    "Agency does not install Python. Create an environment once:",
    "",
    `  python3.12 -m venv ${venv}`,
    `  ${pip} install ${requirementsFor(modules).join(" ")}`,
    "",
    "Python 3.11 or newer is required. Or point --python at a Python that has",
    `${requirementsFor(modules).join(" and ")} installed.`,
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
 *  work as possible. The speech and image scripts generate once before they
 *  open their port, so an answer on /health already means they can
 *  generate; which family needs what stays in the Python rules modules. */
function readinessRequest(kind: ServeKind, upstreamModel: string): Probe {
  if (kind === "embedding") {
    return {
      method: "POST",
      path: "/v1/embeddings",
      body: JSON.stringify({ model: upstreamModel, input: "hi" }),
    };
  }
  if (kind === "speech" || kind === "image") {
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
      return { kind: "missing" };
    }
    if (run.status !== 0) {
      return { kind: "cannot-import", module };
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

/** The models `serve` can start without downloading anything: every model
 *  under the models directory whose record says every file is there, of
 *  any kind. A GGUF model runs in the Agency process instead, so it is
 *  never a choice here. */
export function serveChoices(downloaded: DownloadedModel[]): ServeChoice[] {
  // One row per repo id. The same model can sit in both layouts, and two rows
  // with the same value would let you pick it twice, which `runServe` refuses.
  const byRepo: Record<string, DownloadedModel> = {};
  for (const model of downloaded) {
    if (model.backend !== "llama-cpp" && model.complete && byRepo[model.name] === undefined) {
      byRepo[model.name] = model;
    }
  }
  return Object.values(byRepo)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      const kind = m.kind === undefined ? "" : `, ${m.kind}`;
      return {
        title: `${m.name}  (${formatGB(m.sizeBytes)}${kind})`,
        value: `${m.backend}:${m.name}`,
      };
    });
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
    throw new Error("No models are downloaded. Run:\n  agency local download <name>");
  }
  if (!deps.tty) {
    // A script asked for a server and named no model. Say what it could
    // have named rather than waiting on a prompt nobody can answer.
    const names = choices.map((c) => `  ${c.value}`).join("\n");
    throw new Error(`Pass a model: agency local serve <name>\nDownloaded models:\n${names}`);
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
  /** `client.adaptersDir`, absolute, or null when unset. */
  adaptersDir: string | null;
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

/** The options one served model takes for itself, written after it on the
 *  command line: `agency local serve <model> --draft <small> --draft-tokens 3`. */
export type ModelOptions = {
  /** A smaller model of the same family that drafts tokens for this one,
   *  for speculative decoding. The same forms as a served model. */
  draft?: string;
  /** How many tokens the draft guesses at a time. Default DEFAULT_DRAFT_TOKENS. */
  draftTokens?: number;
};

export type ServeFlags = ReplyLimits & {
  port?: number;
  maxTokens?: number;
  /** Per-model options, keyed by the model as it was named on the command
   *  line. `groupServeArgv` builds this from the argv order. */
  options?: Record<string, ModelOptions>;
  /** Tokens of prompt read per pass. Default from the machine's memory,
   *  see prefillStepSize. */
  prefillStep?: number;
  python?: string;
  /** Print each request's prompt and reply under its summary line. The CLI
   *  spells this `--log-prompts`, since `--verbose` is already the whole
   *  CLI's own flag. */
  logPrompts?: boolean;
  /** Models to serve with the embedding server rather than mlx_lm.server. */
  embedding?: string[];
  /** Models to serve with the speech server on /v1/audio/speech. */
  speech?: string[];
  /** Models to serve with the image server on /v1/images/generations. */
  image?: string[];
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
    adaptersDir: configuredAdaptersDir(),
    useColor: autoUseColor(),
  };
}

type Planned = {
  name: string;
  dir: string;
  sizeBytes: number;
  kind: ServeKind;
  /** The chat model that drafts for this one, planned the same way. */
  draft?: { name: string; dir: string; sizeBytes: number; tokens: number };
};

/** The flag a kind may be named with on the command line. None is needed:
 *  `serve` reads the kind from the model. A flag asserts it. */
const FLAG_FOR_KIND: Record<ServeKind, string> = {
  chat: "",
  embedding: "--embedding",
  speech: "--speech",
  image: "--image",
};

function anArticle(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** The command that serves `value` as what it is. */
function serveCommand(value: string, kind: ServeKind): string {
  const flag = FLAG_FOR_KIND[kind];
  return `agency local serve ${flag === "" ? "" : `${flag} `}${value}`;
}

/** A model named with a kind's flag must be that kind. Serving an embedding
 *  model as a chat model, or the reverse, fails only after a long load, so
 *  the flag refuses up front and names the command that works. */
function assertKind(value: string, actual: ServeKind, flagged: ServeKind): void {
  if (actual !== flagged) {
    throw new Error(
      `${value} is ${anArticle(actual)} model, not ${anArticle(flagged)} model. ` +
        `Serve it with: ${serveCommand(value, actual)}`,
    );
  }
}

/** The directory a resolved served model is in, at the revision asked for,
 *  in whichever layout holds it: our own directory with a record, or a
 *  Hugging Face cache someone else downloaded into. */
function servedModelLocation(
  resolved: ResolvedModel,
  cacheDir: string,
): { dir: string; sizeBytes: number } {
  if (!isServedUri(resolved.target)) {
    const dir = path.resolve(resolved.target);
    return { dir, sizeBytes: modelDirSizeBytes(dir) };
  }
  const { backend, repo, revision } = parseServedUri(resolved.target);
  const found = _findDownloadedServedModel(backend, repo, cacheDir, revision);
  if (found !== null) {
    return { dir: found.path, sizeBytes: found.sizeBytes };
  }
  const anyRevision = _findDownloadedServedModel(backend, repo, cacheDir);
  if (anyRevision === null) {
    throw new Error(`${repo} is not downloaded. Run:\n  agency local download ${resolved.target}`);
  }
  const at = (anyRevision.revision ?? "").slice(0, 7);
  throw new Error(
    `${anyRevision.path} holds ${repo} at ${at}, and you asked for ${revision}. Run:\n` +
      `  agency local download ${resolved.target}`,
  );
}

/** One model to serve: the name requests will use, the directory to start
 *  the process on, its size for the memory warning, and its kind, which
 *  picks the program that serves it. The kind comes from the catalog, the
 *  download's record, or the files, in that order. */
function planModel(value: string, cacheDir: string): Planned {
  const resolved = _resolveModel(value);
  if (resolved.backend === "llama-cpp") {
    throw new Error(
      `"${value}" is a GGUF model. agency local serve is for MLX and diffusers models; ` +
        `run it with agency run --local ${value} instead.`,
    );
  }
  const name = _mlxServedName(resolved);
  const { dir, sizeBytes } = servedModelLocation(resolved, cacheDir);
  const kind = _modelKind(value, dir);
  if (kind === null) {
    throw new Error(
      `${value} is a model directory of a shape agency does not know. Say what it is when ` +
        `downloading: agency local download --kind <chat|embedding|speech|image> ${value}`,
    );
  }
  return { name, dir, sizeBytes, kind };
}

/** The planned model with its draft attached, when its options name one.
 *  The draft is planned like a served model, so it is found, checked, and
 *  sized the same way, but it gets no route: requests go to the model it
 *  drafts for. Only a chat model can take one. */
function withDraft(
  value: string,
  model: Planned,
  options: ModelOptions | undefined,
  cacheDir: string,
): Planned {
  if (options?.draft === undefined) {
    return model;
  }
  if (model.kind !== "chat") {
    throw new Error(
      `--draft goes after a chat model, and ${value} is ${anArticle(model.kind)} model.`,
    );
  }
  const draft = planModel(options.draft, cacheDir);
  assertKind(options.draft, draft.kind, "chat");
  return {
    ...model,
    draft: {
      name: draft.name,
      dir: draft.dir,
      sizeBytes: draft.sizeBytes,
      tokens: options.draftTokens ?? DEFAULT_DRAFT_TOKENS,
    },
  };
}

/** The chat server settings for one model: the shared ones plus its draft. */
function settingsFor(model: Planned, shared: ChatServerSettings): ChatServerSettings {
  if (model.draft === undefined) {
    return shared;
  }
  return { ...shared, draft: { dir: model.draft.dir, tokens: model.draft.tokens } };
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
  image: "  (images)",
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
  const image = first("image");
  if (image !== undefined) {
    lines.push(
      "",
      "  In Agency code:",
      `    import { generateImageLocal } from "std::image"`,
      `    generateImageLocal("a lighthouse in a storm", "${image}")`,
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
  // A model named on its own is served as whatever it is. One named with a
  // flag must be that kind. Either way it gets the options written after it.
  const planNamed = (value: string): Planned =>
    withDraft(value, planModel(value, deps.cacheDir), flags.options?.[value], deps.cacheDir);
  const planFlagged = (flagged: ServeKind, named: string[] | undefined) =>
    (named ?? []).map((value) => {
      // The catalog can refuse before the files are even looked for.
      const known = _catalogKind(value);
      if (known !== undefined) {
        assertKind(value, known, flagged);
      }
      const model = planNamed(value);
      assertKind(value, model.kind, flagged);
      return model;
    });
  const planned = [
    ...values.map(planNamed),
    ...planFlagged("embedding", flags.embedding),
    ...planFlagged("speech", flags.speech),
    ...planFlagged("image", flags.image),
  ];
  if (planned.length === 0) {
    throw new Error("Name at least one model to serve.");
  }
  const names = planned.map((p) => p.name);
  const repeated = names.find((n, i) => names.indexOf(n) !== i);
  if (repeated !== undefined) {
    throw new Error(`${repeated} is named twice.`);
  }
  // A draft is loaded by the server of the model it drafts for, so the
  // memory warning counts it with that model.
  const warning = memoryWarning(
    planned.flatMap((p) =>
      p.draft === undefined ? [p.sizeBytes] : [p.sizeBytes, p.draft.sizeBytes],
    ),
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
  const shared: ChatServerSettings = {
    maxTokens,
    promptCacheBytes: promptCacheBudget(deps.totalmem()),
    prefillStepSize: flags.prefillStep ?? prefillStepSize(deps.totalmem()),
    limits: {
      reasoningBudget: flags.reasoningBudget,
      hedgeLimit: flags.hedgeLimit,
      repeatLimit: flags.repeatLimit,
      limitAnswers: flags.limitAnswers,
    },
  };
  for (const model of planned) {
    const internalPort = await deps.freePort();
    const settings = settingsFor(model, shared);
    if (model.draft !== undefined) {
      deps.log(
        `Drafting for ${model.name} with ${model.draft.name} (${formatGB(model.draft.sizeBytes)})`,
      );
    }
    const args = argsFor(model, internalPort, settings, deps.cacheDir, deps.adaptersDir);
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
    door = await startFrontDoor(
      port,
      routes,
      {
        log: deps.log,
        verbose: flags.logPrompts === true,
        color: deps.useColor ? color : plainColor,
      },
      maxTokens,
    );
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
/** The tokens after the `serve` word on the command line. */
export function argvAfterServe(argv: string[]): string[] {
  const at = argv.indexOf("serve");
  return at === -1 ? [] : argv.slice(at + 1);
}

export async function localServe(
  values: string[],
  flags: ServeFlags,
  argv: string[] = process.argv,
): Promise<void> {
  let handle: ServeHandle;
  try {
    flags.options = optionsByModel(groupServeArgv(argvAfterServe(argv)));
    const wantsPicker =
      values.length === 0 &&
      (flags.embedding ?? []).length === 0 &&
      (flags.speech ?? []).length === 0 &&
      (flags.image ?? []).length === 0;
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
