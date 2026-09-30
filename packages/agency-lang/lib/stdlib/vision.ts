import { success, failure, type ResultValue } from "../runtime/result.js";
import { _resolveModel, _mlxServedName, _localModelKindOf } from "./localModels.js";
import { mlxBaseUrl, isNoServerError } from "./mlxServerModels.js";
import { approvedFileBytes } from "./approvedPath.js";
import { _realTarget } from "./contained.js";
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

/** What the client knows about one vision task.
 *
 *  route       where the server answers it, under `/v1`
 *  replyField  the field of the reply that holds the answer
 *  numbered    true: each item of the answer gets an `id`, its index, so
 *              a caller can name crops after it
 *  logNoun     what the serve log counts the answer in, such as "tag"
 *  logBody     false: the serve log shows the count alone, not the reply */
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
export const VISION_TASKS: Record<string, VisionTaskRow> = {
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
};

type VisionTask = keyof typeof VISION_TASKS;

/** A detector on a large page can take a minute on the CPU, and a request
 *  may wait behind one already running. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** The model to send: the served name, or the reason it cannot be sent. */
function checkVisionModel(model: string): { servedName: string } | { error: string } {
  if (model === "") {
    return { error: "model cannot be empty." };
  }
  try {
    const resolved = _resolveModel(model);
    const kind = _localModelKindOf(model);
    if (kind !== null && kind !== "vision") {
      return {
        error:
          `"${model}" is ${kind === "image" ? "an" : "a"} ${kind} model, not a vision model. ` +
          "Local vision models are detectors and taggers such as wd14-tagger and florence-2.",
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
function approvedBase64(
  spelling: string,
  maxBytes: number,
): { base64: string } | { error: string } {
  try {
    return { base64: approvedFileBytes(spelling, maxBytes).toString("base64") };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Posts one request and returns the reply's JSON, or a failure worded
 *  for the caller to prefix. */
async function visionRequest(
  task: VisionTask,
  spelling: string,
  model: string,
  fields: Record<string, unknown>,
): Promise<{ reply: Record<string, unknown> } | { error: string }> {
  const checked = checkVisionModel(model);
  if ("error" in checked) {
    return checked;
  }
  const image = approvedBase64(spelling, MAX_IMAGE_BYTES);
  if ("error" in image) {
    return image;
  }
  let res: Response;
  try {
    res = await fetch(`${mlxBaseUrl()}${VISION_TASKS[task].route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: checked.servedName, image: image.base64, ...fields }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = (err as Error).message;
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const full = `${message}${cause === undefined ? "" : ` (${cause})`}`;
    if (isNoServerError(full)) {
      return {
        error: `no local model server answered at ${mlxBaseUrl()}. Start one with:\n  agency local serve ${model}`,
      };
    }
    return { error: full };
  }
  let reply: Record<string, unknown>;
  try {
    reply = (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: `The vision server answered ${res.status} with a body that is not JSON.` };
  }
  if (!res.ok) {
    const message = (reply.error as { message?: unknown } | undefined)?.message;
    return {
      error: typeof message === "string" ? message : `The vision server answered ${res.status}.`,
    };
  }
  return { reply };
}

/** One call to the vision server, as a `Result` whose failure starts with
 *  `name`. The answer is the reply's `replyField`, with each item given its
 *  index as `id` when the task's row says so. */
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
  const row = VISION_TASKS[task];
  const answer = out.reply[row.replyField];
  if (!row.numbered) {
    return success(answer);
  }
  const items = Array.isArray(answer) ? answer : [];
  return success(items.map((item, id) => ({ id, ...item })));
}

/** One file a vision function reads, and what the std::vision interrupt
 *  asks before it does. */
export type VisionAsk = { question: string; dir: string; filename: string };

/** The files a vision function reads: the image's real spelling, and one
 *  ask per file, in the order the function raises them. Throws for a path
 *  that cannot be resolved, before anything is asked. */
export type VisionFiles = { image: string; asks: VisionAsk[] };

export function _visionFiles(spelling: string, question: string): VisionFiles {
  const image = _realTarget(spelling);
  return {
    image,
    asks: [{ question, dir: path.dirname(image), filename: path.basename(image) }],
  };
}

/** Backs `std::vision.detectObjects`. */
export async function _detectObjects(
  spelling: string,
  labels: string[],
  model: string,
  threshold: number,
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
