import { MLX_VLM_VERSION, MLX_VLM_RULES, vlmServeArgs, imageChatExample } from "./vlmChat.js";
import type { RequestRules } from "./requestRules.js";
import { VLM_ARCHITECTURES } from "../stdlib/modelKind.js";
import { architectureOfModelDir, visionFamilyOf } from "../stdlib/modelDirKind.js";
import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { realSpawn, pipedSpawn } from "./modelProcess.js";
import {
  NAMING_FLAGS,
  argvAfterServe,
  groupServeArgv,
  optionsByModel,
  targetsFromFlags,
  type ServeTarget,
  type ValueFlags,
} from "./serveArgv.js";
export {
  argvAfterServe,
  groupServeArgv,
  optionsByModel,
  targetsFromFlags,
  valueFlagsOf,
  type ServeTarget,
  type ValueFlags,
} from "./serveArgv.js";
export { spawnOptions, type ChildOutput } from "./modelProcess.js";
import prompts from "prompts";
import {
  isServedUri,
  parseServedUri,
  modelDirSizeBytes,
  modelDirEntries,
  type ServedBackend,
} from "../stdlib/modelBackend.js";
import { IMAGES_PATH, VISION_PATHS } from "./serveLog.js";
import { choosePython, defaultMlxEnv } from "../stdlib/localPython.js";
export { choosePython, defaultMlxEnv } from "../stdlib/localPython.js";
import { VISION_ONNX_FILES, type VisionFamily } from "../stdlib/modelKind.js";
import {
  _resolveModel,
  _mlxServedName,
  _modelKind,
  _catalogKind,
  _listDownloadedModels,
  _findDownloadedServedModel,
  defaultCacheDir,
  configuredAdaptersDir,
  configuredControlnetsDir,
  readClientConfig,
  formatGB,
  type DownloadedModel,
  type ResolvedModel,
} from "../stdlib/localModels.js";
import type { ModelKind } from "../stdlib/modelKind.js";
import { startFrontDoor, type FrontDoor } from "./mlxServer.js";
import { createModelPool, type ModelPlan, type ModelStatus } from "./modelPool.js";
import { availableMemory, estimatedNeed, type MemorySnapshot } from "./availableMemory.js";
import { formatElapsed } from "../eval/run/statusBoard.js";
import { color, plainColor, autoUseColor } from "../utils/termcolors.js";

export { formatElapsed };

export type ServeKind = ModelKind;

/** Inputs an embedding model accepts, in tokens: the Qwen3 Embedding
 *  card's value. */
const EMBED_MAX_LENGTH = 8192;

export type ChatServeOptions = {
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
  controlnetsDir: string | null = null,
): string[] {
  const args = [script, "--model", modelDir, "--host", "127.0.0.1", "--port", String(internalPort)];
  if (adaptersDir !== null) {
    args.push("--adapters-dir", adaptersDir);
  }
  if (controlnetsDir !== null) {
    args.push("--controlnets-dir", controlnetsDir);
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
  controlnetsDir: string | null,
): string[] {
  if (model.kind === "embedding") {
    return embedServeArgs(embedServerScript(), model.dir, internalPort, EMBED_MAX_LENGTH);
  }
  if (model.kind === "speech") {
    return speechServeArgs(speechServerScript(), model.dir, internalPort, modelsDir);
  }
  if (model.kind === "image") {
    return imageServeArgs(
      imageServerScript(),
      model.dir,
      internalPort,
      adaptersDir,
      controlnetsDir,
    );
  }
  if (model.kind === "vision") {
    return visionServeArgs(visionServerScript(), model.dir, internalPort);
  }
  return chatSpecOf(model)!.args({ modelDir: model.dir, port: internalPort, settings });
}

/** How a process is named in messages: which program, for which model. */
function labelOf(model: BannerModel): string {
  const { kind, name } = model;
  const chat = chatSpecOf(model);
  if (chat !== null) {
    return `${chat.program} for ${name}`;
  }
  if (kind === "embedding") {
    return `the embedding server for ${name}`;
  }
  if (kind === "speech") {
    return `the speech server for ${name}`;
  }
  if (kind === "image" || kind === "controlnet") {
    return `the image server for ${name}`;
  }
  if (kind === "vision") {
    return `the vision server for ${name}`;
  }
  return `mlx_lm.server for ${name}`;
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

/** The script that runs mlx_vlm.server, shipped next to this file and
 *  copied into dist like the others. */
export function vlmServerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mlxVlmServer.py");
}

/** The vision server shipped next to this file, copied into dist like the
 *  image one. */
export function visionServerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "visionServer.py");
}

