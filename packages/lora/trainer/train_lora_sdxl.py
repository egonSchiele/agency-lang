"""A small LoRA trainer for SDXL-family models (Illustrious, NoobAI, base SDXL).

Everything runs locally. HF_HUB_OFFLINE is forced on before torch is
imported, so nothing here can open a network connection: the model
directory must already be on disk.

  python train_lora_sdxl.py --model=<diffusers dir> --images=<dir> --trigger="pen and ink" \\
      --out=./adapters/sketch.safetensors --rules-dir=<dir> --steps=1000 [--flip] \\
      [--sample-prompts-json='["pen and ink, a cat"]']

Every value is passed in the `--name=value` form, and the sample prompts
as one JSON array, so no value can be read as a flag: a prompt of
"--out /elsewhere" stays a prompt. `--rules-dir` is the folder holding
the image server's diffusersImageRules.py, whose family table decides
which base models may be loaded.

The images directory holds png/jpg files. A file may have a sidecar
caption, `foo.txt` next to `foo.png`, with comma-separated booru-style
tags. The trigger word is prepended to every caption.

Progress goes to stdout as one JSON object a line, so the caller that
started this process can read it without parsing prose:

  {"event": "start", "images": 56}
  {"event": "cached", "images": 112}
  {"event": "step", "step": 20, "loss": 0.041, "secondsPerStep": 0.8}
  {"event": "sample", "path": ".../samples/step_0250.png"}
  {"event": "done", "path": ".../sketch.safetensors", "minutes": 13.6}

The adapter is written to <out>.partial and renamed at the end, so a
killed run leaves nothing that looks finished. The fixed settings are in
rules.py, with a comment each.
"""

import argparse
import json
import math
import os
import random
import sys
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rules import (  # noqa: E402
    SETTINGS,
    ArgumentError,
    check_args,
    check_base_model,
    open_no_follow,
    partial_path,
    read_captions,
    refuse_link,
    samples_dir,
)


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="diffusers model directory")
    p.add_argument("--images", required=True, help="directory of training images")
    p.add_argument("--trigger", required=True, help="trigger word prepended to captions")
    p.add_argument("--out", required=True, help="the .safetensors file to write")
    p.add_argument("--rules-dir", required=True, help="the folder holding diffusersImageRules.py")
    p.add_argument("--base-name", default="", help="how to name the base model in the adapter's metadata")
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--resolution", type=int, default=1024)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--sample-every", type=int, default=250)
    p.add_argument("--sample-prompts-json", default="[]", help="the sample prompts, as one JSON array")
    p.add_argument("--flip", action="store_true", help="also train on mirrored copies")
    args = p.parse_args(argv)
    try:
        args.sample_prompts = json.loads(args.sample_prompts_json)
    except ValueError:
        p.error("--sample-prompts-json must be a JSON array of strings")
    return args


def preflight(args):
    """Checks everything that can be checked without loading a model:
    the numbers, the paths, the base model against the image server's
    family table, the captions, and that torch and diffusers import.
    Returns the images with their captions."""
    try:
        check_args(args)
        sys.path.insert(0, os.path.abspath(args.rules_dir))
        from diffusersImageRules import family_of

        check_base_model(args.model, family_of)
        items = read_captions(args.images, args.trigger)
    except ArgumentError as err:
        fail(str(err))
    for module in ("torch", "diffusers", "safetensors"):
        try:
            __import__(module)
        except ImportError:
            fail(f"{sys.executable} cannot import {module}. Install the image server's packages first.")
    emit("start", images=len(items))
    return items


# ---------------------------------------------------------------- the model


class LoRALinear:
    """Built inside `train`, once torch is imported. See make_lora_class."""


