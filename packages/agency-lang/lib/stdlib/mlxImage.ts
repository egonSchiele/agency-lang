import { registerImageProvider, success, failure } from "smoltalk";
import type { ImageConfig, ImageGenResult, ImageInput } from "../runtime/llmClient.js";
import { mlxBaseUrl } from "./mlxServerModels.js";

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

/** How long one request may take. The image server caps steps and size so
 *  that its slowest request finishes well inside this. */
export const MLX_IMAGE_TIMEOUT_MS = 600_000;

/** The settings `config.metadata` may carry, sent as request fields of the
 *  same names. Anything else in metadata is not sent: the server refuses
 *  fields it does not know. */
const SETTINGS = ["steps", "guidance", "seed", "negative_prompt"];

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

type Reply = {
  error?: { message?: unknown };
  output_format?: unknown;
  data?: { b64_json?: unknown; seed?: unknown }[];
};

async function mlxImage(input: ImageInput, config: ImageConfig) {
  const normalized = typeof input === "string" ? { prompt: input } : input;
  if ((normalized.images?.length ?? 0) > 0 || normalized.mask !== undefined) {
    return failure("The mlx image provider does not edit images.");
  }
  const body: Record<string, unknown> = {
    model: config.model,
    prompt: normalized.prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (config.size !== undefined) {
    body.size = config.size;
  }
  if (config.outputFormat !== undefined) {
    body.output_format = config.outputFormat;
  }
  for (const key of SETTINGS) {
    const value = config.metadata?.[key];
    if (value !== undefined) {
      body[key] = value;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${mlxBaseUrl()}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MLX_IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return failure(`${(err as Error).message}${cause === undefined ? "" : ` (${cause})`}`);
  }
  let reply: Reply;
  try {
    reply = (await res.json()) as Reply;
  } catch {
    return failure(`The image server answered ${res.status} with a body that is not JSON.`);
  }
  if (!res.ok) {
    const message = reply.error?.message;
    return failure(
      typeof message === "string" ? message : `The image server answered ${res.status}.`,
    );
  }
  const format = typeof reply.output_format === "string" ? reply.output_format : "png";
  const images: LocalGeneratedImage[] = [];
  for (const item of reply.data ?? []) {
    if (typeof item.b64_json !== "string") {
      continue;
    }
    const image: LocalGeneratedImage = {
      data: new Uint8Array(Buffer.from(item.b64_json, "base64")),
      mimeType: MIME[format] ?? "image/png",
    };
    if (typeof item.seed === "number") {
      image.seed = item.seed;
    }
    images.push(image);
  }
  const result: ImageGenResult = {
    images,
    model: config.model,
    costEstimate: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
  };
  return success(result);
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