/** The argv for one vision server process, after the Python path. */
export function visionServeArgs(script: string, modelDir: string, internalPort: number): string[] {
  return [script, "--model", modelDir, "--host", "127.0.0.1", "--port", String(internalPort)];
}

/** The onnxruntime release the vision server's tagger family was tested
 *  with; `visionRules.py` pins the same one. */
export const ONNXRUNTIME_VERSION = "1.30.0";

/** The Python modules each kind of process imports. A vision model's
 *  depend on its family, so its entry is empty here and `modulesFor` reads
 *  the directory. */
const MODULES_FOR_KIND: Record<ServeKind, string[]> = {
  chat: [],
  embedding: ["mlx_lm"],
  speech: ["mlx_audio"],
  // accelerate is optional to diffusers, but without it a model loads
  // several times slower and with more memory.
  image: ["torch", "diffusers", "transformers", "accelerate"],
  vision: [],
  controlnet: [],
};

/** The modules one planned model's process imports. A vision model that
 *  is an ONNX tagger needs onnxruntime alone; one that is a transformers
 *  model needs torch and transformers. Which it is shows in its files, the
 *  same way its kind did. */
function modulesFor(model: Planned): string[] {
  const chat = chatSpecOf(model);
  if (chat !== null) {
    return chat.modules;
  }
  if (model.kind !== "vision") {
    return MODULES_FOR_KIND[model.kind];
  }
  const names = modelDirEntries(model.dir).map((entry) => entry.name);
  const isOnnx = VISION_ONNX_FILES.every((name) => names.includes(name));
  return isOnnx ? ["onnxruntime"] : ["torch", "transformers"];
}

/** The pip requirement that provides each module. */
const PIP_FOR_MODULE: Record<string, string> = {
  mlx_lm: `mlx-lm==${MLX_LM_VERSION}`,
  mlx_vlm: `mlx-vlm==${MLX_VLM_VERSION} mlx-audio==${MLX_AUDIO_VERSION}`,
  llguidance: `llguidance==${LLGUIDANCE_VERSION}`,
  mlx_audio: `mlx-audio==${MLX_AUDIO_VERSION}`,
  torch: IMAGE_REQUIREMENTS,
  diffusers: IMAGE_REQUIREMENTS,
  transformers: IMAGE_REQUIREMENTS,
  accelerate: IMAGE_REQUIREMENTS,
  onnxruntime: `onnxruntime==${ONNXRUNTIME_VERSION}`,
};

/** The pip requirements for `modules`, each once. The image modules share
 *  one requirement line. */
function requirementsFor(modules: string[]): string[] {
  return modules
    .map((m) => PIP_FOR_MODULE[m])
    .filter((requirement, index, all) => all.indexOf(requirement) === index);
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
  ...Object.fromEntries(VISION_PATHS.map((p) => [p, { flag: "", backend: "mlx" }])),
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
  const args = serve === undefined || serve.flag === "" ? target : `${serve.flag} ${target}`;
  return (
    `This server is serving ${joinNames(served)}. It is not serving ${requested}. ` +
    `Start it with: agency local serve ${args}`
  );
}

/** Why a Python cannot serve: it is not there, or it cannot import a module
 *  one of the planned kinds needs. */
