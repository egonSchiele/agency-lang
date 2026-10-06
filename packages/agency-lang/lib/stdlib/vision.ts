import { success, failure, type ResultValue } from "../runtime/result.js";
import { _resolveModel, _mlxServedName, _localModelKindOf } from "./localModels.js";
import { mlxBaseUrl } from "./mlxServerModels.js";
import {
  postLocalJson,
  explainNoServer,
  type LocalReply,
  type LocalRequestOptions,
} from "./localRequest.js";
import { approvedFileBytes } from "./approvedPath.js";
import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { encodeBase64 } from "./base64.js";
import * as path from "node:path";

/** The TypeScript half of `std::vision`: one HTTP call behind three thin
 *  exports. The Agency side has already raised `std::vision` for the
 *  image's real path; this side re-validates that spelling, checks the
 *  model is a vision model, reads the image, and posts its bytes to the
 *  server `agency local serve` runs. The server never opens a path a
 *  request names. */

/** The largest image sent. `MAX_IMAGE_BYTES` in
 *  lib/cli/localServerCommon.py is the same, and a test compares them. */
export const MAX_IMAGE_BYTES = 50_000_000;

/** Room in a vision request for everything but its image.
 *  `MAX_SETTINGS_BYTES` in lib/cli/visionRules.py is the same. */
const VISION_SETTINGS_BYTES = 64 * 1024;

/** The largest request body the vision server takes: the base64 of the
 *  largest image, four characters for every three bytes, and room for the
 *  settings. `MAX_BODY_BYTES` in lib/cli/visionRules.py is computed the
 *  same way, and a test compares them. The serve front door holds vision
 *  requests to it. This module cannot import `base64Length` from
 *  localImageInputs.ts, which imports `MAX_IMAGE_BYTES` from here. */
export function visionBodyBytes(): number {
  return 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + VISION_SETTINGS_BYTES;
}

/** What the client knows about one vision task.
 *
 *  route       where the server answers it, under `/v1`
 *  replyField  the field of the reply that holds the answer
 *  numbered    true: each item of the answer gets an `id`, its index, so
 *              a caller can name crops after it
 *  logNoun     what the serve log counts the answer in, such as "tag"
 *  logBody     false: the serve log shows the reply's size alone and never
 *              reads it, because the reply is too long to print or to
 *              capture whole */
export type VisionTaskRow = {
  route: string;
  replyField: string;
  numbered: boolean;
  logNoun: string;
  logBody: boolean;
};

/** One row per task the vision server answers. `ROUTE_TABLE` in
 *  lib/cli/visionRules.py is the server's side, and a test compares the
 *  routes. */
export const VISION_TASKS = {
  detections: {
    route: "/vision/detections",
    replyField: "detections",
    numbered: true,
    logNoun: "detection",
    logBody: true,
  },
  tags: {
    route: "/vision/tags",
    replyField: "tags",
    numbered: false,
    logNoun: "tag",
    logBody: true,
  },
  captions: {
    route: "/vision/captions",
    replyField: "caption",
    numbered: false,
    logNoun: "caption",
    logBody: true,
  },
  // A hundred vectors of 768 numbers each is no use in a terminal, and is
  // more than the log keeps of one reply.
  embeddings: {
    route: "/vision/embeddings",
    replyField: "embeddings",
    numbered: false,
    logNoun: "embedding",
    logBody: false,
  },
  regions: {
    route: "/vision/regions",
    replyField: "regions",
    numbered: true,
    logNoun: "region",
    logBody: true,
  },
} satisfies Record<string, VisionTaskRow>;

export type VisionTask = keyof typeof VISION_TASKS;

/** A detector on a large page can take a minute on the CPU, and a request
 *  may wait behind one already running. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** The model to send: the served name, or the reason it cannot be sent. */
