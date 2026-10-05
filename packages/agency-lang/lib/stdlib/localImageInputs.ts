import * as path from "node:path";
import { MAX_IMAGE_BYTES } from "./vision.js";
import { _realTarget, wholePath, stat as statUnder } from "./contained.js";
import { MIME_TYPES } from "./mediaPathScan.js";
import { approvedFileBytes } from "./approvedPath.js";

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

/** The stdlib function these checks were written for. Its name starts
 *  every refusal it gets. `generateImage` in `agency-lang/local` passes its
 *  own name to the same checks. */
const STDLIB_CALLER = "generateImageLocal";

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

function refusal(caller: string, message: string): Error {
  return new Error(`${caller} failed: ${message}`);
}

/** A local path checked for the row's byte cap, with what its interrupt
 *  shows. A URL or a data URI is refused: the image server never fetches
 *  anything, so every input is a file on this machine. */
function localImageFile(spelling: string, field: string, caller: string): LocalImageFile {
  const row = LOCAL_IMAGE_FIELDS[field];
  if (isRemoteSource(spelling)) {
    throw new Error(`${caller} reads files on this machine only.`);
  }
  let real: string;
  try {
    real = checkedImageFile(spelling, row.maxBytes, caller);
  } catch (err) {
    throw refusal(caller, (err as Error).message);
  }
  return {
    field,
    path: real,
    dir: path.dirname(real),
    filename: path.basename(real),
    question: row.question,
  };
}

/** How many of the images in these request fields the model reads at
 *  every step. `fieldOfEachImage` has one entry per image. */
function readEachStepCount(fieldOfEachImage: string[]): number {
  return fieldOfEachImage.filter((field) => LOCAL_IMAGE_FIELDS[field].readEachStep).length;
}

/** How many images of `inputs` the model reads at every step, which the
 *  provider's timeout budgets for. 0 for a call with none. */
export function referenceCount(inputs: LocalImageInputs): number {
  return readEachStepCount(inputs.files.map((file) => file.field));
}

/** How many images a call gave for each request field, by field name:
 *  `{ control_image: 0, images: 2, start_image: 0, mask_image: 0 }`. */
export type ImageCounts = Record<string, number>;

/** The settings of a call that belong to one mode or another. */
export type ModeControls = {
  controlnet: string;
  controlScale: number | null;
  invertControlImage: boolean;
  strength: number | null;
};

/** Which kind of request a call makes, decided from how many images it
 *  gave and no file.
 *
 *  fields      the request fields in play, the one that sets the size
 *              first. Empty for a call with no input image
 *  settings    the other request fields of the mode, such as `controlnet`
 *  references  how many images the model reads at every step, for the
 *              timeout */
export type LocalImageMode = {
  fields: string[];
  settings: Record<string, unknown>;
  references: number;
};

/** The checks on a call's input images that need no file: whether the
 *  inputs go together, whether the strength is in range, that the call is
 *  in one mode, and that no field has too many images. Throws with the
 *  message to fail with, which starts with `caller`. The messages match
 *  the image server's, with the parameters' names for the request
 *  fields'. */