def make_lora_class(torch, nn):
    class Layer(nn.Module):
        """A frozen Linear plus a trainable low-rank delta, B @ A, scaled by
        alpha/rank. `enabled` is a class-level switch so every layer can be
        turned off at once, which is how the "before" samples are rendered."""

        enabled = True

        def __init__(self, base, rank):
            super().__init__()
            self.base = base
            alpha = rank if SETTINGS["alpha_equals_rank"] else 1
            self.scale = alpha / rank
            self.lora_A = nn.Linear(base.in_features, rank, bias=False, dtype=torch.float32)
            self.lora_B = nn.Linear(rank, base.out_features, bias=False, dtype=torch.float32)
            nn.init.kaiming_uniform_(self.lora_A.weight, a=math.sqrt(5))
            nn.init.zeros_(self.lora_B.weight)

        def forward(self, x):
            y = self.base(x)
            if not Layer.enabled:
                return y
            delta = self.lora_B(self.lora_A(x.to(torch.float32))) * self.scale
            return y + delta.to(y.dtype)

    return Layer


def inject_lora(unet, Layer, rank):
    """Replace the attention projections with LoRA wrappers. Returns {key: layer}."""
    layers = {}
    for name, module in list(unet.named_modules()):
        if not name.endswith(("attn1", "attn2")):
            continue
        for target in SETTINGS["lora_targets"]:
            parent = module
            parts = target.split(".")
            for part in parts[:-1]:
                parent = getattr(parent, part)
            wrapped = Layer(getattr(parent, parts[-1]), rank)
            setattr(parent, parts[-1], wrapped)
            layers[f"{name}.{target}"] = wrapped
    return layers


def lora_state_dict(layers):
    """The adapter in the key format diffusers loads: unet.<module>.lora_A.weight."""
    out = {}
    for key, layer in layers.items():
        out[f"unet.{key}.lora_A.weight"] = layer.lora_A.weight.detach().cpu().contiguous()
        out[f"unet.{key}.lora_B.weight"] = layer.lora_B.weight.detach().cpu().contiguous()
    return out


# ---------------------------------------------------------------- data