export function checkVisionModel(model: string): { servedName: string } | { error: string } {
  if (model === "") {
    return { error: "model cannot be empty." };
  }
  try {
    const resolved = _resolveModel(model);
    const kind = _localModelKindOf(model);
    if (kind !== null && kind !== "vision") {
      return {
        error:
          `"${model}" is ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} model, not a vision model. ` +
          "Local vision models are detectors, taggers, and embedding models such as " +
          "florence-2, owlv2-base, wd14-tagger, and dinov2-base.",
      };
    }
    return { servedName: _mlxServedName(resolved) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** A file's bytes as base64, read after the user approved it, or why it
 *  could not be read. `approvedFileBytes` refuses a symlink planted while
 *  the prompt was pending, and a file over `maxBytes`. */
async function approvedBase64(
  host: Host,
  spelling: string,
  maxBytes: number,
): Promise<{ base64: string } | { error: string }> {
  try {
    return { base64: encodeBase64(await approvedFileBytes(host, spelling, maxBytes)) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Posts one request for an image already read, and returns the reply's
 *  JSON or a failure worded for the caller to prefix. `model` is the name
 *  the caller gave, for the message that says how to start a server, and
 *  `servedName` the one `checkVisionModel` returned for it. */
export async function postVisionRequest(
  task: VisionTask,
  model: string,
  servedName: string,
  imageBase64: string,
  fields: Record<string, unknown>,
  options: LocalRequestOptions = {},
): Promise<LocalReply> {
  const out = await postLocalJson(
    VISION_TASKS[task].route,
    { model: servedName, image: imageBase64, ...fields },
    REQUEST_TIMEOUT_MS,
    "vision",
    options,
  );
  if ("error" in out) {
    return {
      error: explainNoServer(out.error, mlxBaseUrl(options.baseUrl), `agency local serve ${model}`),
    };
  }
  return out;
}

/** The stdlib's request: the model is checked first, so a wrong model is
 *  refused before a large file is read, then the approved file is read
 *  and sent. */
async function visionRequest(
  task: VisionTask,
  spelling: string,
  model: string,
  fields: Record<string, unknown>,
): Promise<LocalReply> {
  const host = currentHost();
  const checked = checkVisionModel(model);
  if ("error" in checked) {
    return checked;
  }
  const image = await approvedBase64(host, spelling, MAX_IMAGE_BYTES);
  if ("error" in image) {
    return image;
  }
  return postVisionRequest(task, model, checked.servedName, image.base64, fields);
}

/** The answer in a reply: its `replyField`, with each item given its
 *  index as `id` when the task's row says so. */
export function visionAnswer(task: VisionTask, reply: Record<string, unknown>): unknown {
  const row = VISION_TASKS[task];
  const answer = reply[row.replyField];
  if (!row.numbered) {
    return answer;
  }
  const items = Array.isArray(answer) ? answer : [];
  return items.map((item, id) => ({ id, ...item }));
}

/** One call to the vision server, as a `Result` whose failure starts with
 *  `name`. */
async function visionCall(
  name: string,
  task: VisionTask,
  spelling: string,
  model: string,
  fields: Record<string, unknown>,
): Promise<ResultValue> {
  const out = await visionRequest(task, spelling, model, fields);
  if ("error" in out) {
    return failure(`${name} failed: ${out.error}`);
  }
  return success(visionAnswer(task, out.reply));
}

/** The file a vision function reads: its real spelling, and the folder and
 *  name the std::vision interrupt shows. */
export type VisionFile = { image: string; dir: string; filename: string };

/** Resolves the image a vision function was given. Throws for a path that
 *  cannot be resolved, so the function fails before it asks anything. */
export async function _visionFile(spelling: string): Promise<VisionFile> {
  const host = currentHost();
  const image = await host.files.realPath(spelling);
  return { image, dir: path.dirname(image), filename: path.basename(image) };
}

/** Backs `std::vision.detectObjects`. A null threshold is sent as JSON
 *  null, which the server reads as the model's own default. */
export async function _detectObjects(
  spelling: string,
  labels: string[],
  model: string,
  threshold: number | null,
): Promise<ResultValue> {
  return visionCall("detectObjects", "detections", spelling, model, { labels, threshold });
}

/** Backs `std::vision.tagImage`. */
export async function _tagImage(
  spelling: string,
  model: string,
  threshold: number,
  limit: number,
): Promise<ResultValue> {
  return visionCall("tagImage", "tags", spelling, model, { threshold, limit });
}

/** Backs `std::vision.captionImage`. */
export async function _captionImage(
  spelling: string,
  model: string,
  detail: string,
): Promise<ResultValue> {
  return visionCall("captionImage", "captions", spelling, model, { detail });
}

/** Backs `std::vision.embedImage`. Null boxes are sent as JSON null, which
 *  the server reads as the whole image; an empty list embeds nothing. */
export async function _embedImage(
  spelling: string,
  model: string,
  boxes: unknown[] | null,
): Promise<ResultValue> {
  return visionCall("embedImage", "embeddings", spelling, model, { boxes });
}

/** Backs `std::vision.findRegions`. A null threshold is sent as JSON null,
 *  which the server reads as its default. */
export async function _findRegions(
  spelling: string,
  model: string,
  limit: number,
  threshold: number | null,
): Promise<ResultValue> {
  return visionCall("findRegions", "regions", spelling, model, { limit, threshold });
}
