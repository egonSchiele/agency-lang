import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { visionServerScript, ONNXRUNTIME_VERSION, TRANSFORMERS_VERSION } from "./localServe.js";
import { VISION_ARCHITECTURES, VISION_ONNX_FILES } from "../stdlib/modelKind.js";
import { MAX_IMAGE_BYTES, VISION_TASKS, visionBodyBytes } from "../stdlib/vision.js";
import { configuredPython } from "../stdlib/localPython.js";

const cliDir = path.dirname(visionServerScript());
const rulesModule = path.join(cliDir, "visionRules.py");

// Every test here calls into Python, so the whole block skips once when
// there is no python3, instead of each test guarding itself.
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

/** Runs `code` with the rules module importable, and returns stdout. */
function rules(code: string): string {
  const run = spawnSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, sys.argv[1]); from visionRules import *\n${code}`,
      cliDir,
    ],
    // No __pycache__ next to the source.
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return run.stdout.toString().trim();
}

/** The family label for a directory listing and config, or the refusal. */
function familyOf(names: string[], config: unknown): string {
  return rules(`
import json
try:
    print(family_of(json.loads(${JSON.stringify(JSON.stringify(names))}), json.loads(${JSON.stringify(JSON.stringify(config))}))["label"])
except ValueError as e:
    print("REFUSED", e)
`);
}

/** Runs check_request for a family and route and prints the result, or
 *  the error. The checked image is bytes, printed back as base64. */
function check(
  family: "wd14" | "Florence2ForConditionalGeneration" | "Dinov2Model" | "Owlv2ForObjectDetection",
  route: string,
  body: unknown,
): string {
  return rules(`
import base64, json
body = json.loads(${JSON.stringify(JSON.stringify(body))})
try:
    checked = check_request(FAMILIES["${family}"], "${route}", body)
    checked["image"] = base64.b64encode(checked["image"]).decode("ascii")
    print(json.dumps(checked, sort_keys=True))
except RequestError as e:
    print("ERROR", e.status, e)
`);
}

describe.skipIf(!hasPython3)("visionRules.py", () => {
  // A request carries the image's bytes as base64. Pillow decides later
  // whether they are an image, so any bytes pass the rules.
  const image = Buffer.from("not really a png").toString("base64");

  it("ships next to localServe", () => {
    expect(fs.existsSync(rulesModule)).toBe(true);
  });

  it("imports nothing from torch, transformers, or onnxruntime, so CI can run it", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).not.toMatch(/^\s*(import|from)\s+(torch|transformers|onnxruntime|PIL)/m);
  });

  it("knows the tagger by its two files and the others by their config", () => {
    expect(familyOf(["model.onnx", "selected_tags.csv", "config.json"], {})).toBe("WD14 tagger");
    expect(
      familyOf(["config.json"], { architectures: ["Florence2ForConditionalGeneration"] }),
    ).toBe("Florence-2");
    expect(familyOf(["config.json"], { architectures: ["Dinov2Model"] })).toBe("DINOv2");
    expect(familyOf(["config.json"], { architectures: ["Owlv2ForObjectDetection"] })).toBe("OWLv2");
  });

  it("refuses a directory that is neither", () => {
    expect(familyOf(["model.onnx"], null)).toBe(
      "REFUSED visionServer.py serves WD14 tagger, Florence-2, DINOv2, and OWLv2 models. This directory has none of model.onnx beside selected_tags.csv or a config.json naming Florence2ForConditionalGeneration, Dinov2Model, or Owlv2ForObjectDetection.",
    );
    expect(familyOf(["config.json"], { architectures: ["LlamaForCausalLM"] })).toContain("REFUSED");
  });

  it("agrees with modelKind.ts about what marks a vision model", () => {
    const architectures = rules(
      "import json; print(json.dumps(sorted(r['identify_architecture'] for r in FAMILIES.values() if 'identify_architecture' in r)))",
    );
    expect(JSON.parse(architectures)).toEqual([...VISION_ARCHITECTURES].sort());
    const files = rules(
      "import json; print(json.dumps(sorted([FAMILIES['wd14']['identify_file'], FAMILIES['wd14']['identify_beside']])))",
    );
    expect(JSON.parse(files)).toEqual([...VISION_ONNX_FILES].sort());
  });

  it("pins the same library versions as localServe.ts", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).toContain(`ONNXRUNTIME_VERSION = "${ONNXRUNTIME_VERSION}"`);
    expect(text).toContain(`TRANSFORMERS_VERSION = "${TRANSFORMERS_VERSION}"`);
  });

  it("fills in the defaults for each route", () => {
    expect(JSON.parse(check("wd14", "tags", { model: "m", image }))).toEqual({
      image,
      threshold: 0.35,
      limit: 30,
    });
    expect(
      JSON.parse(
        check("Florence2ForConditionalGeneration", "detections", {
          image,
          labels: ["person", " desk "],
        }),
      ),
    ).toEqual({ image, labels: ["person", "desk"], threshold: 0.3 });
    expect(JSON.parse(check("Florence2ForConditionalGeneration", "captions", { image }))).toEqual({
      image,
      detail: "short",
    });
  });

  it("serves exactly the routes the stdlib calls", () => {
    const served = JSON.parse(
      rules("import json; print(json.dumps(sorted(row['path'] for row in ROUTE_TABLE.values())))"),
    );
    const called = Object.values(VISION_TASKS).map((row) => `/v1${row.route}`);
    expect(served).toEqual([...called].sort());
  });

  it("has a checker for every field a route takes", () => {
    const out = rules(
      "print(sorted({f for row in ROUTE_TABLE.values() for f in row['fields']} - set(FIELD_CHECKS)))",
    );
    expect(out).toBe("[]");
  });

  it("gives every family that detects its own default threshold", () => {
    const out = rules(`
