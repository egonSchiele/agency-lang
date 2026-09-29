import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { visionServerScript, ONNXRUNTIME_VERSION, TRANSFORMERS_VERSION } from "./localServe.js";
import { VISION_ARCHITECTURES, VISION_ONNX_FILES } from "../stdlib/modelKind.js";

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
 *  the error. */
function check(
  family: "wd14" | "Florence2ForConditionalGeneration",
  route: string,
  body: unknown,
): string {
  return rules(`
import json
body = json.loads(${JSON.stringify(JSON.stringify(body))})
try:
    print(json.dumps(check_request(FAMILIES["${family}"], "${route}", body), sort_keys=True))
except RequestError as e:
    print("ERROR", e.status, e)
`);
}

describe.skipIf(!hasPython3)("visionRules.py", () => {
  let dir: string;
  let image: string;

  beforeAll(() => {
    // realpath, because the server refuses a path through a symlink and
    // macOS's temp directory is one. The stdlib sends real paths.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vision-")));
    image = path.join(dir, "page.png");
    fs.writeFileSync(image, "not really a png");
  });

  afterAll(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  it("ships next to localServe", () => {
    expect(fs.existsSync(rulesModule)).toBe(true);
  });

  it("imports nothing from torch, transformers, or onnxruntime, so CI can run it", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).not.toMatch(/^\s*(import|from)\s+(torch|transformers|onnxruntime|PIL)/m);
  });

  it("knows the tagger by its two files and Florence-2 by its config", () => {
    expect(familyOf(["model.onnx", "selected_tags.csv", "config.json"], {})).toBe("WD14 tagger");
    expect(
      familyOf(["config.json"], { architectures: ["Florence2ForConditionalGeneration"] }),
    ).toBe("Florence-2");
  });

  it("refuses a directory that is neither", () => {
    expect(familyOf(["model.onnx"], null)).toBe(
      "REFUSED visionServer.py serves WD14 tagger and Florence-2 models. This directory has neither model.onnx beside selected_tags.csv nor a config.json naming Florence2ForConditionalGeneration.",
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

  it("refuses a route the family does not answer, with 404 and the ones it does", () => {
    expect(check("wd14", "detections", { image, labels: ["x"] })).toBe(
      "ERROR 404 WD14 tagger does not answer /v1/vision/detections. It answers /v1/vision/tags.",
    );
  });

  it("refuses an image that is not an absolute path to a regular image file", () => {
    expect(check("wd14", "tags", { image: "page.png" })).toBe(
      "ERROR 400 image must be an absolute path. Got 'page.png'.",
    );
    expect(check("wd14", "tags", { image: path.join(dir, "missing.png") })).toBe(
      `ERROR 400 ${path.join(dir, "missing.png")} is not a file.`,
    );
    expect(check("wd14", "tags", { image: dir })).toBe(`ERROR 400 ${dir} is not a file.`);
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    expect(check("wd14", "tags", { image: path.join(dir, "notes.txt") })).toBe(
      `ERROR 400 ${path.join(dir, "notes.txt")} is not an image this server reads. It reads .png, .jpg, .jpeg, .webp, .gif.`,
    );
    expect(check("wd14", "tags", {})).toBe(
      "ERROR 400 image must be the absolute path of an image file.",
    );
  });

  it("refuses an image reached through a symlink, at the file or above it", () => {
    fs.symlinkSync(image, path.join(dir, "link.png"));
    expect(check("wd14", "tags", { image: path.join(dir, "link.png") })).toBe(
      `ERROR 400 ${path.join(dir, "link.png")} goes through a symlink at ${path.join(dir, "link.png")}, which this server does not follow.`,
    );
    fs.mkdirSync(path.join(dir, "real"));
    fs.writeFileSync(path.join(dir, "real", "a.png"), "x");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linked"));
    expect(check("wd14", "tags", { image: path.join(dir, "linked", "a.png") })).toBe(
      `ERROR 400 ${path.join(dir, "linked", "a.png")} goes through a symlink at ${path.join(dir, "linked")}, which this server does not follow.`,
    );
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
import json
for family in FAMILIES.values():
    route, body = warm_up_request(family, ${JSON.stringify(image)})
    print(route, json.dumps(check_request(family, route, body), sort_keys=True))
`);
    expect(out.split("\n")).toEqual([
      `tags {"image": "${image}", "limit": 30, "threshold": 0.35}`,
      `detections {"image": "${image}", "labels": ["square"], "threshold": 0.3}`,
    ]);
  });
});

describe.skipIf(!hasPython3)("visionServer.py and imageTools.py", () => {
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
