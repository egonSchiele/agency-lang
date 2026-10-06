import { registerImageProvider, success, failure } from "smoltalk";
import type { HostNetwork } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import type { ImageConfig, ImageGenResult, ImageInput } from "../runtime/llmClient.js";
import { _resolveModel, _mlxServedName, _catalogKind, type ResolvedModel } from "./localModels.js";
import { postLocalJson, type LocalRequestOptions } from "./localRequest.js";

/** smoltalk's `image()` has no provider for the server `agency local serve`
 *  runs, so Agency registers one under the name `mlx`: the provider whose
 *  base URL (`client.baseUrl.mlx`, `MLX_BASE_URL`) points at that server,
 *  whatever kind of model is behind it. The image model itself runs on
 *  diffusers.
 *
 *  Compared with smoltalk's generic openai-compat image provider, it needs
 *  no key, never retries (the server makes one image at a time, so a retry
 *  would queue behind the request that just failed and then make the same
 *  image again), sends Agency's own settings, reads back the seed the
 *  server used, and costs nothing. */

/** What one step over one megapixel is allowed to take. Qwen-Image, the
 *  slowest family, is estimated at about 5 s: Chroma measured 2.25 s, and
 *  Qwen-Image's transformer is 2.25 times the size. Attention grows faster
 *  than the pixel count, so the allowance is about double that. Replace the
 *  estimate once Qwen-Image is timed. */
const STEP_MEGAPIXEL_MS = 10_000;

/** The most steps any family accepts: Chroma's and Qwen-Image's
 *  max_steps in diffusersImageRules.py, which a test checks. A request that leaves steps
 *  to the model is budgeted as if it asked for this many. */
export const MAX_STEPS = 80;

/** The most pixels a request may ask for, from the rules module. A size
 *  the client cannot parse is budgeted at this. */
const MAX_MEGAPIXELS = 4;

/** The server makes one image at a time, so a request may wait for one
 *  already running before its own time starts. */
const QUEUE_ALLOWANCE = 2;

/** The megapixels of the size the server makes when a request leaves
 *  `size` empty and has no picture to take it from: 1024x1024. A size taken
 *  from a picture is never more. */
const DEFAULT_MEGAPIXELS = (1024 * 1024) / 1_000_000;

/** The megapixels of a "WxH" size: the default size's for an empty one,
 *  and the largest allowed when the size is missing or not in that shape.
 *  The server refuses a bad size anyway. */
function megapixelsOf(size: string | undefined): number {
  if (size === "") {
    return DEFAULT_MEGAPIXELS;
  }
  const match = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (match === null) {
    return MAX_MEGAPIXELS;
  }
  return Math.min(MAX_MEGAPIXELS, (Number(match[1]) * Number(match[2])) / 1_000_000);
}

/** How long one request may take: room for the slowest family at the steps
 *  and size asked for, plus one request queued ahead of it. Each reference
 *  picture adds about as much work to every step as one more megapixel of
 *  output, so it adds one megapixel to the budget. The server caps every
 *  input, so this is bounded; at the caps with no reference it is about
 *  107 minutes. It guards against a server that has stopped answering, not
 *  a slow one. */
export function localImageTimeoutMs(
  steps: unknown,
  size: string | undefined,
  references: unknown = 0,
): number {
  const budgetedSteps =
    typeof steps === "number" && steps > 0 ? Math.min(steps, MAX_STEPS) : MAX_STEPS;
  const pictures = typeof references === "number" && references > 0 ? references : 0;
  return Math.ceil(
    QUEUE_ALLOWANCE * budgetedSteps * (megapixelsOf(size) + pictures) * STEP_MEGAPIXEL_MS,
  );
}

/** The settings `config.metadata` may carry, sent as request fields of the
 *  same names. Anything else in metadata is not sent: the server refuses
 *  fields it does not know. `metadata.references`, the number of reference
 *  pictures, is read for the timeout only. */
const SETTINGS = [
  "steps",
  "guidance",
  "seed",
  "negative_prompt",
  "lora",
  "lora_scale",
  "controlnet",
  "control_image",
  "control_scale",
  "control_invert",
  "images",
  "start_image",
  "mask_image",
  "strength",
];

/** An image from the local server, with the seed that made it. */
export type LocalGeneratedImage = ImageGenResult["images"][number] & { seed?: number };

const MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** The formats the local image server writes, in the order messages list
 *  them. */
export const LOCAL_IMAGE_FORMATS = Object.keys(MIME);

/** One request to the image server, before it is a request body. The
 *  stdlib builds it from an `ImageConfig`, and `generateImage` in
 *  `agency-lang/local` from its options.
 *
 *  size      "WxH", or "" to let the server choose. Absent: not sent
 *  format    "png", "jpeg", or "webp". Absent: not sent
 *  settings  the other request fields. Only the names in `SETTINGS` are
 *            sent */
export type LocalImageRequest = {
  model: string;
  prompt: string;
  size: string | undefined;
  format: string | undefined;
  settings: Record<string, unknown>;
};