export type PythonProblem =
  { kind: "missing" } | { kind: "cannot-import" | "wrong-version"; module: string };

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
  if (problem.kind === "wrong-version") {
    const pin = VERSION_CHECKED[problem.module];
    return [
      `${python} has a version of ${pin.distribution} other than ${pin.version}.`,
      `Agency's request rules were written against ${pin.version}. Install it:`,
      "",
      `  ${python} -m pip install ${PIP_FOR_MODULE[problem.module]}`,
    ].join("\n");
  }
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
  label?: string;
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
  if (kind === "speech" || kind === "image" || kind === "vision" || kind === "controlnet") {
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
      `${options.label ?? labelOf({ kind, name: upstreamModel })} answered ${res.status} to the readiness request: ${text}`,
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

type PinnedPackage = { distribution: string; version: string };
const VERSION_CHECKED: Record<string, PinnedPackage> = {
  mlx_vlm: { distribution: "mlx-vlm", version: MLX_VLM_VERSION },
};

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
  for (const module of modules) {
    const pin = VERSION_CHECKED[module];
    if (pin === undefined) {
      continue;
    }
    const code = `from importlib.metadata import version; import sys; sys.exit(0 if version('${pin.distribution}') == '${pin.version}' else 1)`;
    if (exec(python, ["-c", code]).status !== 0) {
      return { kind: "wrong-version", module };
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
 *  never a choice here. Nor is a model whose kind nothing says: the picker
 *  cannot pass the flag that `serve` would need for it. */
export function serveChoices(downloaded: DownloadedModel[]): ServeChoice[] {
  // One row per repo id. The same model can sit in both layouts, and two rows
  // with the same value would let you pick it twice, which `runServe` refuses.
  const byRepo: Record<string, DownloadedModel> = {};
  for (const model of downloaded) {
    if (
      model.backend !== "llama-cpp" &&
      model.complete &&
      model.kind !== undefined &&
      byRepo[model.name] === undefined
    ) {
      byRepo[model.name] = model;
    }
  }
  return Object.values(byRepo)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({
      title: `${m.name}  (${formatGB(m.sizeBytes)}, ${m.kind})`,
      value: `${m.backend}:${m.name}`,
    }));
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
  /** SIGTERM when no signal is given. */
  kill: (signal?: NodeJS.Signals) => unknown;
};

export type ServeDeps = {
  spawn: (python: string, args: string[]) => Child;
  fetch: typeof fetch;
  exec: Exec;
  totalmem: () => number;
  /** The memory a lazy model may take now. */
  availableMemory: () => Promise<MemorySnapshot>;
  /** Resolves after `ms`. Tests pass one that does not wait. */
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
  freePort: () => Promise<number>;
  cacheDir: string;
  home: string;
  env: Record<string, string | undefined>;
  configuredPython: string | undefined;
  /** `client.adaptersDir`, absolute, or null when unset. */
  adaptersDir: string | null;
  /** `client.controlnetsDir`, absolute, or null when unset. */
  controlnetsDir: string | null;
  /** Whether the request log is colored. Off when stdout is not a terminal. */
  useColor: boolean;
};

export type ServeHandle = {
  port: number;
  /** The server's address, for a client's base URL: `http://127.0.0.1:<port>/v1`. */
  url: string;
  models: string[];
  /** Resolves with a message when a process dies after it was ready. */
  failure: Promise<string>;
  /** Each model's state, the same list `GET /v1/agency/status` returns. */
  status: () => ModelStatus[];
  /** Starts a model's process and resolves when the model is ready. */
  load: (model: string) => Promise<void>;
  /** Stops a model's process. It stays stopped until `load`. */
  unload: (model: string) => Promise<void>;
  /** Ends every request running on a model, and restarts the model's
   *  process when that is the only way to stop its work. */
  cancel: (model: string) => Promise<void>;
  /** Resolves when `POST /v1/agency/shutdown` is called. The server is
   *  closing by then. */
  shutdownRequested: Promise<void>;
  /** Refuses new requests, stops every process and waits for it to exit,
   *  then closes the port. Calling it again returns the same promise. */
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

/** The settings of a server as a whole, as opposed to those of one model
 *  it serves. */
export type ServeSettings = ReplyLimits & {
  /** The port to listen on. 0 asks the operating system for a free one. */
  port?: number;
  maxTokens?: number;
  /** Tokens of prompt read per pass. Default from the machine's memory,
   *  see prefillStepSize. */
  prefillStep?: number;
  python?: string;
  /** Print each request's prompt and reply under its summary line. The CLI
   *  spells this `--log-prompts`, since `--verbose` is already the whole
   *  CLI's own flag. */
  logPrompts?: boolean;
};

/** The `serve` command line as commander parsed it: the server's settings,
 *  and the models each naming flag listed. */
export type ServeFlags = ServeSettings & {
  /** Per-model options, keyed by the model as it was named on the command
   *  line. `groupServeArgv` builds this from the argv order. */
  options?: Record<string, ModelOptions>;
  /** Models to serve with the embedding server rather than mlx_lm.server. */
  embedding?: string[];
  /** Models to serve with the speech server on /v1/audio/speech. */
  speech?: string[];
  /** Models to serve with the image server on /v1/images/generations. */
  image?: string[];
  vlm?: string[];
  /** Models to load on their first request. */
  lazy?: string[];
};

/** The dependencies of a server started from TypeScript: everything it
 *  would print goes to `log`, the model processes' output included. */
export function loggedDeps(log: (line: string) => void): ServeDeps {
  return { ...realDeps(), log, spawn: pipedSpawn(log), useColor: false };
}

function realDeps(): ServeDeps {
  return {
    spawn: realSpawn,
    fetch,
    exec: execSync,
    totalmem: os.totalmem,
    availableMemory: () => availableMemory(console.log),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: console.log,
    freePort,
    cacheDir: defaultCacheDir(),
    home: os.homedir(),
    env: process.env,
    configuredPython: readClientConfig().mlx?.python,
    adaptersDir: configuredAdaptersDir(),
    controlnetsDir: configuredControlnetsDir(),
    useColor: autoUseColor(),
  };
}

type Planned = {
  name: string;
  dir: string;
  sizeBytes: number;
  kind: ServeKind;
  runtime: ChatRuntime | null;
  lazy: boolean;
  /** Whether a flag gave the kind, as against the model's own files. */
  flagged: boolean;
  /** The chat model that drafts for this one, planned the same way. */
  draft?: { name: string; dir: string; sizeBytes: number; tokens: number };
};

/** The flag a kind may be named with on the command line. Usually none is
 *  needed, because `serve` reads the kind from the model. A flag supplies
 *  the kind when nothing else says it, and overrides what the files say. */
const FLAG_FOR_KIND: Record<ServeKind, string> = {
  chat: "",
  embedding: "--embedding",
  speech: "--speech",
  image: "--image",
  vision: "",
  controlnet: "",
};

function anArticle(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** The command that serves `value` as what it is. */
function serveCommand(value: string, kind: ServeKind): string {
  const flag = FLAG_FOR_KIND[kind];
  return `agency local serve ${flag === "" ? "" : `${flag} `}${value}`;
}

/** A model the catalog knows must be served as that kind. Serving an
 *  embedding model as a chat model, or the reverse, fails only after a long
 *  load, so a flag that disagrees is refused up front, naming the command
 *  that works. */
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
 *  picks the program that serves it.
 *
 *  `flagged` is the kind the command line gave it, if any. The catalog
 *  outranks a flag, since it knows the models whose files mislead. A flag
 *  outranks the download's record and the files: it is the user saying
 *  what the model is, and the file rules can be wrong (an embedding model
 *  whose config names a `ForCausalLM` class). With no flag, the kind comes
 *  from the catalog, the record, or the files, in that order. */
function planModel(value: string, cacheDir: string, flagged?: ServeKind): Planned {
  const listed = _catalogKind(value);
  if (listed === "controlnet" || flagged === "controlnet") {
    throw new Error(
      `${value} is a ControlNet, which is not served: an SDXL image server loads it from ` +
        `client.controlnetsDir when a request names it. Serve the image model instead.`,
    );
  }
  if (flagged !== undefined && listed !== undefined) {
    // Refuse before the files are even looked for.
    assertKind(value, listed, flagged);
  }
  const resolved = _resolveModel(value);
  if (resolved.backend === "llama-cpp") {
    throw new Error(
      `"${value}" is a GGUF model. agency local serve is for MLX and diffusers models; ` +
        `run it with agency run --local ${value} instead.`,
    );
  }
  const name = _mlxServedName(resolved);
  const { dir, sizeBytes } = servedModelLocation(resolved, cacheDir);
  const found = _modelKind(value, dir);
  if (found === "controlnet") {
    throw new Error(
      `${value} is a ControlNet directory, which is not served: an SDXL image server loads it ` +
        `from client.controlnetsDir when a request names it. Serve the image model instead.`,
    );
  }
  const kind = flagged ?? found;
  if (kind === null) {
    throw new Error(unknownKindMessage(value));
  }
  return {
    name,
    dir,
    sizeBytes,
    kind,
    runtime: kind === "chat" ? "mlx-lm" : null,
    lazy: false,
    flagged: flagged !== undefined,
  };
}

/** A required kind cannot override what the installed files say. */
function planRequired(value: string, cacheDir: string, kind: ServeKind): Planned {
  const model = planModel(value, cacheDir, kind);
  const found = _modelKind(value, model.dir);
  if (found !== null) {
    assertKind(value, found, kind);
  }
  return model;
}

/** The plan for one target: what kind of model it is, where its files
 *  are, and the draft model written after it. A target with no kind is
 *  served as whatever it is. One with a kind is served as that kind,
 *  unless the catalog says otherwise. One with a runtime must be a chat
 *  model that runtime has been tested with. */
function planTarget(target: ServeTarget, cacheDir: string): Planned {
  const planned = withDraft(target.model, planUndrafted(target, cacheDir), target, cacheDir);
  return { ...planned, lazy: target.lazy === true };
}

/** One plan per model. A model may be named twice when one mention is
 *  `--lazy` alone and the other gives its kind, as in `--vlm a --lazy a`;
 *  the two are joined into one lazy plan. Names are compared after
 *  planning, so the two mentions may spell the model differently. Any
 *  other repeat is an error. */
function joinLazyPairs(planned: Planned[]): Planned[] {
  const out: Planned[] = [];
  for (const plan of planned) {
    const seen = out.findIndex((other) => other.name === plan.name);
    if (seen === -1) {
      out.push(plan);
      continue;
    }
    const other = out[seen];
    const [lazyOnly, kinded] = plan.lazy && !plan.flagged ? [plan, other] : [other, plan];
    const isPair = lazyOnly.lazy && !lazyOnly.flagged && kinded.flagged && !kinded.lazy;
    if (!isPair) {
      throw new Error(`${plan.name} is named twice.`);
    }
    // A draft written after either mention belongs to the model.
    if (kinded.draft !== undefined && lazyOnly.draft !== undefined) {
      throw new Error(`${plan.name} has --draft twice. Write it once, after either mention.`);
    }
    out[seen] = { ...kinded, lazy: true, draft: kinded.draft ?? lazyOnly.draft };
  }
  return out;
}

function planUndrafted(target: ServeTarget, cacheDir: string): Planned {
  const { model: value, kind, runtime } = target;
  if (kind === undefined) {
    return planModel(value, cacheDir);
  }
  if (runtime === undefined) {
    return planModel(value, cacheDir, kind);
  }
  const model = planRequired(value, cacheDir, kind);
  const architecture = architectureOfModelDir(model.dir);
  if (!VLM_ARCHITECTURES.includes(architecture)) {
    throw new Error(
      `${model.dir} has the architecture ${architecture || "(missing)"}.\n` +
        `agency local serve ${target.flag ?? "--vlm"} has been tested with: ${VLM_ARCHITECTURES.join(", ")}.`,
    );
  }
  return { ...model, runtime };
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
  if (!chatSpecOf(model)?.flags.includes("draft")) {
    if (model.kind === "chat") {
      throw new Error(`--draft is not supported by ${labelOf(model)}.`);
    }
    throw new Error(
      `--draft goes after a chat model, and ${value} is ${anArticle(model.kind)} model. ` +
        `Write it after the chat model it drafts for: agency local serve <model> --draft ${options.draft}`,
    );
  }
  // Nobody named the draft's kind, so "chat" is a requirement here, not a
  // flag: a draft the record or files say is something else is refused,
  // and one whose kind nothing says is taken as chat.
  const draft = planRequired(options.draft, cacheDir, "chat");
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

/** What to do about a model whose kind nothing says. The flags work for
 *  any model. A chat model has no flag, so it is told what the files need. */
function unknownKindMessage(value: string): string {
  return [
    `agency cannot tell from its files what kind of model ${value} is.`,
    `If it is an embedding, speech, or image model, name the kind with its flag:`,
    `  ${serveCommand(value, "embedding")}`,
    `  ${serveCommand(value, "speech")}`,
    `  ${serveCommand(value, "image")}`,
    `A chat model needs a config.json whose "architectures" names a class ending in ` +
      `ForCausalLM or ForConditionalGeneration.`,
  ].join("\n");
}

/** A model in the banner. `dir` is where it was found, when there is one,
 *  so the banner can read which vision family it is. */
export type BannerModel = {
  name: string;
  kind: ServeKind;
  dir?: string;
  runtime?: ChatRuntime | null;
  lazy?: boolean;
};

/** The line of Agency code the banner suggests for each vision function,
 *  given the served model's name. */
const TRY_VISION: Record<VisionFamily["tryIt"], (name: string) => string> = {
  tagImage: (name) => `tagImage("drawing.png", "${name}")`,
  detectObjects: (name) => `detectObjects("drawing.png", ["cat"], "${name}")`,
  embedImage: (name) => `embedImage("drawing.png", "${name}")`,
};

/** The suffix after a model's name in the banner. Chat models get none. */
const BANNER_SUFFIX: Record<ServeKind, string> = {
  chat: "",
  embedding: "  (embeddings)",
  speech: "  (speech)",
  image: "  (images)",
  vision: "  (vision)",
  controlnet: "  (controlnet)",
};

/** What `serve` prints once every process is ready: the models, in plan
 *  order, and a sample command for the first model of each kind. */
export function servingBanner(port: number, models: BannerModel[]): string[] {
  const count = models.length;
  const lines = [`Serving ${count} model${count === 1 ? "" : "s"} on http://127.0.0.1:${port}/v1:`];
  for (const model of models) {
    const note = chatSpecOf(model)?.bannerNote ?? BANNER_SUFFIX[model.kind];
    lines.push(`  ${model.name}${note}${model.lazy === true ? "  (on demand)" : ""}`);
  }
  const first = (kind: ServeKind) => models.find((model) => model.kind === kind)?.name;
  for (const [runtime, spec] of Object.entries(CHAT_RUNTIMES)) {
    const model = models.find((m) => m.kind === "chat" && (m.runtime ?? "mlx-lm") === runtime);
    if (model !== undefined) {
      lines.push(...spec.example(model.name));
    }
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
  const vision = models.find((model) => model.kind === "vision");
  if (vision !== undefined) {
    // The ONNX tagger has no config, and so no family here: it tags.
    const family = vision.dir === undefined ? undefined : visionFamilyOf(vision.dir);
    const tryIt = family?.tryIt ?? "tagImage";
    lines.push(
      "",
      "  In Agency code:",
      `    import { ${tryIt} } from "std::vision"`,
      `    ${TRY_VISION[tryIt](vision.name)}`,
    );
  }
  return lines;
}

/** Serves the models a parsed `agency local serve` command line names. */
export async function runServe(
  values: string[],
  flags: ServeFlags,
  deps: ServeDeps = realDeps(),
): Promise<ServeHandle> {
  return serveTargets(targetsFromFlags(values, flags), flags, deps);
}

/** What the pool needs to know about a planned model. */
function modelPlanOf(model: Planned): ModelPlan {
  return {
    model: model.name,
    upstreamModel: model.dir,
    label: labelOf(model),
    kind: model.kind,
    rules: chatSpecOf(model)?.rules ?? null,
    lazy: model.lazy,
    needBytes: estimatedNeed(model),
    stopsOnClose: chatSpecOf(model)?.stopsOnClose ?? (() => true),
  };
}

/** Resolve, check, start one process per model, and open the door. */
export async function serveTargets(
  targets: ServeTarget[],
  settings: ServeSettings,
  deps: ServeDeps = realDeps(),
): Promise<ServeHandle> {
  const maxTokens = settings.maxTokens ?? 16384;
  const planned = joinLazyPairs(targets.map((target) => planTarget(target, deps.cacheDir)));
  const unused = flagsNobodyTakes(settings, planned);
  if (unused.length > 0) {
    const flag = unused[0].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    throw new Error(
      `--${flag} is not taken by any model in this command. It is for a chat model served by mlx_lm.server.`,
    );
  }
  if (planned.length === 0) {
    throw new Error("Name at least one model to serve.");
  }
  const names = planned.map((p) => p.name);
  // A draft is loaded by the server of the model it drafts for, so the
  // memory warning counts it with that model. A lazy model is loaded on
  // demand, so it is not counted: the warning is about what loads together.
  const warning = memoryWarning(
    planned
      .filter((p) => !p.lazy)
      .flatMap((p) => (p.draft === undefined ? [p.sizeBytes] : [p.sizeBytes, p.draft.sizeBytes])),
    deps.totalmem(),
  );
  if (warning !== null) {
    deps.log(warning);
  }
  const python = choosePython(
    settings.python,
    deps.configuredPython,
    deps.env.AGENCY_MLX_PYTHON,
    deps.home,
  );
  // The modules the planned kinds import, each once, in plan order.
  const modules = planned
    .flatMap(modulesFor)
    .filter((module, index, all) => all.indexOf(module) === index);
  const problem = checkPython(python, deps.exec, modules);
  if (problem !== "ok") {
    throw new Error(pythonMissingMessage(python, deps.home, problem, modules));
  }

  const shared: ChatServerSettings = {
    maxTokens,
    promptCacheBytes: promptCacheBudget(deps.totalmem()),
    prefillStepSize: settings.prefillStep ?? prefillStepSize(deps.totalmem()),
    limits: {
      reasoningBudget: settings.reasoningBudget,
      hedgeLimit: settings.hedgeLimit,
      repeatLimit: settings.repeatLimit,
      limitAnswers: settings.limitAnswers,
    },
  };
  const plannedByName = Object.fromEntries(planned.map((model) => [model.name, model]));
  const pool = createModelPool(planned.map(modelPlanOf), {
    now: Date.now,
    availableMemory: deps.availableMemory,
    allowOvercommit: deps.env.AGENCY_ALLOW_MEMORY_OVERCOMMIT === "1",
    log: deps.log,
    wait: deps.wait,
    spawn: async (plan) => {
      const model = plannedByName[plan.model];
      const port = await deps.freePort();
      if (model.draft !== undefined) {
        deps.log(
          `Drafting for ${model.name} with ${model.draft.name} (${formatGB(model.draft.sizeBytes)})`,
        );
      }
      const args = argsFor(
        model,
        port,
        settingsFor(model, shared),
        deps.cacheDir,
        deps.adaptersDir,
        deps.controlnetsDir,
      );
      return { child: deps.spawn(python, args), port };
    },
    waitReady: (plan, running, gone) =>
      waitUntilLoaded(running.port, plan.upstreamModel, {
        fetch: deps.fetch,
        gone,
        kind: plan.kind,
        label: plan.label,
      }),
  });
  for (const model of planned.filter((p) => !p.lazy)) {
    deps.log(`Loading ${model.name} (${formatGB(model.sizeBytes)})…`);
    const started = Date.now();
    try {
      await pool.load(model.name);
    } catch (err) {
      await pool.stopAll();
      throw err;
    }
    deps.log(`  ready in ${formatElapsed(Date.now() - started)}`);
  }

  let requestShutdown: () => void = () => {};
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });
  let door: FrontDoor;
  try {
    door = await startFrontDoor(
      settings.port ?? 0,
      pool,
      {
        log: deps.log,
        verbose: settings.logPrompts === true,
        color: deps.useColor ? color : plainColor,
      },
      maxTokens,
      () => requestShutdown(),
    );
  } catch (err) {
    await pool.stopAll();
    throw err;
  }
  // The same close, however many times it is asked for: the shutdown
  // route, Ctrl-C, and the caller may each ask.
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing === null) {
      closing = (async () => {
        door.refuseNew();
        await pool.stopAll();
        await door.close();
      })();
    }
    return closing;
  };
  void shutdownRequested.then(close);
  for (const line of servingBanner(door.port, planned)) {
    deps.log(line);
  }
  return {
    port: door.port,
    url: `http://127.0.0.1:${door.port}/v1`,
    models: names,
    failure: pool.failure,
    status: pool.status,
    load: pool.load,
    unload: pool.unload,
    cancel: async (model) => {
      await door.cancel(model);
    },
    shutdownRequested,
    close,
  };
}

/** The CLI entry: serve until Ctrl-C, or until a process dies. With no
 *  model named, ask which of the downloaded ones to serve. `valueFlags`
 *  says which of the command line's flags take a value, so the per-model
 *  options can be read from `argv` in order. */
export async function localServe(
  values: string[],
  flags: ServeFlags,
  valueFlags: ValueFlags,
  argv: string[] = process.argv,
): Promise<void> {
  let handle: ServeHandle;
  try {
    flags.options = optionsByModel(groupServeArgv(argvAfterServe(argv, valueFlags), valueFlags));
    const wantsPicker =
      values.length === 0 && NAMING_FLAGS.every((flag) => (flags[flag.key] ?? []).length === 0);
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
  const ended = await Promise.race([
    handle.failure.then((why) => ({ why })),
    handle.shutdownRequested.then(() => ({ why: null })),
  ]);
  if (ended.why !== null) {
    console.error(ended.why);
  }
  await handle.close();
  process.exit(ended.why === null ? 0 : 1);
}

export type ChatRuntime = "mlx-lm" | "mlx-vlm";
export type ChatFlag =
  "reasoningBudget" | "hedgeLimit" | "repeatLimit" | "limitAnswers" | "prefillStep" | "draft";
export type ChatLaunch = { modelDir: string; port: number; settings: ChatServerSettings };
export type ChatRuntimeSpec = {
  program: string;
  modules: string[];
  args: (launch: ChatLaunch) => string[];
  flags: ChatFlag[];
  bannerNote: string;
  example: (name: string) => string[];
  rules: RequestRules | null;
  /** Whether the runtime stops generating when the connection to it
   *  closes, for a request with this body. What happens after a client
   *  leaves, by kind of model:
   *
   *  image                          stops after the step in progress
   *  speech                         stops at the next check for a closed
   *                                 connection
   *  vision                         a request waiting its turn is dropped;
   *                                 one that started finishes in seconds
   *  embedding                      finishes, in under a second
   *  chat on mlx-lm                 stops; the server looks at the
   *                                 connection on a clock
   *  chat on mlx-vlm, streamed      stops
   *  chat on mlx-vlm, not streamed  keeps generating until the reply is
   *                                 complete
   *
   *  Only the last row is false, and `cancel` stops that process. */
  stopsOnClose: (body: Record<string, unknown>) => boolean;
};

function runLocalExample(name: string): string[] {
  const spelled = path.isAbsolute(name) ? name : `mlx:${name}`;
  return ["", `  agency run --local ${spelled} your.agency`, `  agency agent --local ${spelled}`];
}

export const CHAT_RUNTIMES: Record<ChatRuntime, ChatRuntimeSpec> = {
  "mlx-lm": {
    program: "mlx_lm.server",
    modules: ["mlx_lm", "llguidance"],
    args: (launch) => serveArgs(chatServerScript(), launch.modelDir, launch.port, launch.settings),
    flags: ["reasoningBudget", "hedgeLimit", "repeatLimit", "limitAnswers", "prefillStep", "draft"],
    bannerNote: "",
    example: runLocalExample,
    rules: null,
    stopsOnClose: () => true,
  },
  "mlx-vlm": {
    program: "mlx_vlm.server",
    modules: ["mlx_vlm"],
    args: (launch) =>
      vlmServeArgs(vlmServerScript(), launch.modelDir, launch.port, launch.settings.maxTokens),
    flags: [],
    bannerNote: "  (chat with images)",
    example: imageChatExample,
    rules: MLX_VLM_RULES,
    stopsOnClose: (body) => body.stream === true,
  },
};

function chatSpecOf(model: BannerModel): ChatRuntimeSpec | null {
  return model.kind === "chat" ? CHAT_RUNTIMES[model.runtime ?? "mlx-lm"] : null;
}

/** Explicit shared flags must have at least one consumer. Drafts are per model. */
function flagsNobodyTakes(flags: ServeSettings, models: Planned[]): ChatFlag[] {
  const explicit: ChatFlag[] = [
    "reasoningBudget",
    "hedgeLimit",
    "repeatLimit",
    "limitAnswers",
    "prefillStep",
  ];
  return explicit.filter(
    (flag) =>
      flags[flag as keyof ServeSettings] !== undefined &&
      !models.some((model) => chatSpecOf(model)?.flags.includes(flag)),
  );
}