for family in FAMILIES.values():
    if "detections" in family["routes"]:
        value = family.get("default_threshold_detections")
        print(family["label"], isinstance(value, (int, float)) and not isinstance(value, bool))
`);
    expect(out.split("\n").every((line) => line.endsWith("True"))).toBe(true);
    expect(out).not.toBe("");
  });

  it("refuses a route the family does not answer, with 404 and the ones it does", () => {
    expect(check("wd14", "detections", { image, labels: ["x"] })).toBe(
      "ERROR 404 WD14 tagger does not answer /v1/vision/detections. It answers /v1/vision/tags.",
    );
  });

  it("refuses an image that is not base64, or is a path", () => {
    expect(check("wd14", "tags", {})).toBe("ERROR 400 image must be the image's bytes as base64.");
    expect(check("wd14", "tags", { image: "/Users/me/Pictures/passport.jpg" })).toBe(
      "ERROR 400 image is not valid base64.",
    );
    expect(check("wd14", "tags", { image: 42 })).toBe(
      "ERROR 400 image must be the image's bytes as base64.",
    );
  });

  it("refuses an image over the size limit without decoding it", () => {
    const out = rules(`
from localServerCommon import MAX_IMAGE_BYTES, base64_length, image_bytes_of, ImageDataError
try:
    image_bytes_of("A" * (base64_length(MAX_IMAGE_BYTES) + 4))
except ImageDataError as e:
    print(e)
