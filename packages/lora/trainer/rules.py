"""The parts of the trainer that need no torch: the fixed settings, the
argument checks, the caption reading, and the time estimate. The trainer
imports these; a test runs them with plain python3.
"""

import os

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
ADAPTER_EXTENSION = ".safetensors"

# The settings a person judging sample grids never changes, fixed at the
# values the first runs used. Each is one line to change for someone who
# has read docs/superpowers/specs/2026-09-28-lora-package.md, and not a
# parameter for someone who has not.
SETTINGS = {
    # alpha equals rank, so the adapter's scale is 1 and lora_scale on the
    # server means what it says.
    "alpha_equals_rank": True,
    # One image a step. Larger batches need the learning rate retuned and
    # gain little on one GPU with cached latents.
    "batch_size": 1,
    # AdamW, as every SDXL trainer uses. Neither changes what a grid shows.
    "weight_decay": 0.01,
    "grad_clip": 1.0,
    # The four attention projections, in self- and cross-attention. Adding
    # the feed-forward layers is "LoRA on the whole UNet" and mostly adds
    # size.
    "lora_targets": ("to_q", "to_k", "to_v", "to_out.0"),
    # The text encoder stays frozen. Training it makes a trigger word
    # stronger at the cost of the base model's vocabulary drifting.
    "train_text_encoder": False,
    # The prompt guidance and step count of the sample grids.
    "sample_guidance": 5.5,
    "sample_steps": 28,
}

# The bounds a person can set, wide enough for any real run and narrow
# enough to catch a typo.
MAX_STEPS = 20000
MAX_RANK = 256
MIN_RESOLUTION = 256
MAX_RESOLUTION = 2048
RESOLUTION_MULTIPLE = 64

# The measured rate on an M5 Ultra at 1024x1024: about 0.8 s a step, with
# the cost growing with the pixel count. The estimate is for the person
# approving the run, not a promise.
SECONDS_PER_STEP_AT_1024 = 0.8
SECONDS_PER_SAMPLE_IMAGE = 10.0
SECONDS_TO_CACHE_PER_IMAGE = 1.5


class ArgumentError(ValueError):
    """An argument the trainer refuses. The message says what it takes."""


def check_args(args):
    """Checks the numbers and the output path. Raises ArgumentError."""
    if not (1 <= args.steps <= MAX_STEPS):
        raise ArgumentError(f"steps must be from 1 to {MAX_STEPS}. Got {args.steps}.")
    if not (1 <= args.rank <= MAX_RANK):
        raise ArgumentError(f"rank must be from 1 to {MAX_RANK}. Got {args.rank}.")
    if not (0 < args.lr <= 0.01):
        raise ArgumentError(f"learning rate must be above 0 and at most 0.01. Got {args.lr}.")
    if (
        not (MIN_RESOLUTION <= args.resolution <= MAX_RESOLUTION)
        or args.resolution % RESOLUTION_MULTIPLE != 0
    ):
        raise ArgumentError(
            f"resolution must be a multiple of {RESOLUTION_MULTIPLE} from {MIN_RESOLUTION} to "
            f"{MAX_RESOLUTION}. Got {args.resolution}."
        )
    if args.sample_every < 0:
        raise ArgumentError(f"sample_every must be 0 or more. Got {args.sample_every}.")
    if not args.out.endswith(ADAPTER_EXTENSION):
        raise ArgumentError(f"out must end in {ADAPTER_EXTENSION}. Got {args.out}.")
    if os.path.exists(args.out):
        raise ArgumentError(f"{args.out} already exists. Remove it first, or write elsewhere.")
    if not os.path.isdir(os.path.dirname(os.path.abspath(args.out))):
        raise ArgumentError(f"The folder for {args.out} does not exist.")
    if args.trigger.strip() == "":
        raise ArgumentError("trigger must not be empty.")


def read_captions(images_dir, trigger):
    """Every image in the folder with its caption: the trigger word, then
    the sidecar's tags when there is one. Sorted by name, so a run is
    repeatable."""
    items = []
    for name in sorted(os.listdir(images_dir)):
        if not name.lower().endswith(IMAGE_EXTENSIONS):
            continue
        sidecar = os.path.join(images_dir, os.path.splitext(name)[0] + ".txt")
        caption = ""
        if os.path.isfile(sidecar):
            with open(sidecar, encoding="utf-8") as f:
                caption = f.read().strip()
        full = trigger if caption == "" else f"{trigger}, {caption}"
        items.append((os.path.join(images_dir, name), full))
    if not items:
        raise ArgumentError(f"{images_dir} holds no images ({', '.join(IMAGE_EXTENSIONS)}).")
    return items


def estimate_minutes(images, steps, resolution, flip, sample_prompts, sample_every):
    """About how long the run takes on an M5 Ultra."""
    pixels = (resolution / 1024) ** 2
    training = steps * SECONDS_PER_STEP_AT_1024 * pixels
    caching = images * (2 if flip else 1) * SECONDS_TO_CACHE_PER_IMAGE
    rounds = 1 + (steps // sample_every if sample_every > 0 else 0)
    if sample_every > 0 and steps % sample_every != 0:
        rounds += 1
    samples = rounds * 2 * len(sample_prompts) * SECONDS_PER_SAMPLE_IMAGE * pixels
    return round((training + caching + samples) / 60, 1)