export function localImageMode(
  counts: ImageCounts,
  controls: ModeControls,
  caller: string,
): LocalImageMode {
  const { controlnet, controlScale, invertControlImage, strength } = controls;
  const has = (field: string) => (counts[field] ?? 0) > 0;
  if ((controlnet === "") === has("control_image")) {
    throw refusal(
      caller,
      "controlnet and controlImage go together: the ControlNet's name, and the image it conditions the generation on.",
    );
  }
  // The mask is checked first, as the server does, so a call with a mask
  // and a strength but no start image hears about the mask.
  if (has("mask_image") && !has("start_image")) {
    throw refusal(caller, "mask goes with startImage, and this call has none.");
  }
  if (strength !== null && !has("start_image")) {
    throw refusal(caller, "strength goes with startImage, and this call has none.");
  }
  // The server makes this check too, but after the file is approved and
  // read. Written so that NaN is refused.
  if (strength !== null && !(strength > 0 && strength <= 1)) {
    throw refusal(
      caller,
      "strength must be a number above 0 and at most 1. Low keeps the start image close.",
    );
  }
  // The other request fields of each image field's mode.
  const settingsOf: Record<string, Record<string, unknown>> = {
    control_image: controlSettings(controlnet, controlScale, invertControlImage),
    images: {},
    start_image: strengthSettings(strength),
    mask_image: {},
  };
  const names = Object.keys(LOCAL_IMAGE_FIELDS);
  // A field that goes with another, such as the mask, is not a choice of
  // its own: it comes along with its partner.
  const leads = names.filter((field) => LOCAL_IMAGE_FIELDS[field].goesWith === undefined);
  const given = leads.filter(has);
  if (given.length === 0) {
    return { fields: [], settings: {}, references: 0 };
  }
  if (given.length > 1) {
    const parameters = leads.map((field) => LOCAL_IMAGE_FIELDS[field].parameter);
    throw refusal(caller, `a call takes one of ${orList(parameters)}.`);
  }
  const fields = [
    given[0],
    ...names.filter((field) => LOCAL_IMAGE_FIELDS[field].goesWith === given[0] && has(field)),
  ];
  for (const field of fields) {
    const row = LOCAL_IMAGE_FIELDS[field];
    if (counts[field] > row.maxCount) {
      throw refusal(
        caller,
        `${row.parameter} takes at most ${row.maxCount} images. This call has ${counts[field]}.`,
      );
    }
  }
  return {
    fields,
    settings: Object.assign({}, ...fields.map((field) => settingsOf[field])),
    references: readEachStepCount(
      fields.flatMap((field) => Array.from({ length: counts[field] }, () => field)),
    ),
  };
}

/** Backs the checks `generateImageLocal` makes before it asks anything:
 *  which input images the call has, whether they go together, whether
 *  there are too many, and whether each path is a local image file under
 *  its field's size cap. Returns the files to raise std::readImage for.
 *  Throws with the message to fail with. */
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
  const paths: Record<string, string[]> = {
    control_image: controlImage === "" ? [] : [controlImage],
    images,
    start_image: startImage === "" ? [] : [startImage],
    mask_image: mask === "" ? [] : [mask],
  };
  const counts = Object.fromEntries(
    Object.entries(paths).map(([field, given]) => [field, given.length]),
  );
  const mode = localImageMode(
    counts,
    { controlnet, controlScale, invertControlImage, strength },
    STDLIB_CALLER,
  );
  return {
    files: mode.fields.flatMap((field) =>
      paths[field].map((spelling) => localImageFile(spelling, field, STDLIB_CALLER)),
    ),
    settings: mode.settings,
  };
}

/** The value a request field carries for its images, each already
 *  base64: one string when the field takes one image, a list otherwise. */
export function fieldValue(field: string, encoded: string[]): string | string[] {
  return LOCAL_IMAGE_FIELDS[field].maxCount === 1 ? encoded[0] : encoded;
}

/** One input image as base64, from a path or from the image's bytes, at
 *  most `maxBytes` either way. For the functions `agency-lang/local`
 *  exports, which take both and raise no interrupt.
 *
 *  A path goes through the same checks a stdlib input does: a file on
 *  this machine, an image extension, a regular file, no symlink, and a
 *  read through the contained-files module. Throws with the reason. */
export function encodedImageInput(
  input: string | Uint8Array,
  maxBytes: number,
  caller: string,
): string {
  if (typeof input === "string") {
    if (isRemoteSource(input)) {
      throw new Error(`${caller} reads files on this machine only.`);
    }
    const real = checkedImageFile(input, maxBytes, caller);
    return approvedFileBytes(real, maxBytes).toString("base64");
  }
  if (input.length > maxBytes) {
    throw new Error(
      `the image is ${input.length.toLocaleString("en-US")} bytes; the most ${caller} sends is ${maxBytes.toLocaleString("en-US")}.`,
    );
  }
  return Buffer.from(input).toString("base64");
}