`);
    expect(out).toBe("image is over 50,000,000 bytes; this server reads images up to that size.");
  });

  it("takes a body big enough for the largest image, and the same limit as the stdlib", () => {
    expect(rules("print(MAX_IMAGE_BYTES)")).toBe(String(MAX_IMAGE_BYTES));
    expect(Number(rules("print(MAX_BODY_BYTES - base64_length(MAX_IMAGE_BYTES))"))).toBe(64 * 1024);
    expect(Number(rules("print(MAX_BODY_BYTES)"))).toBe(visionBodyBytes());
  });

  it("refuses the labels a detector cannot use", () => {
    const f = "Florence2ForConditionalGeneration";
    expect(check(f, "detections", { image })).toBe(
      'ERROR 400 labels must be a list of the things to look for, such as ["person", "desk"]. A detector with no labels finds whatever it likes.',
    );
    expect(check(f, "detections", { image, labels: [] })).toContain("labels must be a list");
    expect(check(f, "detections", { image, labels: ["ok", ""] })).toBe(
      "ERROR 400 Each label must be a non-empty string of at most 64 characters. Got ''.",
    );
    expect(check(f, "detections", { image, labels: Array(51).fill("x") })).toBe(
      "ERROR 400 labels may hold at most 50 names. Got 51.",
    );
  });

  it("refuses a threshold, limit, or detail out of range", () => {
    expect(check("wd14", "tags", { image, threshold: 2 })).toBe(
      "ERROR 400 threshold must be a number from 0 to 1. The default is 0.35.",
    );
    expect(check("wd14", "tags", { image, threshold: true })).toContain("threshold must be");
    expect(check("wd14", "tags", { image, limit: 0 })).toBe(
      "ERROR 400 limit must be a whole number from 1 to 500. The default is 30.",
    );
    expect(check("Florence2ForConditionalGeneration", "captions", { image, detail: "huge" })).toBe(
      "ERROR 400 detail must be short or long. Got 'huge'.",
    );
  });

  it("refuses a field the route does not take, naming the ones it does", () => {
    expect(check("wd14", "tags", { image, labels: ["x"] })).toBe(
      "ERROR 400 labels is not a setting of /v1/vision/tags. It takes image, threshold, and limit.",
    );
  });

  it("fills in each family's defaults for the new routes", () => {
    const owl = "Owlv2ForObjectDetection";
    expect(JSON.parse(check(owl, "detections", { image, labels: ["cat"] })).threshold).toBe(0.1);
    expect(JSON.parse(check(owl, "regions", { image }))).toEqual({ image, limit: 50 });
    expect(JSON.parse(check("Florence2ForConditionalGeneration", "regions", { image })).limit).toBe(
      50,
    );
  });

  it("takes boxes to embed, with no boxes meaning the whole image and an empty list meaning none", () => {
    const whole = [{ x: 0, y: 0, width: 1, height: 1 }];
    expect(JSON.parse(check("Dinov2Model", "embeddings", { image })).boxes).toEqual(whole);
    expect(JSON.parse(check("Dinov2Model", "embeddings", { image, boxes: null })).boxes).toEqual(
      whole,
    );
    expect(JSON.parse(check("Dinov2Model", "embeddings", { image, boxes: [] })).boxes).toEqual([]);
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(JSON.parse(check("Dinov2Model", "embeddings", { image, boxes: [box] })).boxes).toEqual([
      box,
    ]);
  });

  it("refuses boxes that are not normalized boxes, naming the bad one", () => {
    const d = "Dinov2Model";
    const ok = { x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(check(d, "embeddings", { image, boxes: "all" })).toBe(
      "ERROR 400 boxes must be a list of {x, y, width, height} boxes in 0..1, or null for the whole image.",
    );
    expect(check(d, "embeddings", { image, boxes: Array(101).fill(ok) })).toBe(
      "ERROR 400 boxes may hold at most 100. Got 101.",
    );
    expect(check(d, "embeddings", { image, boxes: [ok, { x: 0, y: 0, width: 1 }] })).toBe(
      "ERROR 400 boxes[1] must be {x, y, width, height}.",
    );
    expect(check(d, "embeddings", { image, boxes: [{ ...ok, x: 1.5 }] })).toBe(
      "ERROR 400 boxes[0] must hold numbers from 0 to 1.",
    );
    expect(check(d, "embeddings", { image, boxes: [{ ...ok, width: 0 }] })).toBe(
      "ERROR 400 boxes[0] must have a width and a height above 0.",
    );
  });

  it("refuses a regions limit out of range", () => {
    expect(check("Owlv2ForObjectDetection", "regions", { image, limit: 101 })).toBe(
      "ERROR 400 limit must be a whole number from 1 to 100. The default is 50.",
    );
  });

  it("refuses embeddings on OWLv2, naming the routes it answers", () => {
    expect(check("Owlv2ForObjectDetection", "embeddings", { image })).toBe(
      "ERROR 404 OWLv2 does not answer /v1/vision/embeddings. It answers /v1/vision/detections and /v1/vision/regions.",
    );
  });

  it("keeps a model's boxes in score order, clamped to the image, above the threshold", () => {
    // A 200x100 image is padded to a 200x200 square, so its bottom half is
    // padding. Boxes are [x1, y1, x2, y2] in 0..1 of that square.
    const out = rules(`
import json
scores = [0.2, 0.9, 0.05, 0.5, 0.7]
boxes = [
    [0.0, 0.0, 0.5, 0.25],   # top-left, inside the image
    [0.5, 0.0, 1.0, 0.25],   # top-right, inside the image
    [0.0, 0.0, 1.0, 0.5],    # below the threshold
    [0.0, 0.25, 0.5, 0.75],  # crosses into the padding
    [0.0, 0.6, 0.5, 0.9],    # wholly in the padding
]
print(json.dumps(kept_boxes(scores, boxes, 200, 100, 0.1, KEEP_OVERLAPS, 10)))
`);
    expect(JSON.parse(out)).toEqual([
      { index: 1, score: 0.9, box: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
      { index: 3, score: 0.5, box: { x: 0, y: 0.5, width: 0.5, height: 0.5 } },
      { index: 0, score: 0.2, box: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    ]);
  });

  it("merges overlapping boxes only when asked, and stops at the limit", () => {
    const out = rules(`
