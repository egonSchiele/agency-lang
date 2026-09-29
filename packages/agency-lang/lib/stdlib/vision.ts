import { success, failure, type ResultValue } from "../runtime/result.js";
import { _resolveModel, _mlxServedName, _localModelKindOf } from "./localModels.js";
import { mlxBaseUrl, isNoServerError } from "./mlxServerModels.js";
import { _approvedFilePath } from "./approvedPath.js";

/** The TypeScript half of `std::vision`: one HTTP call behind three thin
 *  exports. The Agency side has already raised `std::vision` for the
 *  image's real path; this side re-validates that spelling, checks the
 *  model is a vision model, and posts to the server `agency local serve`
 *  runs. */

/** The largest image sent. `MAX_IMAGE_BYTES` in
 *  lib/cli/localServerCommon.py is the same, and a test compares them. */
export const MAX_IMAGE_BYTES = 50_000_000;

/** The route each task answers on, under the server's `/v1`. */
const ROUTE_FOR_TASK = {
  detections: "/vision/detections",
  tags: "/vision/tags",
  captions: "/vision/captions",
};

type VisionTask = keyof typeof ROUTE_FOR_TASK;

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
  let imagePath: string;
  try {
    imagePath = _approvedFilePath(spelling);
  } catch (err) {
    return { error: (err as Error).message };
  }
  let res: Response;
  try {
    res = await fetch(`${mlxBaseUrl()}${ROUTE_FOR_TASK[task]}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: checked.servedName, image: imagePath, ...fields }),
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

function asResult(
  name: string,
  out: { reply: Record<string, unknown> } | { error: string },
  field: string,
): ResultValue {
  if ("error" in out) {
    return failure(`${name} failed: ${out.error}`);
  }
  return success(out.reply[field]);
}

/** Backs `std::vision.detectObjects`. Each detection gets an `id`, its
 *  index in the reply, so a caller can name crops without inventing
 *  names. */
export async function _detectObjects(
  spelling: string,
  labels: string[],
  model: string,
  threshold: number,
): Promise<ResultValue> {
  const out = await visionRequest("detections", spelling, model, { labels, threshold });
  if ("error" in out) {
    return failure(`detectObjects failed: ${out.error}`);
  }
  const detections = Array.isArray(out.reply.detections) ? out.reply.detections : [];
  return success(detections.map((detection, id) => ({ id, ...detection })));
}

/** Backs `std::vision.tagImage`. */
export async function _tagImage(
  spelling: string,
  model: string,
  threshold: number,
  limit: number,
): Promise<ResultValue> {
  return asResult(
    "tagImage",
    await visionRequest("tags", spelling, model, { threshold, limit }),
    "tags",
  );
}

/** Backs `std::vision.captionImage`. */
export async function _captionImage(
  spelling: string,
  model: string,
  detail: string,
): Promise<ResultValue> {
  return asResult(
    "captionImage",
    await visionRequest("captions", spelling, model, { detail }),
    "caption",
  );
}
