import { MAX_IMAGE_BYTES } from "./vision.js";

/** The images a `generateImageLocal` request can carry, one row per request
 *  field. `INPUT_IMAGES` in lib/cli/diffusersImageRules.py is the same
 *  table for the image server, and a test compares the two.
 *
 *  mode      which kind of request the field makes: a ControlNet request,
 *            an edit from reference pictures, or a redraw of a picture
 *  maxCount  how many images the field takes. One is sent as a base64
 *            string, more as a list of them
 *  maxBytes  the largest file each image may be
 *  question  what the std::readImage interrupt asks before the file is read */
export type LocalImageField = {
  mode: "control" | "reference" | "img2img";
  maxCount: number;
  maxBytes: number;
  question: string;
};

/** A control image is read up to the size every local server takes. */
export const MAX_CONTROL_IMAGE_BYTES = MAX_IMAGE_BYTES;
/** A reference or start image. The model shrinks it to about one megapixel,
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
    question: "Read this drawing to condition the image on?",
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
