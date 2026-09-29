import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { _cropImage, _imageSize, _pasteImages, imageToolsScript } from "./imageTools.js";
import { configuredPython } from "./localPython.js";

const rulesDir = path.dirname(imageToolsScript());

/** Runs `code` with imageToolsRules.py importable, under the plain
 *  python3 CI has, and returns stdout. */
function rules(code: string): string {
  const run = spawnSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, sys.argv[1]); from imageToolsRules import *\n${code}`,
      rulesDir,
    ],
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return run.stdout.toString().trim();
}

/** The value or the ValueError of one call, as JSON. */
function ruleResult(call: string): unknown {
  return JSON.parse(
    rules(`
import json
try:
    print(json.dumps(${call}))
except ValueError as e:
    print(json.dumps({"error": str(e)}))
`),
  );
}

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

// The arithmetic, which needs no Pillow, so CI runs it.
describe.skipIf(!hasPython3)("imageToolsRules.py", () => {
  it("imports nothing from Pillow", () => {
    const text = fs.readFileSync(path.join(rulesDir, "imageToolsRules.py"), "utf8");
    expect(text).not.toMatch(/^\s*(import|from)\s+PIL/m);
  });

  it("grows a crop box by the pad and clamps it to the image", () => {
    expect(ruleResult("crop_box(0.25, 0.5, 0.5, 0.5, 0, 200, 100)")).toEqual([50, 50, 150, 100]);
    // 10 px each side of a 100 wide box, 5 px above a 50 tall one, and
    // the bottom clamped to the image's edge.
    expect(ruleResult("crop_box(0.25, 0.5, 0.5, 0.5, 0.1, 200, 100)")).toEqual([40, 45, 160, 100]);
  });

  it("refuses a crop box that covers nothing", () => {
    expect(ruleResult("crop_box(1, 1, 0.1, 0.1, 0, 200, 100)")).toEqual({
      error: "the box covers nothing of a 200x100 image",
    });
  });

  it("lays images out in rows, each centered in a cell the size of the largest", () => {
    expect(ruleResult("paste_layout([(200, 100), (50, 40), (50, 40)], 2)")).toEqual({
      canvas: [400, 200],
      corners: [
        [0, 0],
        [275, 30],
        [75, 130],
      ],
    });
  });

  it("refuses no images, no columns, and a canvas over the pixel limit", () => {
    expect(ruleResult("paste_layout([], 2)")).toEqual({ error: "paste needs at least one image" });
    expect(ruleResult("paste_layout([(10, 10)], 0)")).toEqual({
      error: "columns must be at least 1",
    });
    // 100 scans of 5000 by 7000 pixels, in rows of ten, would be 3.5 billion pixels.
    expect(ruleResult("paste_layout([(5000, 7000)] * 100, 10)")).toEqual({
      error:
        "the canvas would be 50000x70000, over 100,000,000 pixels. Paste fewer or smaller images.",
    });
  });
});

// These tests run the real script, which needs a Python with Pillow: the
// one `agency local serve` uses. Without it the block skips, as the image
// server's live test does.
const python = configuredPython();
const hasPillow = spawnSync(python, ["-c", "import PIL"], { stdio: "ignore" }).status === 0;

/** A PNG of one color, made by the same Pillow the tools use. */
function writePng(file: string, width: number, height: number, color: string): void {
  const run = spawnSync(python, [
    "-c",
    `from PIL import Image; import sys; Image.new("RGB", (${width}, ${height}), ${color}).save(sys.argv[1])`,
    file,
  ]);
  expect(run.status).toBe(0);
}

describe.skipIf(!hasPillow)("imageTools", () => {
  let dir: string;
  let page: string;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imagetools-")));
    page = path.join(dir, "page.png");
    writePng(page, 200, 100, "(200, 50, 50)");
  });

  afterAll(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  it("ships next to the server scripts", () => {
    expect(fs.existsSync(imageToolsScript())).toBe(true);
  });

  it("reads an image's size", async () => {
    const r = await _imageSize(page);
    expect(r.success && r.value).toEqual({ width: 200, height: 100 });
  });

  it("cuts a box out, grown by the pad, and pads it square when asked", async () => {
    const box = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 };
    const plain = await _cropImage(page, box, path.join(dir, "plain.png"), 0, false);
    expect(plain.success && plain.value).toBe(path.join(dir, "plain.png"));
    expect((await _imageSize(path.join(dir, "plain.png"))).value).toEqual({
      width: 100,
      height: 50,
    });
    // Pad of 0.1: 10 px each side of a 100 wide box, 5 px each side of a
    // 50 tall one, and the bottom is clamped to the image's edge.
    await _cropImage(page, box, path.join(dir, "padded.png"), 0.1, false);
    expect((await _imageSize(path.join(dir, "padded.png"))).value).toEqual({
      width: 120,
      height: 55,
    });
    await _cropImage(page, box, path.join(dir, "square.png"), 0, true);
    expect((await _imageSize(path.join(dir, "square.png"))).value).toEqual({
      width: 100,
      height: 100,
    });
  });

  it("refuses to overwrite an output that exists, and a box that covers nothing", async () => {
    const box = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const again = await _cropImage(page, box, path.join(dir, "plain.png"), 0, false);
    expect(again.success === false && again.error).toBe(
      `cropImage failed: ${path.join(dir, "plain.png")} already exists. Remove it first, or write elsewhere.`,
    );
    const empty = await _cropImage(
      page,
      { x: 1, y: 1, width: 0.1, height: 0.1 },
      path.join(dir, "empty.png"),
      0,
      false,
    );
    expect(empty.success === false && empty.error).toBe(
      "cropImage failed: the box covers nothing of a 200x100 image",
    );
    expect(fs.existsSync(path.join(dir, "empty.png"))).toBe(false);
  });

  it("refuses a source reached through a symlink", async () => {
    fs.symlinkSync(page, path.join(dir, "link.png"));
    const r = await _imageSize(path.join(dir, "link.png"));
    expect(r.success).toBe(false);
  });

  it("pastes images in rows of the given width, each centered in the largest cell", async () => {
    const small = path.join(dir, "small.png");
    writePng(small, 50, 40, "(50, 50, 200)");
    const out = path.join(dir, "sheet.png");
    const r = await _pasteImages([page, small, small], out, 2);
    expect(r.success && r.value).toBe(out);
    // Cells are 200 by 100; three images in rows of two is two rows.
    expect((await _imageSize(out)).value).toEqual({ width: 400, height: 200 });
  });
});