def fit_square(Image, img, resolution):
    """Scale so the long side is `resolution`, then pad to a square with
    white. Padding rather than cropping keeps a wide drawing whole."""
    w, h = img.size
    scale = resolution / max(w, h)
    img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", (resolution, resolution), (255, 255, 255))
    canvas.paste(img, ((resolution - img.width) // 2, (resolution - img.height) // 2))
    return canvas


def render_samples(torch, Image, ImageDraw, Layer, pipe, prompts, seed, out_path, label):
    """One row per prompt: the "before" image (LoRA off) beside the "after"."""
    size, pad, label_h = 1024, 8, 28
    rows = []
    with torch.no_grad():
        for prompt in prompts:
            pair = []
            for enabled in (False, True):
                Layer.enabled = enabled
                g = torch.Generator(device="cpu").manual_seed(seed)
                img = pipe(
                    prompt=prompt,
                    num_inference_steps=SETTINGS["sample_steps"],
                    guidance_scale=SETTINGS["sample_guidance"],
                    width=size,
                    height=size,
                    generator=g,
                ).images[0]
                pair.append(img)
            Layer.enabled = True
            rows.append((prompt, pair))
    grid = Image.new("RGB", (size * 2 + pad * 3, (size + label_h + pad) * len(rows) + pad), (24, 24, 24))
    draw = ImageDraw.Draw(grid)
    y = pad
    for prompt, (before, after) in rows:
        draw.text((pad, y), f"before | {label} | {prompt[:120]}", fill=(230, 230, 230))
        draw.text((size + pad * 2, y), f"after ({label})", fill=(230, 230, 230))
        y += label_h
        grid.paste(before, (pad, y))
        grid.paste(after, (size + pad * 2, y))
        y += size + pad
    grid.save(out_path)
    emit("sample", path=out_path)


# ---------------------------------------------------------------- train


def train(args, items):
    import numpy as np
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from PIL import Image, ImageDraw
    from safetensors.torch import save_file
    from diffusers import DDPMScheduler, EulerDiscreteScheduler, StableDiffusionXLPipeline

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    samples = samples_dir(args.out)
    if args.sample_every > 0 and args.sample_prompts:
        refuse_link(samples)
        os.makedirs(samples, exist_ok=True)

    pipe = StableDiffusionXLPipeline.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, use_safetensors=True, local_files_only=True
    )
    # The SDXL VAE is not stable in half precision.
    pipe.vae.to(torch.float32)
    pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config)
    noise_scheduler = DDPMScheduler.from_config(pipe.scheduler.config)
    for m in (pipe.unet, pipe.vae, pipe.text_encoder, pipe.text_encoder_2):
        m.requires_grad_(False)

    # Cache every image's latent and every caption's embedding once. The
    # encoders never run again, which is why a step takes under a second.
    cache = []
    with torch.no_grad():
        for path, caption in items:
            with open_no_follow(path) as f:
                img = fit_square(Image, Image.open(f).convert("RGB"), args.resolution)
            variants = [img, img.transpose(Image.FLIP_LEFT_RIGHT)] if args.flip else [img]
            embeds, _, pooled, _ = pipe.encode_prompt(
                prompt=caption, device=device, num_images_per_prompt=1, do_classifier_free_guidance=False
            )
            for variant in variants:
                pixels = torch.from_numpy(np.array(variant)).float() / 127.5 - 1.0
                pixels = pixels.permute(2, 0, 1).unsqueeze(0).to(device, torch.float32)
                latent = pipe.vae.encode(pixels).latent_dist.sample() * pipe.vae.config.scaling_factor
                cache.append((latent.to(torch.bfloat16), embeds.to(torch.bfloat16), pooled.to(torch.bfloat16)))
    emit("cached", images=len(cache))

    Layer = make_lora_class(torch, nn)
    layers = inject_lora(pipe.unet, Layer, args.rank)
    pipe.unet.to(device)
    params = [p for layer in layers.values() for p in (layer.lora_A.weight, layer.lora_B.weight)]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=SETTINGS["weight_decay"])

    res = args.resolution
    time_ids = torch.tensor([[res, res, 0, 0, res, res]], device=device, dtype=torch.bfloat16)
    T = noise_scheduler.config.num_train_timesteps
    partial = partial_path(args.out)

    def save(step):
        refuse_link(partial)
        save_file(
            lora_state_dict(layers),
            partial,
            metadata={
                "trigger": args.trigger,
                "rank": str(args.rank),
                "step": str(step),
                "base": args.base_name or os.path.basename(os.path.normpath(args.model)),
            },
        )

    def maybe_sample(step, label):
        if args.sample_every > 0 and args.sample_prompts:
            refuse_link(samples)
            out_path = os.path.join(samples, f"step_{step:04d}.png")
            refuse_link(out_path)
            render_samples(torch, Image, ImageDraw, Layer, pipe, args.sample_prompts, args.seed, out_path, label)

    maybe_sample(0, "step 0")
    t0 = time.time()
    losses = []
    for step in range(1, args.steps + 1):
        latent, embeds, pooled = random.choice(cache)
        noise = torch.randn_like(latent)
        timesteps = torch.randint(0, T, (1,), device=device, dtype=torch.long)
        noisy = noise_scheduler.add_noise(latent, noise, timesteps)
        if noise_scheduler.config.prediction_type == "v_prediction":
            target = noise_scheduler.get_velocity(latent, noise, timesteps)
        else:
            target = noise
        pred = pipe.unet(
            noisy, timesteps, encoder_hidden_states=embeds,
            added_cond_kwargs={"text_embeds": pooled, "time_ids": time_ids},
        ).sample
        loss = F.mse_loss(pred.float(), target.float())
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, SETTINGS["grad_clip"])
        opt.step()
        opt.zero_grad(set_to_none=True)
        losses.append(loss.item())
        if step % 20 == 0 or step == 1:
            recent = losses[-20:]
            emit("step", step=step, loss=round(sum(recent) / len(recent), 4), secondsPerStep=round((time.time() - t0) / step, 2))
        if args.sample_every > 0 and step % args.sample_every == 0 and step != args.steps:
            maybe_sample(step, f"step {step}")
    maybe_sample(args.steps, f"step {args.steps}")
    save(args.steps)
    refuse_link(args.out)
    os.replace(partial, args.out)
    emit("done", path=os.path.abspath(args.out), minutes=round((time.time() - t0) / 60, 1))


def main():
    args = parse_args()
    items = preflight(args)
    try:
        train(args, items)
    except ArgumentError as err:
        fail(str(err))


if __name__ == "__main__":
    main()