import json
scores = [0.9, 0.8, 0.7]
boxes = [[0.0, 0.0, 0.5, 0.5], [0.0, 0.0, 0.5, 0.45], [0.6, 0.6, 0.9, 0.9]]
def indexes(iou, limit):
    return [found["index"] for found in kept_boxes(scores, boxes, 100, 100, 0.0, iou, limit)]
print(json.dumps([indexes(MERGE_IOU, 10), indexes(KEEP_OVERLAPS, 10), indexes(KEEP_OVERLAPS, 2)]))
`);
    expect(JSON.parse(out)).toEqual([
      [0, 2],
      [0, 1, 2],
      [0, 1],
    ]);
  });

  it("pads a crop to a centered square", () => {
    expect(rules("print(square_padding(300, 100))")).toBe("(300, (0, 100))");
    expect(rules("print(square_padding(100, 300))")).toBe("(300, (100, 0))");
  });

  it("turns a normalized box into pixels, refusing one under a pixel", () => {
    expect(
      rules("print(box_pixels({'x': 0.1, 'y': 0.2, 'width': 0.5, 'height': 0.5}, 100, 50, 0))"),
    ).toBe("(10, 10, 60, 35)");
    const out = rules(`
try:
    box_pixels({"x": 0.1, "y": 0.1, "width": 0.001, "height": 0.5}, 100, 100, 3)
except RequestError as e:
    print(e)
`);
    expect(out).toBe("boxes[3] covers less than a pixel of the 100x100 image.");
  });

  it("normalizes a pixel box to the top-left 0..1 shape, clamped", () => {
    expect(
      JSON.parse(
        rules("import json; print(json.dumps(normalized_box([10, 20, 60, 120], 100, 200)))"),
      ),
    ).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.5,
    });
    expect(
      JSON.parse(
        rules("import json; print(json.dumps(normalized_box([-10, 0, 300, 50], 100, 200)))"),
      ),
    ).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 0.25,
    });
  });

  it("builds a warm-up request on the family's first route that passes its own checks", () => {
    const out = rules(`
import base64, json
for family in FAMILIES.values():
    route, body = warm_up_request(family, ${JSON.stringify(image)})
    checked = check_request(family, route, body)
    checked["image"] = base64.b64encode(checked["image"]).decode("ascii")
    print(route, json.dumps(checked, sort_keys=True))
`);
    expect(out.split("\n")).toEqual([
      `tags {"image": "${image}", "limit": 30, "threshold": 0.35}`,
      `detections {"image": "${image}", "labels": ["square"], "threshold": 0.3}`,
      `embeddings {"boxes": [{"height": 1, "width": 1, "x": 0, "y": 0}], "image": "${image}"}`,
      `detections {"image": "${image}", "labels": ["square"], "threshold": 0.1}`,
    ]);
  });
});

describe.skipIf(!hasPython3)("visionServer.py and imageTools.py", () => {
  it("runs Florence-2 detection once per label and labels each box with the label asked for", () => {
    // The runner is built without loading a model; only its _run is faked.
    const out = rules(`
import json
import visionServer
runner = visionServer.Florence2Runner.__new__(visionServer.Florence2Runner)
runner.rules = FAMILIES["Florence2ForConditionalGeneration"]
asked = []
def fake_run(image, task, text=""):
    asked.append(task + text)
    return {"bboxes": [[0, 0, 50, 50]], "bboxes_labels": ["whatever the model wrote"]}
runner._run = fake_run
class FakeImage:
    size = (100, 100)
print(json.dumps(asked + [d["label"] for d in runner.detections_of(FakeImage(), {"labels": ["person", "desk"]})["detections"]]))
`);
    expect(JSON.parse(out)).toEqual([
      "<OPEN_VOCABULARY_DETECTION>person",
      "<OPEN_VOCABULARY_DETECTION>desk",
      "person",
      "desk",
    ]);
  });

  it("labels each OWLv2 box with its best label, and keeps overlapping boxes", () => {
    // The runner is built without loading a model; only its torch method is faked.
    const out = rules(`
import json
import visionServer
runner = visionServer.Owlv2Runner.__new__(visionServer.Owlv2Runner)
def fake_label_scores(image, labels):
    boxes = [[0.0, 0.0, 0.5, 0.5], [0.0, 0.0, 0.5, 0.45], [0.6, 0.6, 0.9, 0.9]]
    return [0.9, 0.8, 0.05], boxes, [1, 0, 0]
runner._label_scores = fake_label_scores
class FakeImage:
    size = (100, 100)
found = runner.detections_of(FakeImage(), {"labels": ["cat", "remote"], "threshold": 0.1})["detections"]
print(json.dumps([(d["label"], d["score"]) for d in found]))
`);
    expect(JSON.parse(out)).toEqual([
      ["remote", 0.9],
      ["cat", 0.8],
    ]);
  });

  it("gives OWLv2 regions in score order, merged, and at most the limit", () => {
    const out = rules(`
