import * as path from "node:path";
import { MAX_IMAGE_BYTES } from "./vision.js";
import { _realTarget, wholePath, stat as statUnder } from "./contained.js";
import { MIME_TYPES } from "./mediaPathScan.js";

/** The images a `generateImageLocal` request can carry, one row per request
 *  field. `INPUT_IMAGES` in lib/cli/diffusersImageRules.py is the same
 *  table for the image server, and a test compares the two.
 *
 *  mode      which kind of request the field makes: a ControlNet request,
 *            an edit from reference pictures, or a redraw of a start image
 *  maxCount  how many images the field takes. One is sent as a base64
 *            string, more as a list of them
 *  maxBytes  the largest file each image may be
 *  parameter the `generateImageLocal` parameter the paths come in
 *  question  what the std::readImage interrupt asks before the file is read
 *  readEachStep  true: the model reads each image at every step, as much
 *            work as one more megapixel of output, and the provider's
 *            timeout budgets for it */
export type LocalImageField = {
  mode: "control" | "reference" | "img2img";
  maxCount: number;
  maxBytes: number;
  parameter: string;
  question: string;
  readEachStep: boolean;
};

/** A control image is read up to the size every local server takes. */
export const MAX_CONTROL_IMAGE_BYTES = MAX_IMAGE_BYTES;
/** A reference image or a start image. The model shrinks a reference to
 *  about one megapixel, and a start image is scaled to the output size,
 *  so a larger file buys nothing. */
export const MAX_INPUT_IMAGE_BYTES = 20_000_000;
export const MAX_REFERENCE_IMAGES = 4;
/** Room in a request body for everything but its images: the prompt and
 *  the settings. */
export const REQUEST_SETTINGS_BYTES = 64 * 1024;

export const LOCAL_IMAGE_FIELDS: Record<string, LocalImageField> = {
  control_image: {
    mode: "control",
    maxCount: 1,
    maxBytes: MAX_CONTROL_IMAGE_BYTES,
    parameter: "controlImage",
    question: "Read this drawing to condition the image on?",
    readEachStep: false,
  },
  images: {
    mode: "reference",
    maxCount: MAX_REFERENCE_IMAGES,
    maxBytes: MAX_INPUT_IMAGE_BYTES,
    parameter: "images",
    question: "Read this picture to edit it?",
    readEachStep: true,
  },
  start_image: {
    mode: "img2img",
    maxCount: 1,
    maxBytes: MAX_INPUT_IMAGE_BYTES,
    parameter: "startImage",
    question: "Read this picture to redraw it?",
    // The model starts from it once, instead of from noise.
    readEachStep: false,
  },
};

/** How many characters base64 turns `bytes` bytes into. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** The largest request body the image server takes: the settings, plus the
 *  base64 of the most image bytes any one field may carry. A request
 *  carries images of one field only. `MAX_BODY_BYTES` in
 *  diffusersImageRules.py is computed the same way. */
export function localBodyBytes(): number {
  const most = Math.max(
    ...Object.values(LOCAL_IMAGE_FIELDS).map((row) => row.maxCount * row.maxBytes),
  );
  return REQUEST_SETTINGS_BYTES + base64Length(most);
}

/** The image types a local input may be, by extension. */
export const IMAGE_MIME_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TYPES).filter(([, mime]) => mime.startsWith("image/")),
);

export function isRemoteSource(source: string): boolean {
  return (
    source.startsWith("data:") || source.startsWith("http://") || source.startsWith("https://")
  );
}

/** The real spelling of a local image file, once it is checked by name and
 *  stat: an image extension, a regular file, at most `maxBytes`. No byte is
 *  read, so a bad path fails here, before any approval is asked for.
 *  `caller` names the stdlib function in a refusal. */
export function checkedImageFile(spelling: string, maxBytes: number, caller: string): string {
  const real = _realTarget(spelling);
  const ext = path.extname(real).toLowerCase();
  if (IMAGE_MIME_TYPES[ext] === undefined) {
    const accepted = Object.keys(IMAGE_MIME_TYPES).join(", ");
    throw new Error(`${caller} cannot send ${real}. Accepted: ${accepted}.`);
  }
  const located = wholePath(real);
  const info = statUnder(located.root, located.target);
  if (info === null) {
    throw new Error(`no such file: ${real}`);
  }
  if (!info.isFile()) {
    throw new Error(`not a regular file: ${real}`);
  }
  if (info.size > maxBytes) {
    throw new Error(
      `${real} is ${info.size.toLocaleString("en-US")} bytes; the most ${caller} sends is ${maxBytes.toLocaleString("en-US")}.`,
    );
  }
  return real;
}

