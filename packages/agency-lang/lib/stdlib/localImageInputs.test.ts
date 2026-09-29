import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import { _localImageInputs, MAX_CONTROL_IMAGE_BYTES } from "./localImageInputs.js";

describe("_localImageInputs", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-inputs-")));
  const pose = path.join(dir, "pose.png");
  fs.writeFileSync(pose, "png");
  fs.symlinkSync(pose, path.join(dir, "linked.png"));
  // Sparse, so the test writes no 50 MB.
  fs.writeFileSync(path.join(dir, "huge.png"), "");
  fs.truncateSync(path.join(dir, "huge.png"), MAX_CONTROL_IMAGE_BYTES + 1);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pairing =
    "generateImageLocal failed: controlnet and controlImage go together: the ControlNet's name, and the image it conditions the generation on.";

  it("has nothing to read for a call with no input image", () => {
    expect(_localImageInputs("", "", 0.5, true)).toEqual({
      field: null,
      files: [],
      settings: {},
    });
  });

  it("returns the control image to ask about, and the ControlNet settings", () => {
    expect(_localImageInputs("scribble", pose, 0.8, true)).toEqual({
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
    expect(_localImageInputs("scribble", pose, null, false).settings).toEqual({
      controlnet: "scribble",
      control_invert: false,
    });
  });

  it("refuses a ControlNet without an image, and an image without a ControlNet", () => {
    expect(() => _localImageInputs("scribble", "", null, false)).toThrow(pairing);
    expect(() => _localImageInputs("", pose, null, false)).toThrow(pairing);
  });

  it("refuses a missing file, a symlink, and a file over the cap", () => {
    expect(() => _localImageInputs("scribble", path.join(dir, "nope.png"), null, false)).toThrow(
      `generateImageLocal failed: no such file: ${path.join(dir, "nope.png")}`,
    );
    expect(() => _localImageInputs("scribble", path.join(dir, "linked.png"), null, false)).toThrow(
      // The contained-files layer refuses a symlink by not seeing it.
      `generateImageLocal failed: no such file: ${path.join(dir, "linked.png")}`,
    );
    expect(() => _localImageInputs("scribble", path.join(dir, "huge.png"), null, false)).toThrow(
      `generateImageLocal failed: ${path.join(dir, "huge.png")} is 50,000,001 bytes; the most generateImageLocal sends is 50,000,000.`,
    );
  });

  it("refuses a URL or a data URI", () => {
    for (const remote of ["https://example.com/pose.png", "data:image/png;base64,cG5n"]) {
      expect(() => _localImageInputs("scribble", remote, null, false)).toThrow(
        "generateImageLocal reads files on this machine only.",
      );
    }
  });
});