/** The body of a request to the image server. The one place a body is
 *  built, so the stdlib and `agency-lang/local` cannot send different
 *  ones. */
export function localImageBody(request: LocalImageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (request.size !== undefined) {
    body.size = request.size;
  }
  if (request.format !== undefined) {
    body.output_format = request.format;
  }
  for (const key of SETTINGS) {
    const value = request.settings[key];
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return body;
}

type ReplyImage = { b64_json?: unknown; seed?: unknown };

/** The images of a reply, each with its seed when the server sent one. */
function imagesOf(reply: Record<string, unknown>): LocalGeneratedImage[] {
  const format = typeof reply.output_format === "string" ? reply.output_format : "png";
  const items = Array.isArray(reply.data) ? (reply.data as ReplyImage[]) : [];
  return items
    .filter((item) => typeof item.b64_json === "string")
    .map((item) => {
      const image: LocalGeneratedImage = {
        data: new Uint8Array(Buffer.from(item.b64_json as string, "base64")),
        mimeType: MIME[format] ?? "image/png",
      };
      if (typeof item.seed === "number") {
        image.seed = item.seed;
      }
      return image;
    });
}

/** Posts one request body to the image server and returns the images it
 *  made: one, since every body asks for one. `options` carries the
 *  server's address and the caller's signal; the stdlib passes neither. */
export async function postLocalImage(
  network: HostNetwork,
  body: Record<string, unknown>,
  timeoutMs: number,
  options: LocalRequestOptions = {},
): Promise<{ images: LocalGeneratedImage[] } | { error: string }> {
  const out = await postLocalJson(
    network,
    "/images/generations",
    body,
    timeoutMs,
    "image",
    options,
  );
  if ("error" in out) {
    return out;
  }
  return { images: imagesOf(out.reply) };
}

async function mlxImage(input: ImageInput, config: ImageConfig) {
  const { network } = currentHost();
  const normalized = typeof input === "string" ? { prompt: input } : input;
  if ((normalized.images?.length ?? 0) > 0 || normalized.mask !== undefined) {
    return failure("The mlx image provider does not edit images.");
  }
  const body = localImageBody({
    model: config.model,
    prompt: normalized.prompt,
    size: config.size,
    format: config.outputFormat,
    settings: config.metadata ?? {},
  });
  const out = await postLocalImage(
    network,
    body,
    localImageTimeoutMs(body.steps, config.size, config.metadata?.references),
  );
  if ("error" in out) {
    return failure(out.error);
  }
  const result: ImageGenResult = {
    images: out.images,
    model: config.model,
    costEstimate: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
  };
  return success(result);
}

/** The checks `generateImageLocal` makes before any request: a prompt, a
 *  format the server writes, and a model that is an image model. Returns
 *  the name to send the server, or a failure message. */
export function checkLocalImageArgs(
  prompt: string,
  model: string,
  format: string,
): { servedName: string } | { error: string } {
  if (prompt.trim() === "") {
    return { error: "prompt cannot be empty." };
  }
  if (!LOCAL_IMAGE_FORMATS.includes(format)) {
    const others = LOCAL_IMAGE_FORMATS.slice(0, -1).join(", ");
    const last = LOCAL_IMAGE_FORMATS[LOCAL_IMAGE_FORMATS.length - 1];
    return { error: `format "${format}" is not supported. Use ${others}, or ${last}.` };
  }
  if (model === "") {
    return { error: "model cannot be empty." };
  }
  let resolved: ResolvedModel;
  try {
    resolved = _resolveModel(model);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (_catalogKind(model) === "controlnet") {
    return {
      error:
        `"${model}" is a ControlNet, not an image model. Pass it as the controlnet ` +
        "argument, with a controlImage, and name an SDXL image model as the model.",
    };
  }
  if (resolved.backend !== "diffusers") {
    const what = resolved.backend === "mlx" ? "an MLX model" : "a GGUF model";
    return {
      error:
        `"${model}" is ${what}. Local image models are diffusers models served by ` +
        "agency local serve --image, such as z-image-turbo.",
    };
  }
  return { servedName: _mlxServedName(resolved) };
}

/** The settings a call gives, as the request fields the server takes. A
 *  null setting, or an empty negative prompt, is left out so the server
 *  uses the model card's value. */
export function localImageSettings(
  steps: number | null,
  guidance: number | null,
  seed: number | null,
  negativePrompt: string,
  lora: string,
  loraScale: number | null,
): Record<string, unknown> {
  const given: [string, unknown][] = [
    ["steps", steps],
    ["guidance", guidance],
    ["seed", seed],
    ["negative_prompt", negativePrompt === "" ? null : negativePrompt],
    ["lora", lora === "" ? null : lora],
    ["lora_scale", loraScale],
  ];
  return Object.fromEntries(given.filter(([, value]) => value !== null));
}

let registered = false;

/** Registers the provider with smoltalk, once per process. Called when the
 *  runtime loads provider modules, so `provider: "mlx"` works for every
 *  image function from the first call. */
export function registerMlxImageProvider(): void {
  if (!registered) {
    registerImageProvider("mlx", mlxImage);
    registered = true;
  }
}