import json
import visionServer
runner = visionServer.Owlv2Runner.__new__(visionServer.Owlv2Runner)
def fake_objectness(image):
    boxes = [[0.0, 0.0, 0.5, 0.5], [0.0, 0.0, 0.5, 0.45], [0.6, 0.6, 0.9, 0.9], [0.1, 0.6, 0.3, 0.9]]
    return [0.9, 0.8, 0.5, 0.4], boxes
runner._objectness = fake_objectness
class FakeImage:
    size = (100, 100)
print(json.dumps([r["score"] for r in runner.regions_of(FakeImage(), {"limit": 2})["regions"]]))
`);
    // The second box overlaps the first, so it is merged away.
    expect(JSON.parse(out)).toEqual([0.9, 0.5]);
  });

  it("asks Florence-2 for region proposals, each scoring 1, at most the limit", () => {
    const out = rules(`
import json
import visionServer
runner = visionServer.Florence2Runner.__new__(visionServer.Florence2Runner)
runner.rules = FAMILIES["Florence2ForConditionalGeneration"]
asked = []
def fake_run(image, task, text=""):
    asked.append(task)
    return {"bboxes": [[0, 0, 50, 50], [50, 50, 100, 100], [10, 10, 20, 20]], "labels": ["", "", ""]}
runner._run = fake_run
class FakeImage:
    size = (100, 100)
regions = runner.regions_of(FakeImage(), {"limit": 2})["regions"]
print(json.dumps([asked, regions]))
`);
    expect(JSON.parse(out)).toEqual([
      ["<REGION_PROPOSAL>"],
      [
        { score: 1, box: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        { score: 1, box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
      ],
    ]);
  });

  it("ship next to localServe and are valid Python 3", () => {
    for (const script of ["visionServer.py", "imageTools.py"]) {
      const file = path.join(cliDir, script);
      expect(fs.existsSync(file)).toBe(true);
      const run = spawnSync(
        "python3",
        ["-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", file],
        { stdio: "pipe" },
      );
      expect(run.stderr.toString()).toBe("");
      expect(run.status).toBe(0);
    }
  });
});

// These run the server's Pillow code, so they need a Python with Pillow:
// the one `agency local serve` uses. Without it the block skips, as the
// imageTools tests do. The model itself is never loaded; its torch method
// is faked.
const pillowPython = configuredPython();
const hasPillow = spawnSync(pillowPython, ["-c", "import PIL"], { stdio: "ignore" }).status === 0;

/** Runs `code` with visionServer importable, in the Pillow Python. */
function server(code: string): string {
  const run = spawnSync(
    pillowPython,
    ["-c", `import sys; sys.path.insert(0, sys.argv[1]); import visionServer\n${code}`, cliDir],
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return run.stdout.toString().trim();
}

describe.skipIf(!hasPillow)("visionServer.py's Pillow code", () => {
  it("embeds the whole image, each box, or nothing, each as a padded square", () => {
    const out = server(`
import json
from PIL import Image
from visionRules import WHOLE_IMAGE
runner = visionServer.Dinov2Runner.__new__(visionServer.Dinov2Runner)
runner.padding = (124, 116, 104)
given = []
def fake_embed(crops):
    given.append([crop.size for crop in crops])
    return [[1.0] for _ in crops]
runner._embed = fake_embed
image = Image.new("RGB", (300, 100), (255, 255, 255))
half = {"x": 0, "y": 0, "width": 0.5, "height": 1}
runner.embeddings_of(image, {"boxes": [WHOLE_IMAGE]})
runner.embeddings_of(image, {"boxes": [half, WHOLE_IMAGE]})
print(json.dumps([given, runner.embeddings_of(image, {"boxes": []})]))
`);
    expect(JSON.parse(out)).toEqual([
      [
        [[300, 300]],
        [
          [150, 150],
          [300, 300],
        ],
        [],
      ],
      { embeddings: [] },
    ]);
  });

  it("centers a crop on a square of the padding color", () => {
    const out = server(`
from PIL import Image
square = visionServer.padded_square(Image.new("RGB", (300, 100), (255, 0, 0)), (124, 116, 104))
print(square.size, square.getpixel((0, 0)), square.getpixel((150, 150)), square.getpixel((0, 100)))
`);
    expect(out).toBe("(300, 300) (124, 116, 104) (255, 0, 0) (255, 0, 0)");
  });
});
