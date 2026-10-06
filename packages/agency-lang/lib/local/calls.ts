import {
  checkLocalImageArgs,
  localImageBody,
  localImageSettings,
  localImageTimeoutMs,
  postLocalImage,
} from "../stdlib/mlxImage.js";
import {
  LOCAL_IMAGE_FIELDS,
  encodedImageInput,
  fieldValue,
  localImageMode,
  type LocalImageMode,
} from "../stdlib/localImageInputs.js";
import {
  MAX_IMAGE_BYTES,
  checkVisionModel,
  postVisionRequest,
  visionAnswer,
  type VisionTask,
} from "../stdlib/vision.js";
import { explainNoServer, type LocalRequestOptions } from "../stdlib/localRequest.js";
import { currentHost } from "../runtime/currentHost.js";
import { mlxBaseUrl } from "../stdlib/mlxServerModels.js";
import { success, failure, type Result } from "./result.js";

/** The functions that call the server `agency local serve` runs, for a
 *  TypeScript program. Each sends the request its `std::image` or
 *  `std::vision` twin sends, and differs from it in three ways: it raises
 *  no interrupt, it takes an image as a path or as bytes, and it takes the
 *  server's address as an option. */

/** What every call function takes.
 *
 *  baseUrl  the server's address, such as `server.url` from `serve`.
 *           Absent: `client.baseUrl.mlx` in agency.json, then the
 *           `MLX_BASE_URL` environment variable, then port 8080 on this
 *           machine
 *  signal   aborting it ends the call with the failure "Cancelled" */
export type CallOptions = LocalRequestOptions;

/** An image to send: the path of a file on this machine, or the image's
 *  bytes. */
export type ImageInput = string | Uint8Array;

export type GeneratedImage = { bytes: Uint8Array; mimeType: string; seed: number | null };

export type GenerateImageOptions = CallOptions & {
  model: string;
  prompt: string;
  size?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  negativePrompt?: string;
  format?: "png" | "jpeg" | "webp";
  lora?: string;
  loraScale?: number;
  controlnet?: string;
  controlImage?: ImageInput;
  controlScale?: number;
  invertControlImage?: boolean;
  images?: ImageInput[];
  startImage?: ImageInput;
  strength?: number;
  mask?: ImageInput;
};

/** A call's input images by the request field each goes in. */
function inputsByField(options: GenerateImageOptions): Record<string, ImageInput[]> {
  const one = (input: ImageInput | undefined) => (input === undefined ? [] : [input]);
  return {
    control_image: one(options.controlImage),
    images: options.images ?? [],
    start_image: one(options.startImage),
    mask_image: one(options.mask),
  };
}

const GENERATE_IMAGE = "generateImage";

/** The request fields that carry a call's input images, each image as
 *  base64. Throws when an image cannot be read or is over its field's
 *  size cap. */
async function encodedFields(
  fields: string[],
  inputs: Record<string, ImageInput[]>,
): Promise<Record<string, string | string[]>> {
  const out: Record<string, string | string[]> = {};
  for (const field of fields) {
    const maxBytes = LOCAL_IMAGE_FIELDS[field].maxBytes;
    const encoded: string[] = [];
    for (const input of inputs[field]) {
      encoded.push(await encodedImageInput(input, maxBytes, GENERATE_IMAGE));
    }
    out[field] = fieldValue(field, encoded);
  }
  return out;
}

/** Generate one image with a local image model. The twin of
 *  `generateImageLocal` in `std::image`, and it takes the same settings. */
export async function generateImage(
  options: GenerateImageOptions,
): Promise<Result<GeneratedImage>> {
  const { network } = currentHost();
  const fail = (message: string) => failure(`${GENERATE_IMAGE} failed: ${message}`);
  const format = options.format ?? "png";
  const checked = checkLocalImageArgs(options.prompt, options.model, format);
  if ("error" in checked) {
    return fail(checked.error);
  }
  const inputs = inputsByField(options);
  const counts = Object.fromEntries(
    Object.entries(inputs).map(([field, given]) => [field, given.length]),
  );
  let mode: LocalImageMode;
  try {
    mode = localImageMode(
      counts,
      {
        controlnet: options.controlnet ?? "",
        controlScale: options.controlScale ?? null,
        invertControlImage: options.invertControlImage ?? false,
        strength: options.strength ?? null,
      },
      GENERATE_IMAGE,
    );
  } catch (err) {
    // The message already starts with the function's name.
    return failure((err as Error).message);
  }
  let images: Record<string, string | string[]>;
  try {
    images = await encodedFields(mode.fields, inputs);
  } catch (err) {
    return fail((err as Error).message);
  }
  // The stdlib sends an empty size when none is given, which the server
  // reads as "choose one".
  const size = options.size ?? "";
  const body = localImageBody({
    model: checked.servedName,
    prompt: options.prompt,
    size,
    format,
    settings: {
      ...localImageSettings(
        options.steps ?? null,
        options.guidance ?? null,
        options.seed ?? null,
        options.negativePrompt ?? "",
        options.lora ?? "",
        options.loraScale ?? null,
      ),
      ...mode.settings,
      ...images,
    },
  });
  const timeoutMs = localImageTimeoutMs(options.steps, size, mode.references);
  const out = await postLocalImage(network, body, timeoutMs, options);
  if ("error" in out) {
    const serveCommand = `agency local serve --image ${options.model}`;
    return fail(explainNoServer(out.error, mlxBaseUrl(options.baseUrl), serveCommand));
  }
  const image = out.images[0];
  if (image === undefined) {
    return fail("the server returned no image.");
  }
  return success({ bytes: image.data, mimeType: image.mimeType, seed: image.seed ?? null });
}

