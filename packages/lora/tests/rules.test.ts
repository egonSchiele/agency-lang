import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// The trainer's rules module imports no torch, so plain python3 runs it.
const trainerDir = path.resolve(import.meta.dirname, "..", "trainer");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

function rules(code: string): string {
  const run = spawnSync(
    "python3",
    ["-c", `import sys; sys.path.insert(0, sys.argv[1]); from rules import *\n${code}`, trainerDir],
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

  it("estimates from the steps, the pixels, the images, and the sample rounds", () => {
    // 1000 steps at 1024: 800 s. 56 images flipped: 168 s to cache. Two
    // prompts at 250 steps: 5 rounds, 2 images each, 10 s each: 200 s.
    expect(rules("print(estimate_minutes(56, 1000, 1024, True, ['a', 'b'], 250))")).toBe("19.5");
    // No prompts, no flip, at 512: a quarter of the step cost.
    expect(rules("print(estimate_minutes(10, 1000, 512, False, [], 0))")).toBe("3.6");
  });

  it("refuses arguments outside their bounds, naming the bound", () => {
    const out = rules(`
import os, tempfile, types
d = tempfile.mkdtemp()
base = dict(steps=1000, rank=16, lr=1e-4, resolution=1024, sample_every=250, out=os.path.join(d, "x.safetensors"), trigger="t")
check_args(types.SimpleNamespace(**base)); print("ok")
for bad in [dict(steps=0), dict(rank=300), dict(lr=0.5), dict(resolution=1000), dict(out=os.path.join(d, "x.bin")), dict(trigger=" "), dict(out=os.path.join(d, "missing", "x.safetensors"))]:
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
      expect.stringMatching(/The folder for .* does not exist\./),
    ]);
  });

  it("keeps the hidden settings in one place", () => {
    expect(rules("print(sorted(SETTINGS))")).toBe(
      "['alpha_equals_rank', 'batch_size', 'grad_clip', 'lora_targets', 'sample_guidance', 'sample_steps', 'train_text_encoder', 'weight_decay']",
    );
  });
});
