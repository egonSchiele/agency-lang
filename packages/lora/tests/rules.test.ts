import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { serverRulesDir } from "agency-lang/stdlib-lib/localPython.js";

// The trainer's rules module imports no torch, so plain python3 runs it.
// The image server's rules module, which holds family_of, is on the path
// too, as the trainer puts it there.
const trainerDir = path.resolve(import.meta.dirname, "..", "trainer");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

function rules(code: string): string {
  const run = spawnSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2]); from rules import *\n${code}`,
      trainerDir,
      serverRulesDir(),
    ],
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return run.stdout.toString().trim();
}

describe.skipIf(!hasPython3)("trainer/rules.py", () => {
  it("prepends the trigger to each caption, and uses it alone without a sidecar", () => {
    const out = rules(`
import os, tempfile
d = tempfile.mkdtemp()
open(os.path.join(d, "b.jpg"), "wb").close()
open(os.path.join(d, "a.png"), "wb").close()
open(os.path.join(d, "a.txt"), "w").write("cat, sitting\\n")
open(os.path.join(d, "notes.md"), "w").write("x")
for path, caption in read_captions(d, "sketch"):
    print(os.path.basename(path), "|", caption)
`);
    expect(out.split("\n")).toEqual(["a.png | sketch, cat, sitting", "b.jpg | sketch"]);
  });

  it("refuses a folder with no images", () => {
    expect(
      rules(`
import tempfile
try:
    read_captions(tempfile.mkdtemp(), "t")
except ArgumentError as e:
    print("refused")
`),
    ).toBe("refused");
  });

  it("refuses a linked image, a linked caption, and a linked folder", () => {
    const out = rules(`
import os, tempfile
outside = tempfile.mkdtemp()
open(os.path.join(outside, "private.png"), "wb").close()
open(os.path.join(outside, "private.txt"), "w").write("secret")
def attempt(setup):
    d = tempfile.mkdtemp()
    open(os.path.join(d, "a.png"), "wb").close()
    target = setup(d)
    try:
        read_captions(target, "t")
        print("read")
    except ArgumentError as e:
        print("refused" if "is a symlink" in str(e) else e)
attempt(lambda d: (os.symlink(os.path.join(outside, "private.png"), os.path.join(d, "b.png")), d)[1])
attempt(lambda d: (os.symlink(os.path.join(outside, "private.txt"), os.path.join(d, "a.txt")), d)[1])
def linked_folder(d):
    link = os.path.join(tempfile.mkdtemp(), "images")
    os.symlink(d, link)
    return link
attempt(linked_folder)
`);
    expect(out.split("\n")).toEqual(["refused", "refused", "refused"]);
  });

  it("refuses a linked adapter, partial file, or samples folder", () => {
    const out = rules(`
import os, tempfile, types
outside = tempfile.mkdtemp()
for name in ["x.safetensors", "x.safetensors.partial", "x-samples"]:
    d = tempfile.mkdtemp()
    os.symlink(outside, os.path.join(d, name))
    args = types.SimpleNamespace(steps=10, rank=4, lr=1e-4, resolution=512, sample_every=0,
        out=os.path.join(d, "x.safetensors"), trigger="t", sample_prompts=[])
    try:
        check_args(args)
        print("ok")
    except ArgumentError as e:
        print("refused" if ("is a symlink" in str(e) or "already exists" in str(e)) else e)
`);
    expect(out.split("\n")).toEqual(["refused", "refused", "refused"]);
  });

  it("loads only an SDXL base model that the image server's family table allows", () => {
    const out = rules(`
import json, os, tempfile
from diffusersImageRules import FAMILIES, family_of
sdxl = FAMILIES["StableDiffusionXLPipeline"]
good = {"_class_name": "StableDiffusionXLPipeline", **sdxl["settings"]}
# Each component lists the [library, class] pairs it allows; the first will do.
good.update({k: v[0] for k, v in sdxl["components"].items()})
chroma = {"_class_name": "ChromaPipeline", **{k: v[0] for k, v in FAMILIES["ChromaPipeline"]["components"].items()}}
evil = {**good, "unet": ["os", "system"]}
def attempt(index):
    d = tempfile.mkdtemp()
    if index is not None:
        json.dump(index, open(os.path.join(d, "model_index.json"), "w"))
    try:
        print(check_base_model(d, family_of)["label"])
    except ArgumentError as e:
        print(str(e).replace(d, "<dir>"))
attempt(good)
attempt(chroma)
attempt(evil)
attempt(None)
`);
    expect(out.split("\n")).toEqual([
      "SDXL",
      "The trainer trains SDXL models. <dir> is Chroma.",
      expect.stringMatching(/^SDXL's "unet" must be/),
      "<dir> is not a diffusers model directory (no model_index.json).",
    ]);
  });

  it("refuses arguments outside their bounds, naming the bound", () => {
    const out = rules(`
import os, tempfile, types
d = tempfile.mkdtemp()
base = dict(steps=1000, rank=16, lr=1e-4, resolution=1024, sample_every=250, out=os.path.join(d, "x.safetensors"), trigger="t", sample_prompts=[])
check_args(types.SimpleNamespace(**base)); print("ok")
for bad in [dict(steps=0), dict(rank=300), dict(lr=0.5), dict(resolution=1000), dict(out=os.path.join(d, "x.bin")), dict(trigger=" "), dict(sample_prompts=["a", 1]), dict(out=os.path.join(d, "missing", "x.safetensors"))]:
    try:
        check_args(types.SimpleNamespace(**{**base, **bad}))
    except ArgumentError as e:
        print(e)
`);
    expect(out.split("\n")).toEqual([
      "ok",
      "steps must be from 1 to 20000. Got 0.",
      "rank must be from 1 to 256. Got 300.",
      "learning rate must be above 0 and at most 0.01. Got 0.5.",
      "resolution must be a multiple of 64 from 256 to 2048. Got 1000.",
      expect.stringMatching(/out must end in \.safetensors/),
      "trigger must not be empty.",
      "sample prompts must be a list of strings.",
      expect.stringMatching(/The folder for .* does not exist\./),
    ]);
  });

  it("keeps the hidden settings in one place", () => {
    expect(rules("print(sorted(SETTINGS))")).toBe(
      "['alpha_equals_rank', 'batch_size', 'grad_clip', 'lora_targets', 'sample_guidance', 'sample_steps', 'train_text_encoder', 'weight_decay']",
    );
  });
});
