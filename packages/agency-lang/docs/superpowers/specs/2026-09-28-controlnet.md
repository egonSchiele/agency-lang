# ControlNet on the local image server

An addendum to `2026-09-28-local-models-dx.md`. A ControlNet is an
inference-time input, not training: it is loaded like a LoRA adapter and
constrains one generation. So it lives in the core image server, beside
LoRA loading, and not in the training package.

## What this adds

1. A `controlnets` folder, `client.controlnetsDir`, next to
   `client.adaptersDir`. Each entry is a directory holding a diffusers
   ControlNet (`config.json` plus `diffusion_pytorch_model.safetensors`),
   named by the directory name.
2. Two request fields on `/v1/images/generations`: `controlnet`, a name
   in that folder, and `controlImage`, the path of an image to condition
   on; and `controlScale`, 0 to 2, how strongly.
3. The same three named arguments on `generateImageLocal`.
4. A family flag, `takes_controlnet`, on SDXL only, and a second
   pipeline class for the family: `StableDiffusionXLControlNetPipeline`
   when a request names a ControlNet, the plain pipeline otherwise. Both
   are built once from the same components and share the weights.

## The request

    generateImageLocal(
      "pen and ink, zxq_girl, surprised",
      "noobai-xl",
      lora: "zxq",
      controlnet: "scribble",
      controlImage: "./poses/jump.png",
      controlScale: 0.8,
    )

`controlImage` is a path, read by the server the way the vision server
reads an image: absolute, a regular file, no symlink, once through a
descriptor. It is the one file a generation request may name, and it
becomes a second field in the interrupt `generateImageLocal` does not
raise today. That is the change with the most weight: today a local
generation raises nothing because it reads nothing. With a control
image it reads one file the caller named, so the call raises
`std::readImage` for that file, with the real spelling in the payload,
before the request is sent. A call with no `controlImage` raises
nothing, as now.

`controlnet` and `controlImage` go together: one without the other is
refused with a message saying so. `controlScale` without `controlnet` is
refused like `lora_scale` without `lora`.

## The models

Catalogued as their own kind? No. A ControlNet is not served; it is
loaded by an image process from the folder. So it is downloaded with
`agency local download controlnet:<repo>` into the folder, recorded
with `kind: "controlnet"` so `list` shows it under the image model it
belongs to, and never planned by `serve`. Two rows to start, both for
SDXL:

| Name | Repo | Conditions on |
|---|---|---|
| `scribble` | `xinsir/controlnet-scribble-sdxl-1.0` | a rough line drawing, which is the stick-figure case |
| `openpose` | `xinsir/controlnet-openpose-sdxl-1.0` | a rendered pose skeleton |

Both are apache-2.0. The `openpose` row is only useful with something
that renders skeletons; drawing one by hand is possible and a pose
estimator is the vision spec's "later".

## Preprocessing

A ControlNet wants its conditioning image in a particular form: scribble
wants black lines on white at the generation's size, openpose wants the
skeleton rendering. The server resizes the control image to the request's
size and inverts a white-on-black scribble to black-on-white, and does
nothing else. Edge detection, depth, and pose extraction are what the
vision server is for, and are not folded in here.

## Tests

The rules module: the field pairing, the scale range, the family flag,
the path rules on `controlImage`. The provider: the three fields sent
only when set. `generateImageLocal`: the effect raised only with a
control image, with the real spelling. Live: one scribble generation
against NoobAI-XL in the opt-in image test.