/** One file a `generateImageLocal` call reads, after the std::readImage
 *  interrupt that shows its folder and name asks `question`. `path` is its
 *  real spelling, the one the interrupt shows. */
export type LocalImageFile = {
  path: string;
  dir: string;
  filename: string;
  question: string;
};

/** The input images of one `generateImageLocal` call. `field` is the
 *  request field the files go in, or null for a call with none.
 *  `settings` holds the other request fields of the field's mode, such as
 *  `controlnet` and `control_scale`. */
export type LocalImageInputs = {
  field: string | null;
  files: LocalImageFile[];
  settings: Record<string, unknown>;
};

const CALLER = "generateImageLocal";

/** The request fields that say how to apply a ControlNet. A null scale is
 *  left out, so the server uses its default. */
function controlSettings(
  controlnet: string,
  controlScale: number | null,
  invertControlImage: boolean,
): Record<string, unknown> {
  const given: [string, unknown][] = [
    ["controlnet", controlnet],
    ["control_invert", invertControlImage],
    ["control_scale", controlScale],
  ];
  return Object.fromEntries(given.filter(([, value]) => value !== null));
}

/** The request field that says how much of a start image to redraw. A
 *  null strength is left out, so the server uses the family's default. */
function strengthSettings(strength: number | null): Record<string, unknown> {
  return strength === null ? {} : { strength };
}

/** "a", "a or b", or "a, b, or c". */
function orList(names: string[]): string {
  if (names.length <= 2) {
    return names.join(" or ");
  }
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

function refusal(message: string): Error {
  return new Error(`${CALLER} failed: ${message}`);
}

/** A local path checked for the row's byte cap, with what its interrupt
 *  shows. A URL or a data URI is refused: the image server never fetches
 *  anything, so every input is a file on this machine. */
function localImageFile(spelling: string, row: LocalImageField): LocalImageFile {
  if (isRemoteSource(spelling)) {
    throw new Error(`${CALLER} reads files on this machine only.`);
  }
  let real: string;
  try {
    real = checkedImageFile(spelling, row.maxBytes, CALLER);
  } catch (err) {
    throw refusal((err as Error).message);
  }
  return {
    path: real,
    dir: path.dirname(real),
    filename: path.basename(real),
    question: row.question,
  };
}

/** How many images of `inputs` the model reads at every step, which the
 *  provider's timeout budgets for. 0 for a call with none. */
export function referenceCount(inputs: LocalImageInputs): number {
  if (inputs.field === null || !LOCAL_IMAGE_FIELDS[inputs.field].readEachStep) {
    return 0;
  }
  return inputs.files.length;
}

/** Backs the checks `generateImageLocal` makes before it asks anything:
 *  which input images the call has, whether they go together, whether
 *  there are too many, and whether each path is a local image file under
 *  its field's size cap. Returns the files to raise std::readImage for.
 *  Throws with the message to fail with. The messages match the image
 *  server's, with the parameters' names for the request fields'. */
export function _localImageInputs(
  controlnet: string,
  controlImage: string,
  controlScale: number | null,
  invertControlImage: boolean,
  images: string[],
  startImage: string,
  strength: number | null,
): LocalImageInputs {
  if ((controlnet === "") !== (controlImage === "")) {
    throw refusal(
      "controlnet and controlImage go together: the ControlNet's name, and the image it conditions the generation on.",
    );
  }
  if (strength !== null && startImage === "") {
    throw refusal("strength goes with startImage, and this call has none.");
  }
  const paths: Record<string, string[]> = {
    control_image: controlImage === "" ? [] : [controlImage],
    images,
    start_image: startImage === "" ? [] : [startImage],
  };
  // The other request fields of each image field's mode.
  const settingsOf: Record<string, Record<string, unknown>> = {
    control_image: controlSettings(controlnet, controlScale, invertControlImage),
    images: {},
    start_image: strengthSettings(strength),
  };
  const given = Object.keys(paths).filter((field) => paths[field].length > 0);
  if (given.length === 0) {
    return { field: null, files: [], settings: {} };
  }
  if (given.length > 1) {
    const names = Object.keys(paths).map((field) => LOCAL_IMAGE_FIELDS[field].parameter);
    throw refusal(`a call takes one of ${orList(names)}.`);
  }
  const field = given[0];
  const row = LOCAL_IMAGE_FIELDS[field];
  if (paths[field].length > row.maxCount) {
    throw refusal(
      `${row.parameter} takes at most ${row.maxCount} images. This call has ${paths[field].length}.`,
    );
  }
  return {
    field,
    files: paths[field].map((spelling) => localImageFile(spelling, row)),
    settings: settingsOf[field],
  };
}
