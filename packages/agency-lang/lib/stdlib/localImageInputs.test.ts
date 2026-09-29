import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import {
  _localImageInputs,
  MAX_CONTROL_IMAGE_BYTES,
  MAX_INPUT_IMAGE_BYTES,
  referenceCount,
} from "./localImageInputs.js";

describe("_localImageInputs", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-inputs-")));
  const pose = path.join(dir, "pose.png");
  fs.writeFileSync(pose, "png");
  fs.symlinkSync(pose, path.join(dir, "linked.png"));
  // Sparse, so the test writes no 50 MB.
  fs.writeFileSync(path.join(dir, "huge.png"), "");
  fs.truncateSync(path.join(dir, "huge.png"), MAX_CONTROL_IMAGE_BYTES + 1);
  // 21 MB: under the control image's cap, over a reference's.
  fs.writeFileSync(path.join(dir, "photo.png"), "");
  fs.truncateSync(path.join(dir, "photo.png"), 21_000_000);
  fs.writeFileSync(path.join(dir, "notes.txt"), "text");
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pairing =
    "generateImageLocal failed: controlnet and controlImage go together: the ControlNet's name, and the image it conditions the generation on.";

  it("has nothing to read for a call with no input image", () => {
    expect(_localImageInputs("", "", 0.5, true, [], "", null)).toEqual({
      field: null,
      files: [],
      settings: {},
    });
  });

  it("returns the control image to ask about, and the ControlNet settings", () => {
    expect(_localImageInputs("scribble", pose, 0.8, true, [], "", null)).toEqual({
      field: "control_image",
      files: [
        {
          path: pose,
          dir,
          filename: "pose.png",
          question: "Read this drawing to condition the image on?",
        },
      ],
      settings: { controlnet: "scribble", control_scale: 0.8, control_invert: true },
    });
    // A null scale is left out, so the server uses its default.
    expect(_localImageInputs("scribble", pose, null, false, [], "", null).settings).toEqual({
      controlnet: "scribble",
      control_invert: false,
    });
  });

  it("refuses a ControlNet without an image, and an image without a ControlNet", () => {
    expect(() => _localImageInputs("scribble", "", null, false, [], "", null)).toThrow(pairing);
    expect(() => _localImageInputs("", pose, null, false, [], "", null)).toThrow(pairing);
  });

  it("refuses a missing file, a symlink, and a file over the cap", () => {
    expect(() =>
      _localImageInputs("scribble", path.join(dir, "nope.png"), null, false, [], "", null),
    ).toThrow(`generateImageLocal failed: no such file: ${path.join(dir, "nope.png")}`);
    expect(() =>
      _localImageInputs("scribble", path.join(dir, "linked.png"), null, false, [], "", null),
    ).toThrow(
      // The contained-files layer refuses a symlink by not seeing it.
      `generateImageLocal failed: no such file: ${path.join(dir, "linked.png")}`,
    );
    expect(() =>
      _localImageInputs("scribble", path.join(dir, "huge.png"), null, false, [], "", null),
    ).toThrow(
      `generateImageLocal failed: ${path.join(dir, "huge.png")} is 50,000,001 bytes; the most generateImageLocal sends is 50,000,000.`,
    );
  });

  it("refuses a URL or a data URI", () => {
    for (const remote of ["https://example.com/pose.png", "data:image/png;base64,cG5n"]) {
      expect(() => _localImageInputs("scribble", remote, null, false, [], "", null)).toThrow(
        "generateImageLocal reads files on this machine only.",
      );
    }
  });

  const edit = (images: string[]) => _localImageInputs("", "", null, false, images, "", null);

  it("returns each reference to ask about, in order, with no other settings", () => {
    const hat = path.join(dir, "hat.png");
    fs.writeFileSync(hat, "png");
    const inputs = edit([pose, hat]);
    expect(inputs).toEqual({
      field: "images",
      files: [
        { path: pose, dir, filename: "pose.png", question: "Read this picture to edit it?" },
        { path: hat, dir, filename: "hat.png", question: "Read this picture to edit it?" },
      ],
      settings: {},
    });
    expect(referenceCount(inputs)).toBe(2);
    expect(referenceCount(_localImageInputs("scribble", pose, null, false, [], "", null))).toBe(0);
  });

  it("refuses five references", () => {
    expect(() => edit([pose, pose, pose, pose, pose])).toThrow(
      "generateImageLocal failed: images takes at most 4 images. This call has 5.",
    );
  });

  it("refuses references together with a control image", () => {
    expect(() => _localImageInputs("scribble", pose, null, false, [pose], "", null)).toThrow(
      "generateImageLocal failed: a call takes one of controlImage, images, or startImage.",
    );
  });

  const redraw = (startImage: string, strength: number | null = null) =>
    _localImageInputs("", "", null, false, [], startImage, strength);

  it("returns the start image to ask about, with the strength when one is given", () => {
    const inputs = redraw(pose, 0.4);
    expect(inputs).toEqual({
      field: "start_image",
      files: [
        { path: pose, dir, filename: "pose.png", question: "Read this picture to redraw it?" },
      ],
      settings: { strength: 0.4 },
    });
    // The model starts from it once and does not read it at every step.
    expect(referenceCount(inputs)).toBe(0);
    // A null strength is left out, so the server uses the model's default.
    expect(redraw(pose).settings).toEqual({});
  });

  it("refuses a strength with no start image", () => {
    expect(() => redraw("", 0.4)).toThrow(
      "generateImageLocal failed: strength goes with startImage, and this call has none.",
    );
  });

  it("refuses a start image together with references or a control image", () => {
    const message =
      "generateImageLocal failed: a call takes one of controlImage, images, or startImage.";
    expect(() => _localImageInputs("", "", null, false, [pose], pose, null)).toThrow(message);
    expect(() => _localImageInputs("scribble", pose, null, false, [], pose, null)).toThrow(message);
  });

  it("refuses a start image over its cap, a missing one, and a URL", () => {
    const photo = path.join(dir, "photo.png");
    expect(() => redraw(photo)).toThrow(
      `generateImageLocal failed: ${photo} is 21,000,000 bytes; the most generateImageLocal sends is ${MAX_INPUT_IMAGE_BYTES.toLocaleString("en-US")}.`,
    );
    expect(() => redraw(path.join(dir, "nope.png"))).toThrow(
      `generateImageLocal failed: no such file: ${path.join(dir, "nope.png")}`,
    );
    expect(() => redraw("https://example.com/photo.png")).toThrow(
      "generateImageLocal reads files on this machine only.",
    );
  });

  it("refuses a reference over its cap, a file that is not an image, and a URL", () => {
    const photo = path.join(dir, "photo.png");
    expect(() => edit([photo])).toThrow(
      `generateImageLocal failed: ${photo} is 21,000,000 bytes; the most generateImageLocal sends is ${MAX_INPUT_IMAGE_BYTES.toLocaleString("en-US")}.`,
    );
    expect(() => edit([path.join(dir, "notes.txt")])).toThrow(
      `generateImageLocal failed: generateImageLocal cannot send ${path.join(dir, "notes.txt")}.`,
    );
    expect(() => edit(["https://example.com/cat.png"])).toThrow(
      "generateImageLocal reads files on this machine only.",
    );
  });
});
