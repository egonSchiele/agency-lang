import * as path from "node:path";
import { MAX_IMAGE_BYTES } from "./vision.js";
import { _realTarget, wholePath, stat as statUnder } from "./contained.js";
import { MIME_TYPES } from "./mediaPathScan.js";

/** The images a `generateImageLocal` request can carry, one row per request
 *  field. `INPUT_IMAGES` in lib/cli/diffusersImageRules.py is the same
 *  table for the image server, and a test compares the two.
 *
 *  mode      which kind of request the field makes: a ControlNet request,
 *            an edit from reference pictures, a redraw of a start image, or
 *            a redraw of the part of a start image a mask marks
 *  maxCount  how many images the field takes. One is sent as a base64
 *            string, more as a list of them
 *  maxBytes  the largest file each image may be
 *  parameter the `generateImageLocal` parameter the paths come in
 *  question  what the std::readImage interrupt asks before the file is read
 *  readEachStep  true: the model reads each image at every step, as much
 *            work as one more megapixel of output, and the provider's
 *            timeout budgets for it
 *  goesWith  optional: the field this one comes only with. A mask goes
 *            with a start image */
export type LocalImageField = {
  mode: "control" | "reference" | "img2img" | "inpaint";
  maxCount: number;
  maxBytes: number;
  parameter: string;
  question: string;
  readEachStep: boolean;
  goesWith?: string;
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
  mask_image: {
    mode: "inpaint",
    maxCount: 1,
    maxBytes: MAX_INPUT_IMAGE_BYTES,
    parameter: "mask",
    question: "Read this mask to choose which part of the picture to redraw?",
    readEachStep: false,
    goesWith: "start_image",
  },
};

/** The image fields a request in `mode` carries, the one that sets the size
 *  first. A field that goes with another brings it along, so inpaint is
 *  start_image and mask_image. `image_fields_of` in diffusersImageRules.py
 *  is the same. */
export function imageFieldsOf(mode: LocalImageField["mode"]): string[] {
  const fields = Object.keys(LOCAL_IMAGE_FIELDS).filter(
    (field) => LOCAL_IMAGE_FIELDS[field].mode === mode,
  );
  const partners = fields.flatMap((field) => {
    const partner = LOCAL_IMAGE_FIELDS[field].goesWith;
    return partner === undefined ? [] : [partner];
  });
  return [...partners, ...fields];
}

/** How many characters base64 turns `bytes` bytes into. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** The largest request body the image server takes: the settings, plus the
 *  base64 of the most image bytes one mode's fields may carry.
 *  `MAX_BODY_BYTES` in diffusersImageRules.py is computed the same way. */
export function localBodyBytes(): number {
  const modes = Object.values(LOCAL_IMAGE_FIELDS).map((row) => row.mode);
  const most = Math.max(
    ...modes.map((mode) =>
      imageFieldsOf(mode).reduce((total, field) => {
        const row = LOCAL_IMAGE_FIELDS[field];
        return total + base64Length(row.maxCount * row.maxBytes);
      }, 0),
    ),
  );
  return REQUEST_SETTINGS_BYTES + most;
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
 *  real spelling, the one the interrupt shows, and `field` is the request
 *  field it goes in. */
export type LocalImageFile = {
  field: string;
  path: string;
  dir: string;
  filename: string;
  question: string;
};

/** The input images of one `generateImageLocal` call, none for a call
 *  with none. `settings` holds the other request fields of the call's
 *  mode, such as `controlnet` and `control_scale`. */
export type LocalImageInputs = {
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
function localImageFile(spelling: string, field: string): LocalImageFile {
  const row = LOCAL_IMAGE_FIELDS[field];
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
    field,
    path: real,
    dir: path.dirname(real),
    filename: path.basename(real),
    question: row.question,
  };
}

/** How many images of `inputs` the model reads at every step, which the
 *  provider's timeout budgets for. 0 for a call with none. */
export function referenceCount(inputs: LocalImageInputs): number {
  return inputs.files.filter((file) => LOCAL_IMAGE_FIELDS[file.field].readEachStep).length;
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
  mask: string,
): LocalImageInputs {
  if ((controlnet === "") !== (controlImage === "")) {
    throw refusal(
      "controlnet and controlImage go together: the ControlNet's name, and the image it conditions the generation on.",
    );
  }
  // The mask is checked first, as the server does, so a call with a mask
  // and a strength but no start image hears about the mask.
  if (mask !== "" && startImage === "") {
    throw refusal("mask goes with startImage, and this call has none.");
  }
  if (strength !== null && startImage === "") {
    throw refusal("strength goes with startImage, and this call has none.");
  }
  // The server makes this check too, but after the file is approved and
  // read. Written so that NaN is refused.
  if (strength !== null && !(strength > 0 && strength <= 1)) {
    throw refusal(
      "strength must be a number above 0 and at most 1. Low keeps the start image close.",
    );
  }
  const paths: Record<string, string[]> = {
    control_image: controlImage === "" ? [] : [controlImage],
    images,
    start_image: startImage === "" ? [] : [startImage],
    mask_image: mask === "" ? [] : [mask],
  };
  // The other request fields of each image field's mode.
  const settingsOf: Record<string, Record<string, unknown>> = {
    control_image: controlSettings(controlnet, controlScale, invertControlImage),
    images: {},
    start_image: strengthSettings(strength),
    mask_image: {},
  };
  // A field that goes with another, such as the mask, is not a choice of
  // its own: it comes along with its partner.
  const leads = Object.keys(paths).filter(
    (field) => LOCAL_IMAGE_FIELDS[field].goesWith === undefined,
  );
  const given = leads.filter((field) => paths[field].length > 0);
  if (given.length === 0) {
    return { files: [], settings: {} };
  }
  if (given.length > 1) {
    const names = leads.map((field) => LOCAL_IMAGE_FIELDS[field].parameter);
    throw refusal(`a call takes one of ${orList(names)}.`);
  }
  const fields = [
    given[0],
    ...Object.keys(paths).filter(
      (field) => LOCAL_IMAGE_FIELDS[field].goesWith === given[0] && paths[field].length > 0,
    ),
  ];
  for (const field of fields) {
    const row = LOCAL_IMAGE_FIELDS[field];
    if (paths[field].length > row.maxCount) {
      throw refusal(
        `${row.parameter} takes at most ${row.maxCount} images. This call has ${paths[field].length}.`,
      );
    }
  }
  return {
    files: fields.flatMap((field) =>
      paths[field].map((spelling) => localImageFile(spelling, field)),
    ),
    settings: Object.assign({}, ...fields.map((field) => settingsOf[field])),
  };
}
