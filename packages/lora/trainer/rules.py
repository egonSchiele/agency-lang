"""The parts of the trainer that need no torch: the fixed settings, the
argument checks, the base model check, and the caption reading. The
trainer imports these; a test runs them with plain python3.

Nothing here follows a symlink the caller could have planted: an image,
a caption, the adapter's `.partial` file, and the samples folder are
each refused when they are links. The base model's directory is the
exception, because a Hugging Face cache snapshot is made of links into
its blob store; what that directory may load is decided by the image
server's family table instead.
"""

import json
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
    if os.path.lexists(args.out):
        raise ArgumentError(f"{args.out} already exists. Remove it first, or write elsewhere.")
    refuse_link(partial_path(args.out))
    refuse_link(samples_dir(args.out))
    if not os.path.isdir(os.path.dirname(os.path.abspath(args.out))):
        raise ArgumentError(f"The folder for {args.out} does not exist.")
    if args.trigger.strip() == "":
        raise ArgumentError("trigger must not be empty.")
    if not isinstance(args.sample_prompts, list) or not all(
        isinstance(prompt, str) for prompt in args.sample_prompts
    ):
        raise ArgumentError("sample prompts must be a list of strings.")


def partial_path(out):
    """Where the adapter is written until the run finishes."""
    return out + ".partial"


def samples_dir(out):
    """The folder beside the adapter that the sample grids go in."""
    stem = os.path.splitext(os.path.basename(out))[0]
    return os.path.join(os.path.dirname(os.path.abspath(out)), stem + "-samples")


def refuse_link(path):
    """Raises ArgumentError when `path` is a symlink. The approver named a
    folder, not wherever a link in it points."""
    if os.path.islink(path):
        raise ArgumentError(f"refused: {path} is a symlink. Symlinks are not followed.")


def open_no_follow(path):
    """Opens a file for reading in binary, refusing a symlink at the last
    component even if one appears after the folder was listed."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as err:
        if os.path.islink(path):
            raise ArgumentError(f"refused: {path} is a symlink. Symlinks are not followed.") from err
        raise
    return os.fdopen(fd, "rb")


def check_base_model(model_dir, family_of):
    """Refuses a base model that is not SDXL by the image server's family
    table. `from_pretrained` imports whatever library and class each
    component in model_index.json names, so the file is checked against
    the same rows the server allows before anything is loaded.
    `family_of` is the server's own check, from diffusersImageRules.py."""
    index_path = os.path.join(model_dir, "model_index.json")
    if not os.path.isfile(index_path):
        raise ArgumentError(f"{model_dir} is not a diffusers model directory (no model_index.json).")
    try:
        with open(index_path, encoding="utf-8") as f:
            model_index = json.load(f)
    except ValueError as err:
        raise ArgumentError(f"{index_path} is not JSON.") from err
    if not isinstance(model_index, dict):
        raise ArgumentError(f"{index_path} is not a JSON object.")
    try:
        rules = family_of(model_index)
    except ValueError as err:
        raise ArgumentError(str(err)) from err
    if rules["pipelines"]["plain"] != "StableDiffusionXLPipeline":
        raise ArgumentError(f"The trainer trains SDXL models. {model_dir} is {rules['label']}.")
    return rules


def read_captions(images_dir, trigger):
    """Every image in the folder with its caption: the trigger word, then
    the sidecar's tags when there is one. Sorted by name, so a run is
    repeatable. A link anywhere, the folder itself, an image, or a caption,
    refuses the run."""
    refuse_link(images_dir)
    items = []
    for name in sorted(os.listdir(images_dir)):
        if not name.lower().endswith(IMAGE_EXTENSIONS):
            continue
        image = os.path.join(images_dir, name)
        refuse_link(image)
        sidecar = os.path.join(images_dir, os.path.splitext(name)[0] + ".txt")
        refuse_link(sidecar)
        caption = ""
        if os.path.isfile(sidecar):
            with open_no_follow(sidecar) as f:
                caption = f.read().decode("utf-8").strip()
        full = trigger if caption == "" else f"{trigger}, {caption}"
        items.append((image, full))
    if not items:
        raise ArgumentError(f"{images_dir} holds no images ({', '.join(IMAGE_EXTENSIONS)}).")
    return items
