# ControlNet on the image server: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-28-controlnet.md`. Needs the
DX plan's Task 7 (the adapters folder) merged; this follows the same
shape for a second folder.

**Goal:** A request to the local image server can name a ControlNet
from a configured folder and an image to condition on, and
`generateImageLocal` takes the same three arguments, raising
`std::readImage` for the control image.

**Architecture:** `client.controlnetsDir` beside `client.adaptersDir`,
passed to the image process as `--controlnets-dir`. The SDXL family row
grows `takes_controlnet` and a `controlnet_pipeline` class name. The
server builds the ControlNet pipeline from the loaded components on
first use and keeps both pipelines, sharing weights. The rules module
owns the field pairing and the path rule; `visionRules.py`'s
`check_image_path` moves to `localServerCommon.py` so both servers use
one.

## Constraints

- The control image is the only file a generation request may name,
  and it is read with the same checks the vision server makes. The
  shared function lives in `localServerCommon.py`, not copied.
- A generation without a control image raises nothing, as today.
- No preprocessing beyond resize and the scribble inversion the spec
  names.
- `pnpm run fmt:ts` before each commit; test output to a file.

## Task 1: Rules

**Files:** `lib/cli/diffusersImageRules.py`,
`lib/cli/localServerCommon.py`, `lib/cli/diffusersImageServer.test.ts`.

1. `FIELDS` gains `controlnet`, `control_image`, `control_scale`.
   `MAX_CONTROL_SCALE = 2.0`, `DEFAULT_CONTROL_SCALE = 1.0`.
2. SDXL's row: `"takes_controlnet": True`, `"controlnet_pipeline":
   "StableDiffusionXLControlNetPipeline"`. The other rows:
   `"takes_controlnet": False`.
3. `_controlnet_of(rules, body, controlnets_dir)`: none named, none
   returned, and `control_image` or `control_scale` alone refused with
   the pairing message; named without a folder, the "set
   client.controlnetsDir" message; a name checked by the same
   one-segment rule `adapter_path` uses (factor it to `folder_entry(dir,
   name, kind_word)` so both messages read the same); the image path
   through `check_image_path`; the scale in range. `check_request`
   returns `controlnet`, `control_image`, `control_scale`.
4. `check_image_path` moves from `visionRules.py` to
   `localServerCommon.py` with its tests moved to a shared
   `localServerCommon.test.ts`.
5. Tests: every refusal, the defaults, the SDXL-only flag against
   Chroma.
6. Commit: `ControlNet request rules`.

## Task 2: Server

**Files:** `lib/cli/diffusersImageServer.py`.

1. `--controlnets-dir`. `Generator.controlnet(name)` loads
   `ControlNetModel.from_pretrained(dir/name, use_safetensors=True,
   local_files_only=True)` on first use under the lock and keeps it in
   a dict; a missing directory or one without `config.json` and a
   `.safetensors` weight is a 400 naming the folder's entries.
2. `Generator.control_pipeline(controlnet)`: built once per ControlNet
   from the plain pipeline's components with
   `StableDiffusionXLControlNetPipeline(**self.pipe.components,
   controlnet=model)`, so the UNet and encoders are shared, and the
   adapter state set by `apply_lora` applies to both because the UNet
   is the same object.
3. `generate`: when the request names a ControlNet, read the control
   image with Pillow after `check_image_path` passed, resize it to the
   request's size, invert it when the family row's preprocessing says
   `scribble` and the image is mostly dark, and call the control
   pipeline with `image=` and `controlnet_conditioning_scale=`. Otherwise
   the plain pipeline as now.
4. `/health` lists the folder's ControlNet names beside the adapter
   names.
5. A syntax check in the test file; behavior in the live test.
6. Commit: `ControlNet on the image server`.

## Task 3: Config, serve, provider, stdlib

**Files:** `lib/config/config.ts`, `lib/cli/localServe.ts` and test,
`lib/stdlib/mlxImage.ts` (`SETTINGS`), `lib/stdlib/image.ts`,
`lib/stdlib/image.test.ts`, `stdlib/image.agency`.

1. `client.controlnetsDir`, resolved like `adaptersDir`, passed as
   `--controlnets-dir`.
2. `SETTINGS` gains the three fields.
3. `_generateImageLocal` takes `controlnet`, `controlImage`,
   `controlScale`. When `controlImage` is non-empty the Agency function
   resolves it with `_realTarget` and raises `std::readImage` with the
   real `dir` and `filename` before calling; the TypeScript side calls
   `_approvedFilePath` on the spelling and sends the resulting absolute
   path. Empty raises nothing and sends nothing.
4. Tests: the provider sends the three fields only when set; the
   stdlib refuses a ControlNet without an image before any request; the
   Agency test checks the effect fires with the real path only when an
   image is given.
5. Commit: `controlnet, controlImage, and controlScale on generateImageLocal`.

## Task 4: Download, catalog, docs

**Files:** `lib/stdlib/modelCatalog.ts`, `lib/stdlib/localModels.ts`,
`lib/cli/local.ts`, `docs/dev/llm/local-images.md`,
`docs/site/guide/using-local-models.md`, `docs/site/cli/local.md`.

1. `kind: "controlnet"` in `ModelKind`, with the rule "a `config.json`
   whose `_class_name` is `ControlNetModel`". `serve` refuses to plan
   one: "a ControlNet is loaded by an image model from
   client.controlnetsDir, not served".
2. `agency local download controlnet:<repo>` downloads into
   `client.controlnetsDir/<name>` when the folder is configured, else
   refuses with the config hint, keeping `config.json` and the
   `.safetensors` weight only. The two catalog rows from the spec.
3. `list` shows ControlNets in their own section.
4. Docs: a ControlNet section in `local-images.md` after the LoRA one,
   the guide's posing example, the CLI table line.
5. Commit: `ControlNet download and docs`.

## Task 5: Live

**Files:** `lib/cli/diffusersImageServer.live.test.ts`.

1. Gated on `AGENCY_CONTROLNET_DIR` in addition to the existing
   variables: one scribble generation from a fixture stick figure,
   expecting an image back and a different image than the same seed
   without the ControlNet.
2. Timing in `local-images.md`.
3. Commit: `ControlNet live test`.