/** A box in an image, each number a fraction of the image's width or
 *  height, measured from the top left. */
export type BoundingBox = { x: number; y: number; width: number; height: number };

/** One thing a detector found. `id` is its index in the reply. */
export type Detection = { id: number; label: string; score: number; box: BoundingBox };

/** One box around a thing in a picture, found with no name. */
export type Region = { id: number; score: number; box: BoundingBox };

/** One tag a tagger gave, with how sure it was, 0 to 1. */
export type Tag = { tag: string; score: number };

/** What every vision function takes besides its own settings. */
export type VisionOptions = CallOptions & { model: string; image: ImageInput };

/** The settings each vision function uses when the caller gives none.
 *  The stdlib's are the parameter defaults in `stdlib/vision.agency`, and a
 *  test compares the two. */
export const VISION_DEFAULTS = {
  detectObjects: { threshold: null },
  tagImage: { threshold: 0.35, limit: 30 },
  captionImage: { detail: "short" },
  embedImage: { boxes: null },
  findRegions: { limit: 50, threshold: null },
} as const;

/** One call to the vision server: check the model, encode the image,
 *  send, and shape the answer. A failure starts with `name`. */
async function visionCallWith<T>(
  name: string,
  task: VisionTask,
  options: VisionOptions,
  fields: Record<string, unknown>,
): Promise<Result<T>> {
  const { network } = currentHost();
  const fail = (message: string) => failure(`${name} failed: ${message}`);
  const checked = checkVisionModel(options.model);
  if ("error" in checked) {
    return fail(checked.error);
  }
  let imageBase64: string;
  try {
    imageBase64 = await encodedImageInput(options.image, MAX_IMAGE_BYTES, name);
  } catch (err) {
    return fail((err as Error).message);
  }
  const out = await postVisionRequest(
    network,
    task,
    options.model,
    checked.servedName,
    imageBase64,
    fields,
    options,
  );
  if ("error" in out) {
    return fail(out.error);
  }
  return success(visionAnswer(task, out.reply) as T);
}

/** Find the named things in an image with a local detector. A threshold
 *  left out is the model's own default. */
export function detectObjects(
  options: VisionOptions & { labels: string[]; threshold?: number },
): Promise<Result<Detection[]>> {
  return visionCallWith("detectObjects", "detections", options, {
    labels: options.labels,
    threshold: options.threshold ?? VISION_DEFAULTS.detectObjects.threshold,
  });
}

/** Describe an image as tags with a local tagger, best first. */
export function tagImage(
  options: VisionOptions & { threshold?: number; limit?: number },
): Promise<Result<Tag[]>> {
  return visionCallWith("tagImage", "tags", options, {
    threshold: options.threshold ?? VISION_DEFAULTS.tagImage.threshold,
    limit: options.limit ?? VISION_DEFAULTS.tagImage.limit,
  });
}

/** Write a sentence about an image with a local model. */
export function captionImage(
  options: VisionOptions & { detail?: string },
): Promise<Result<string>> {
  return visionCallWith("captionImage", "captions", options, {
    detail: options.detail ?? VISION_DEFAULTS.captionImage.detail,
  });
}

/** Turn an image into embeddings: one for the whole image, or one for
 *  each box given. */
export function embedImage(
  options: VisionOptions & { boxes?: BoundingBox[] },
): Promise<Result<number[][]>> {
  return visionCallWith("embedImage", "embeddings", options, {
    boxes: options.boxes ?? VISION_DEFAULTS.embedImage.boxes,
  });
}

/** Box every thing in an image with a local model, with no names. A
 *  threshold left out is the server's default. */
export function findRegions(
  options: VisionOptions & { limit?: number; threshold?: number },
): Promise<Result<Region[]>> {
  return visionCallWith("findRegions", "regions", options, {
    limit: options.limit ?? VISION_DEFAULTS.findRegions.limit,
    threshold: options.threshold ?? VISION_DEFAULTS.findRegions.threshold,
  });
}
