"""The rules of diffusersImageServer.py, kept apart from the server so they
can run without torch: which model families are served, which components
each family's model_index.json may name, and what a request may ask for.
CI runs these through python3; it has no torch.

Nothing here may import torch or diffusers. A test checks the imports.
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from localServerCommon import MAX_IMAGE_BYTES, ImageDataError, base64_length, image_bytes_of  # noqa: E402

# The one diffusers release these rules and the server were written
# against. The server refuses any other version, because it reaches into
# callback_on_step_end and the pipeline classes.
DIFFUSERS_VERSION = "0.40.0"

# The largest image one request may ask for. Both caps bound how long one
# caller holds the generation lock. The side cap keeps out a thin image
# such as 4096x960, which fits under the pixel cap.
MAX_SIDE = 2048
MIN_SIDE = 256
MAX_PIXELS = 4_000_000

# The VAE shrinks an image 8 times on each side and the transformer packs
# the result in 2x2 patches, so each side must be a multiple of 16.
SIZE_MULTIPLE = 16

DEFAULT_SIZE = "1024x1024"

FORMATS = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}

MAX_SEED = 2**32 - 1

# The largest guidance a family that takes guidance accepts. Model cards
# use 1 to 7; far above that the image burns out.
MAX_GUIDANCE = 20

# Every field a request may carry. `model` is the front door's routing
# field, rewritten to this process's directory before the request arrives.
FIELDS = [
    "model",
    "prompt",
    "size",
    "steps",
    "guidance",
    "seed",
    "negative_prompt",
    "output_format",
    "response_format",
    "n",
    "lora",
    "lora_scale",
    "controlnet",
    "control_image",
    "control_scale",
    "control_invert",
    "images",
    "start_image",
    "mask_image",
    "strength",
]

# A request names a LoRA adapter by its file's name in the adapters folder
# (`client.adaptersDir`), without the extension: "sketch" for
# sketch.safetensors. One path segment, so a name can never leave the
# folder. Only this format: a .bin or .pt adapter loads through pickle,
# which runs code.
ADAPTER_EXTENSION = ".safetensors"

# How strongly an adapter is applied. 1.0 is as trained; the model cards
# for style adapters suggest 0.5 to 1.2, and above 2 the image falls apart.
MAX_LORA_SCALE = 2.0
DEFAULT_LORA_SCALE = 1.0

# A request names a ControlNet by its folder's name in the ControlNets
# folder (`client.controlnetsDir`): a diffusers ControlNet directory with
# these two files and nothing that is a symlink. How strongly it
# constrains the image is control_scale, 1.0 as the model card says.
CONTROLNET_FILES = ("config.json", "diffusion_pytorch_model.safetensors")
MAX_CONTROL_SCALE = 2.0
DEFAULT_CONTROL_SCALE = 1.0

# A reference image. The model shrinks every reference to about one
# megapixel, so a larger file buys nothing. `MAX_INPUT_IMAGE_BYTES` and
# `MAX_REFERENCE_IMAGES` in lib/stdlib/localImageInputs.ts are the same.
MAX_INPUT_IMAGE_BYTES = 20_000_000
MAX_REFERENCE_IMAGES = 4

# The smallest side and the most extreme shape FLUX.2 [klein] takes in a
# reference. The pipeline checks both itself, but from inside the call,
# where a failure is a server error; the server checks them on decode.
# A start image is held to the same two limits for another reason: it is
# cropped to the output's shape, and a tiny or thin picture has too little
# left after the crop to redraw. A 100x5000 picture cropped to a square
# keeps a fiftieth of itself.
MIN_REFERENCE_SIDE = 64
MAX_REFERENCE_ASPECT = 8

# The images a request can carry, one row per request field. The field a
# request carries decides its mode; a request with no image is in "plain"
# mode. A field with `goes_with` comes only with that other field, and the
# pair decides the mode: a start image with a mask is "inpaint".
# `LOCAL_IMAGE_FIELDS` in lib/stdlib/localImageInputs.ts is the same table
# for the stdlib, and a test compares the two.
#
#   mode       the mode the field puts a request in. A family takes a mode
#              when its row in FAMILIES has a pipeline for it.
#   max_count  how many images the field takes. One is a base64 string,
#              more is a list of them.
#   max_bytes  the largest image, in bytes
#   sets_size  True: with no size in the request, the output takes its
#              shape from the field's first image. False: the default size.
#   fit        how the server fits a decoded image to the output size:
#              "letterbox" scales it to fit inside and centers it on black,
#              "shrink" scales a picture over REFERENCE_PIXELS down to that
#              many and leaves a smaller one as it is, and "cover" scales
#              it to cover the output and crops the overflow evenly from
#              both sides
#   background the color a transparent image is pasted onto before it is
#              made RGB: "white" or "black". None: its color channels are
#              kept as stored, and the alpha band is dropped.
#   refusal    the message for a family with no pipeline for the mode, with
#              {label} for the family and {families} for those that have one
#   prepare    optional: the name of a step the server runs on a decoded
#              image before fitting it. "invert" inverts a control image
#              when the request asks.
#   check      optional: the name of a check in CHECKS the server runs on a
#              decoded image's size. It returns a refusal or None.
#   arg        the pipeline argument the field's images are passed as
#   goes_with  optional: the field this one comes with. A request with this
#              field and not the other is refused.
#   same_size_as
#              optional: the field whose image this one's must match in
#              width and height, so both are cropped the same way
INPUT_IMAGES = {
    "control_image": {
        "mode": "control",
        "max_count": 1,
        "max_bytes": MAX_IMAGE_BYTES,
        # A control image is a drawing to follow, not a picture to keep.
        "sets_size": False,
        "fit": "letterbox",
        "background": None,
        "refusal": "{label} does not take a ControlNet. Leave controlnet empty.",
        "prepare": "invert",
        "arg": "image",
    },
    "images": {
        "mode": "reference",
        "max_count": MAX_REFERENCE_IMAGES,
        "max_bytes": MAX_INPUT_IMAGE_BYTES,
        "sets_size": True,
        # The model only looks at a reference, so it can stay any shape.
        "fit": "shrink",
        "background": "white",
        "refusal": "{label} does not take reference images. Only {families} takes them.",
        "check": "reference_problem",
        "arg": "image",
    },
    "start_image": {
        "mode": "img2img",
        "max_count": 1,
        "max_bytes": MAX_INPUT_IMAGE_BYTES,
        "sets_size": True,
        # Cropped, not letterboxed: black bands would be part of the
        # picture, and the model would redraw them as black bars.
        "fit": "cover",
        "background": "white",
        "refusal": "{label} does not redraw a start image. {families} do.",
        "check": "start_image_problem",
        "arg": "image",
    },
    # White marks the part of the start image to redraw, and black the part
    # to keep. Grey redraws partly.
    "mask_image": {
        "mode": "inpaint",
        "max_count": 1,
        "max_bytes": MAX_INPUT_IMAGE_BYTES,
        # The start image sets the size.
        "sets_size": False,
        # Cropped exactly as the start image is, since the two are the same
        # size.
        "fit": "cover",
        # A transparent part of a mask is black, and so kept.
        "background": "black",
        "refusal": "{label} does not redraw part of a picture. {families} do.",
        "arg": "mask_image",
        "goes_with": "start_image",
        "same_size_as": "start_image",
    },
}

# Every field of each mode but plain, its image field among them. A field
# of a mode the request is not in is refused.
MODE_FIELDS = {
    "control": ["controlnet", "control_image", "control_scale", "control_invert"],
    "reference": ["images"],
    "img2img": ["start_image", "strength"],
    "inpaint": ["start_image", "mask_image", "strength"],
}

# The modes that start from a start image and take a strength.
REDRAW_MODES = ["img2img", "inpaint"]


def image_fields_of(mode):
    """The image fields a request in `mode` carries, the one that sets the
    size first: [] for plain. A field that goes with another brings it
    along, so inpaint is [start_image, mask_image]."""
    fields = [field for field, row in INPUT_IMAGES.items() if row["mode"] == mode]
    partners = [INPUT_IMAGES[field]["goes_with"] for field in fields if "goes_with" in INPUT_IMAGES[field]]
    return partners + fields

# Room in a request body for everything but its images: the prompt and the
# settings.
REQUEST_SETTINGS_BYTES = 64 * 1024

# The largest request body: the settings, plus the base64 of the most image
# bytes one mode's fields may carry. `localBodyBytes()` in
# lib/stdlib/localImageInputs.ts is the same number, and the front door
# holds image requests to it.
MAX_BODY_BYTES = REQUEST_SETTINGS_BYTES + max(
    sum(
        base64_length(INPUT_IMAGES[field]["max_count"] * INPUT_IMAGES[field]["max_bytes"])
        for field in image_fields_of(mode)
    )
    for mode in MODE_FIELDS
)

# The pixel budget of a size taken from a picture: the default size's.
DERIVED_PIXELS = 1024 * 1024

# The most pixels of a reference the model reads. FLUX.2 [klein] shrinks a
# larger one to this many inside the pipeline, under the generation lock.
# The server shrinks it first, so it holds no full-size picture while it
# waits for the lock.
REFERENCE_PIXELS = 1024 * 1024

# How many adapters stay loaded at once. Two lets a user compare two
# adapters without reloading either; more would hold GPU memory for
# adapters no request is using.
MAX_LOADED_ADAPTERS = 2

# What each family takes, keyed by `_class_name` in model_index.json.
#
#   label            how the family is named in a message
#   pipelines        the diffusers class for each mode the family takes.
#                    "plain" is the class the server loads; the class of
#                    another mode is built from the loaded one's parts. A
#                    mode with no class here is refused. The server takes
#                    each class from here, never from the file.
#   default_steps    the model card's step count
#   max_steps        the most steps one request may ask for
#   default_guidance the model card's guidance
#   takes_guidance   False: the family runs without guidance, and a request
#                    that sets guidance or a negative prompt is refused
#   guidance_arg     the pipeline argument the guidance goes to
#   default_negative_prompt
#                    the negative prompt sent when a request has none.
#                    Qwen-Image runs guidance only when it gets one, even
#                    a blank one.
#   takes_lora       True: the server may load LoRA adapters for it, and a
#                    request may name one. Every family's pipeline can load
#                    LoRA; only SDXL, the family people train adapters for,
#                    has been tried with them.
#   default_strength how much of a start image to redraw when the request
#                    gives no strength. None for a family with no img2img
#                    pipeline, and so for the next two keys.
#   img2img_takes_size
#                    True: the img2img pipeline takes width and height.
#                    False: it has no such arguments and draws at the start
#                    image's size. The server fits the start image to the
#                    output size first, so the result is the same.
#   img2img_steps    how the img2img and inpaint pipelines round the steps
#                    they run: a key of STEP_FORMULAS. A family's two
#                    pipelines round the same way.
#   inpaint_default_strength
#                    how much of the masked part of a start image to redraw
#                    when the request gives no strength: the inpaint
#                    pipeline's own default. None for a family with no
#                    inpaint pipeline.
#   components       every component model_index.json must name, as
#                    [library, class]. [None, None] is a slot the file
#                    lists and leaves empty.

#   settings         the other values model_index.json may carry, which
#                    from_pretrained passes to the pipeline, each with the
#                    one value allowed
FAMILIES = {
    "ZImagePipeline": {
        "label": "Z-Image Turbo",
        "pipelines": {
            "plain": "ZImagePipeline",
            "img2img": "ZImageImg2ImgPipeline",
            "inpaint": "ZImageInpaintPipeline",
        },
        "default_steps": 9,
        "max_steps": 50,
        "default_guidance": 0.0,
        "takes_guidance": False,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": False,
        "default_strength": 0.6,
        "img2img_takes_size": True,
        "img2img_steps": "up",
        "inpaint_default_strength": 1.0,
        "components": {
            "scheduler": [["diffusers", "FlowMatchEulerDiscreteScheduler"]],
            "text_encoder": [["transformers", "Qwen3Model"]],
            "tokenizer": [["transformers", "Qwen2Tokenizer"]],
            "transformer": [["diffusers", "ZImageTransformer2DModel"]],
            "vae": [["diffusers", "AutoencoderKL"]],
        },
        "settings": {},
    },
    "ChromaPipeline": {
        "label": "Chroma",
        "pipelines": {
            "plain": "ChromaPipeline",
            "img2img": "ChromaImg2ImgPipeline",
            "inpaint": "ChromaInpaintPipeline",
        },
        "default_steps": 40,
        "max_steps": 80,
        "default_guidance": 3.0,
        "takes_guidance": True,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": False,
        "default_strength": 0.9,
        "img2img_takes_size": True,
        "img2img_steps": "up",
        "inpaint_default_strength": 0.6,
        "components": {
            "feature_extractor": [[None, None]],
            "image_encoder": [[None, None]],
            "scheduler": [["diffusers", "FlowMatchEulerDiscreteScheduler"]],
            "text_encoder": [["transformers", "T5EncoderModel"]],
            "tokenizer": [["transformers", "T5Tokenizer"]],
            "transformer": [["diffusers", "ChromaTransformer2DModel"]],
            "vae": [["diffusers", "AutoencoderKL"]],
        },
        "settings": {},
    },
    "QwenImagePipeline": {
        "label": "Qwen-Image",
        "pipelines": {
            "plain": "QwenImagePipeline",
            "img2img": "QwenImageImg2ImgPipeline",
            "inpaint": "QwenImageInpaintPipeline",
        },
        "default_steps": 50,
        "max_steps": 80,
        "default_guidance": 4.0,
        "takes_guidance": True,
        # Qwen-Image is not guidance-distilled: guidance_scale is ignored,
        # and true_cfg_scale sets the strength of classifier-free guidance.
        "guidance_arg": "true_cfg_scale",
        "default_negative_prompt": " ",
        "takes_lora": False,
        "default_strength": 0.6,
        "img2img_takes_size": True,
        "img2img_steps": "up",
        "inpaint_default_strength": 0.6,
        "components": {
            "scheduler": [["diffusers", "FlowMatchEulerDiscreteScheduler"]],
            "text_encoder": [["transformers", "Qwen2_5_VLForConditionalGeneration"]],
            "tokenizer": [["transformers", "Qwen2Tokenizer"]],
            "transformer": [["diffusers", "QwenImageTransformer2DModel"]],
            "vae": [["diffusers", "AutoencoderKLQwenImage"]],
        },
        "settings": {},
    },
    "Flux2KleinPipeline": {
        "label": "FLUX.2 [klein]",
        # One class does both: it edits when it is given images.
        "pipelines": {"plain": "Flux2KleinPipeline", "reference": "Flux2KleinPipeline"},
        "default_steps": 4,
        "max_steps": 50,
        # The pipeline ignores guidance on a step-distilled model and warns
        # above 1.0, so 1.0 is what the model card passes.
        "default_guidance": 1.0,
        "takes_guidance": False,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": False,
        # klein edits from references instead. diffusers has an inpaint
        # pipeline for it, but no img2img one, and neither is served yet.
        "default_strength": None,
        "img2img_takes_size": None,
        "img2img_steps": None,
        "inpaint_default_strength": None,
        "components": {
            "scheduler": [["diffusers", "FlowMatchEulerDiscreteScheduler"]],
            "text_encoder": [["transformers", "Qwen3ForCausalLM"]],
            "tokenizer": [["transformers", "Qwen2TokenizerFast"]],
            "transformer": [["diffusers", "Flux2Transformer2DModel"]],
            "vae": [["diffusers", "AutoencoderKLFlux2"]],
        },
        # Only the step-distilled checkpoint is served. The base model
        # needs guidance and about 50 steps, which this row does not allow.
        "settings": {"is_distilled": True},
    },
    # SDXL and its finetunes: Illustrious, NoobAI, and base SDXL share one
    # model_index.json shape. The steps and guidance are NoobAI-XL's card;
    # base SDXL's card says 50 steps at 5.0, well inside the caps.
    "StableDiffusionXLPipeline": {
        "label": "SDXL",
        # Only SDXL takes a ControlNet: every catalog ControlNet is an SDXL one.
        "pipelines": {
            "plain": "StableDiffusionXLPipeline",
            "control": "StableDiffusionXLControlNetPipeline",
            "img2img": "StableDiffusionXLImg2ImgPipeline",
            "inpaint": "StableDiffusionXLInpaintPipeline",
        },
        "default_steps": 28,
        "max_steps": 80,
        "default_guidance": 5.5,
        "takes_guidance": True,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": True,
        # The pipeline's own default is 0.3, made for use after a refiner.
        # It barely changes a style.
        "default_strength": 0.6,
        "img2img_takes_size": False,
        "img2img_steps": "down",
        # Just under 1, so the masked part keeps a trace of the start image.
        "inpaint_default_strength": 0.9999,
        "components": {
            "feature_extractor": [[None, None]],
            "image_encoder": [[None, None]],
            # Many community SDXL finetunes ship the ancestral Euler
            # sampler. Both classes read the same
            # scheduler_config.json.
            "scheduler": [
                ["diffusers", "EulerDiscreteScheduler"],
                ["diffusers", "EulerAncestralDiscreteScheduler"],
            ],
            "text_encoder": [["transformers", "CLIPTextModel"]],
            "text_encoder_2": [["transformers", "CLIPTextModelWithProjection"]],
            "tokenizer": [["transformers", "CLIPTokenizer"]],
            "tokenizer_2": [["transformers", "CLIPTokenizer"]],
            "unet": [["diffusers", "UNet2DConditionModel"]],
            "vae": [["diffusers", "AutoencoderKL"]],
        },
        # Every SDXL checkpoint sets this; it makes an empty negative prompt
        # encode as zeros, as the model was trained.
        "settings": {"force_zeros_for_empty_prompt": True},
    },
}

# The one image the server makes before it opens its port: small and
# short, so start-up waits seconds, not a full generation.
WARM_UP_PROMPT = "A red apple on a wooden table."


class RequestError(Exception):
    """A request the server refuses. `status` is the HTTP status to answer."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def join_names(names, word="and"):
    if len(names) <= 1:
        return "".join(names)
    if len(names) == 2:
        return f"{names[0]} {word} {names[1]}"
    return ", ".join(names[:-1]) + f", {word} " + names[-1]


def family_of(model_index):
    """The family row a model_index.json describes. Raises ValueError
    naming what does not match, because from_pretrained imports whatever
    library and class the file names, and only the rows here are allowed."""
    class_name = model_index.get("_class_name")
    rules = FAMILIES.get(class_name) if isinstance(class_name, str) else None
    if rules is None:
        raise ValueError(
            f"diffusersImageServer.py serves {join_names(sorted(FAMILIES))} models. "
            f'This model_index.json names "{class_name}".'
        )
    named = {key: value for key, value in model_index.items() if not key.startswith("_")}
    for key, value in rules["settings"].items():
        # A missing setting is refused too: the pipeline would fall back to
        # its own default, which may not be the value allowed.
        if key not in named or named[key] != value:
            found = f"says {named[key]}" if key in named else "does not set it"
            raise ValueError(
                f'{rules["label"]}\'s "{key}" must be {value}. This model_index.json {found}.'
            )
    named = {key: value for key, value in named.items() if key not in rules["settings"]}
    for component, value in named.items():
        allowed = rules["components"].get(component)
        if allowed is None:
            raise ValueError(
                f'{rules["label"]} has no component "{component}", '
                "and this model_index.json names one."
            )
        if value not in allowed:
            raise ValueError(
                f'{rules["label"]}\'s "{component}" must be '
                f"{join_names([str(pair) for pair in allowed], 'or')}. "
                f"This model_index.json says {value}."
            )
    missing = [c for c in rules["components"] if c not in named]
    if missing:
        raise ValueError(
            f"This model_index.json does not name {join_names(missing)}, "
            f"which {rules['label']} needs."
        )
    return rules


def _is_number(value):
    # Python counts True as 1, and a guidance of true is not a guidance of 1.
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _is_integer(value):
    return not isinstance(value, bool) and isinstance(value, int)


def parse_size(size):
    """(width, height) from "WxH". Raises RequestError for anything else."""
    shape_message = (
        f'size must be two multiples of {SIZE_MULTIPLE} joined by "x", such as "{DEFAULT_SIZE}".'
    )
    if not isinstance(size, str):
        raise RequestError(shape_message)
    parts = size.split("x")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        raise RequestError(shape_message)
    width, height = int(parts[0]), int(parts[1])
    if width % SIZE_MULTIPLE != 0 or height % SIZE_MULTIPLE != 0:
        raise RequestError(shape_message)
    if min(width, height) < MIN_SIDE or max(width, height) > MAX_SIDE:
        raise RequestError(f"Each side of size must be from {MIN_SIDE} to {MAX_SIDE}.")
    if width * height > MAX_PIXELS:
        raise RequestError(
            f"size {size} is {width * height:,} pixels; this server makes at most "
            f"{MAX_PIXELS:,}."
        )
    return width, height


def _prompt_of(body):
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or prompt.strip() == "":
        raise RequestError("prompt must be a non-empty string.")
    return prompt


def _steps_of(rules, body):
    steps = body.get("steps")
    if steps is None:
        return rules["default_steps"]
    if not _is_integer(steps) or steps < 1 or steps > rules["max_steps"]:
        raise RequestError(
            f"steps must be between 1 and {rules['max_steps']} for {rules['label']}. "
            f"Its model card uses {rules['default_steps']}."
        )
    return steps


def _guidance_of(rules, body):
    guidance = body.get("guidance")
    if guidance is None:
        return rules["default_guidance"]
    if not rules["takes_guidance"]:
        # The family's own value, copied from its docs, is not a request
        # for guidance.
        if _is_number(guidance) and guidance == rules["default_guidance"]:
            return rules["default_guidance"]
        raise RequestError(f"{rules['label']} runs without guidance. Leave guidance empty.")
    if not _is_number(guidance) or guidance < 0 or guidance > MAX_GUIDANCE:
        raise RequestError(
            f"guidance must be a number from 0 to {MAX_GUIDANCE}. "
            f"{rules['label']}'s model card uses {rules['default_guidance']}."
        )
    return float(guidance)


def _negative_prompt_of(rules, body):
    negative = body.get("negative_prompt")
    if negative is None:
        return ""
    if not isinstance(negative, str):
        raise RequestError("negative_prompt must be a string.")
    if negative != "" and not rules["takes_guidance"]:
        raise RequestError(
            f"{rules['label']} does not use a negative prompt, because it runs without "
            "guidance. Leave negative_prompt empty."
        )
    return negative


def _strength_of(rules, body, mode):
    """How much of the start image to redraw: the request's strength, or
    the family's default for the mode. None outside REDRAW_MODES, where
    mode_of has already refused a strength."""
    if mode not in REDRAW_MODES:
        return None
    default = rules["default_strength"] if mode == "img2img" else rules["inpaint_default_strength"]
    strength = body.get("strength")
    if strength is None:
        return default
    if not _is_number(strength) or strength <= 0 or strength > 1:
        raise RequestError(
            "strength must be a number above 0 and at most 1. Low keeps the start image close; "
            f"{rules['label']} uses {default} when strength is left out."
        )
    return float(strength)


def _seed_of(body):
    seed = body.get("seed")
    if seed is None:
        return random.randint(0, MAX_SEED)
    if not _is_integer(seed) or seed < 0 or seed > MAX_SEED:
        raise RequestError(f"seed must be a whole number from 0 to {MAX_SEED}.")
    return seed


def _format_of(body):
    fmt = body.get("output_format")
    if fmt is None:
        return "png"
    if not isinstance(fmt, str) or fmt not in FORMATS:
        raise RequestError(
            f'output_format "{fmt}" is not supported. Use {join_names(list(FORMATS), 'or')}.'
        )
    return fmt


def folder_entry(folder, name, field, what, extension):
    """The path of the entry `name` inside a configured folder. Raises
    RequestError for a name that is not one plain name: empty, a dot name,
    one with a path separator, or one that already carries the extension.
    Whether the entry exists is checked when it is loaded. The one rule
    for adapters and ControlNets, so a request can never leave its folder."""
    bad = (
        not isinstance(name, str)
        or name in ("", ".", "..")
        or "/" in name
        or "\\" in name
        or (extension != "" and name.endswith(extension))
    )
    if bad:
        raise RequestError(
            f'{field} must be {what}, such as "sketch" for sketch{extension or "/"}. Got {name!r}.'
        )
    return os.path.join(folder, name + extension)


def adapter_path(adapters_dir, name):
    """The file the adapter `name` is, inside the adapters folder.
    existing_adapter checks the file itself."""
    return folder_entry(
        adapters_dir,
        name,
        "lora",
        f"an adapter's name: its file name in the adapters folder without {ADAPTER_EXTENSION}",
        ADAPTER_EXTENSION,
    )


def controlnet_path(controlnets_dir, name):
    """The directory the ControlNet `name` is, inside the ControlNets folder."""
    return folder_entry(
        controlnets_dir, name, "controlnet", "a ControlNet's name: its folder in the ControlNets folder", ""
    )


def check_folder(folder, flag):
    """A configured folder, the adapters or the ControlNets folder, once it
    is known to be a directory and not a symlink, or None when none is
    configured. Raises ValueError with the message to fail with, naming
    the command-line flag."""
    if folder is None:
        return None
    if os.path.islink(folder):
        raise ValueError(f"{flag} {folder} is a symlink. Name the folder itself.")
    if not os.path.isdir(folder):
        raise ValueError(f"{flag} {folder} is not a folder.")
    return folder


def controlnet_problem(folder):
    """Why the ControlNet directory `folder` cannot be loaded, or None when
    it can. It must be a real directory holding CONTROLNET_FILES as regular
    files, with no symlink anywhere inside it, since from_pretrained
    follows links."""
    if os.path.islink(folder):
        return f"{folder} is a symlink, which this server does not follow."
    if not os.path.isdir(folder):
        return f"{folder} is not a folder."
    for parent, dirs, files in os.walk(folder):
        for entry in dirs + files:
            path = os.path.join(parent, entry)
            if os.path.islink(path):
                return f"{path} is a symlink, which this server does not follow."
    missing = [name for name in CONTROLNET_FILES if not os.path.isfile(os.path.join(folder, name))]
    if missing:
        return f"{folder} has no {join_names(missing)}."
    return None


def controlnet_names(controlnets_dir):
    """The ControlNets in the folder, by name: the entries controlnet_problem
    accepts, so the list holds exactly what a request can load. Read fresh
    each time."""
    try:
        entries = os.listdir(controlnets_dir)
    except OSError:
        return []
    return sorted(
        entry for entry in entries if controlnet_problem(os.path.join(controlnets_dir, entry)) is None
    )


def _adapter_name_of(entry):
    """The name a request uses for a file in the folder, or None for a file
    no request can name: another format, or a name adapter_path refuses,
    such as "x.safetensors" for x.safetensors.safetensors."""
    if not entry.endswith(ADAPTER_EXTENSION):
        return None
    name = entry[: -len(ADAPTER_EXTENSION)]
    try:
        adapter_path("", name)
    except RequestError:
        return None
    return name


def adapter_names(adapters_dir):
    """The adapters in the folder, by name, for a message or /health. Reads
    the folder fresh, so an adapter dropped in after start-up is listed.
    Lists only what existing_adapter would load: a symlink, a folder, or a
    file whose name a request cannot spell is left out."""
    try:
        entries = os.listdir(adapters_dir)
    except OSError:
        return []
    names = []
    for entry in entries:
        name = _adapter_name_of(entry)
        path = os.path.join(adapters_dir, entry)
        if name is not None and not os.path.islink(path) and os.path.isfile(path):
            names.append(name)
    return sorted(names)


def existing_adapter(adapters_dir, name):
    """(path, stamp) for the adapter `name`: its file, and the file's
    modification time and size, which change when the adapter is trained
    again. Raises RequestError for a name adapter_path refuses, and for a
    file that is missing, is not a plain file, or is a symlink, naming what
    the folder holds."""
    path = adapter_path(adapters_dir, name)
    try:
        info = os.lstat(path)
    except OSError:
        info = None
    if info is None or os.path.islink(path) or not os.path.isfile(path):
        have = adapter_names(adapters_dir)
        listing = join_names(have) if have else "no adapters"
        raise RequestError(f'There is no adapter "{name}" in {adapters_dir}. It has {listing}.')
    return path, [info.st_mtime_ns, info.st_size]


class LoadedAdapters:
    """Which adapters the pipeline holds, and the name each is loaded under.

    The pipeline does not get the file name as the adapter's name: torch
    refuses a dot in a module name, and "style.v2" is a common file name.
    Each load gets a fresh name instead, adapter_0, adapter_1, and so on,
    so a name left behind by a failed load is never reused.

    At most `limit` adapters stay loaded. An SDXL adapter can be close to a
    gigabyte, and a model calling generateImageLocal may try every adapter
    in the folder, so the one used longest ago is unloaded to make room.

    This class only keeps the books. The server does the loading and
    unloading it says to do."""

    def __init__(self, limit=MAX_LOADED_ADAPTERS):
        self.limit = limit
        # Oldest use first: [{"name", "loaded_as", "stamp"}].
        self.entries = []
        self.count = 0

    def find(self, name, stamp):
        """The name `name` is loaded under, or None when it is not loaded or
        its file has changed since. Marks it as just used."""
        for entry in self.entries:
            if entry["name"] == name and entry["stamp"] == stamp:
                self.entries.remove(entry)
                self.entries.append(entry)
                return entry["loaded_as"]
        return None

    def make_room(self, name):
        """The loaded names to unload before `name` is loaded: its own
        earlier load, whose file has changed, and the adapters used longest
        ago, until one more fits. Forgets them."""
        drop = [entry for entry in self.entries if entry["name"] == name]
        kept = [entry for entry in self.entries if entry["name"] != name]
        while len(kept) >= self.limit:
            drop.append(kept.pop(0))
        self.entries = kept
        return [entry["loaded_as"] for entry in drop]

    def next_name(self):
        """A name no load has used yet."""
        loaded_as = f"adapter_{self.count}"
        self.count += 1
        return loaded_as

    def add(self, name, loaded_as, stamp):
        """Records a load that finished."""
        self.entries.append({"name": name, "loaded_as": loaded_as, "stamp": stamp})


def _lora_of(rules, body, adapters_dir):
    """(name or None, scale) for a request. A request that names no adapter
    gets none, whatever the folder holds: an adapter changes every image,
    so it is applied only when asked for."""
    name = body.get("lora")
    scale = body.get("lora_scale")
    if name is None:
        if scale is not None:
            raise RequestError("lora_scale needs lora: it says how strongly to apply the adapter.")
        return None, DEFAULT_LORA_SCALE
    if not rules["takes_lora"]:
        raise RequestError(f"{rules['label']} does not take LoRA adapters. Leave lora empty.")
    if adapters_dir is None:
        raise RequestError(
            "This server has no adapters folder. Set client.adaptersDir in agency.json to the "
            "folder your .safetensors adapters are in, and start the server again."
        )
    adapter_path(adapters_dir, name)
    if scale is None:
        return name, DEFAULT_LORA_SCALE
    if not _is_number(scale) or scale < 0 or scale > MAX_LORA_SCALE:
        raise RequestError(
            f"lora_scale must be a number from 0 to {MAX_LORA_SCALE}. 1 applies the adapter as trained."
        )
    return name, float(scale)


def _check_openai_fields(body):
    """The OpenAI fields this server takes only one value of."""
    response_format = body.get("response_format")
    if response_format is not None and response_format != "b64_json":
        raise RequestError(
            f'response_format "{response_format}" is not supported. This server returns '
            "b64_json only."
        )
    n = body.get("n")
    if n is not None and not (_is_integer(n) and n == 1):
        raise RequestError("n must be 1. Make one request per image.")


def _check_unknown_fields(body):
    if "quality" in body:
        raise RequestError("quality is not a setting of this server. Use steps instead.")
    unknown = sorted(key for key in body if key not in FIELDS)
    if unknown:
        raise RequestError(
            f"{join_names(unknown)} {'is' if len(unknown) == 1 else 'are'} not "
            f"{'a setting' if len(unknown) == 1 else 'settings'} of this server. "
            f"It takes {join_names(FIELDS[1:])}."
        )


def mode_of(rules, body):
    """The request's mode: the mode of the image field it carries, or
    "plain" when it carries none. A field that goes with another decides
    the mode of the pair: a start image with a mask is inpaint. Refuses
    such a field without its partner, image fields of two modes, a field
    of a mode the request is not in, and a mode the family has no pipeline
    for."""
    present = [field for field in INPUT_IMAGES if body.get(field) is not None]
    for field in present:
        partner = INPUT_IMAGES[field].get("goes_with")
        if partner is not None and partner not in present:
            raise RequestError(f"{field} goes with {partner}, and this request has none.")
    leads = [field for field in present if "goes_with" not in INPUT_IMAGES[field]]
    if len(leads) > 1:
        choices = [field for field in INPUT_IMAGES if "goes_with" not in INPUT_IMAGES[field]]
        raise RequestError(f"a request takes one of {join_names(choices, 'or')}.")
    deciding = [field for field in present if "goes_with" in INPUT_IMAGES[field]] or leads
    field = deciding[0] if deciding else None
    mode = "plain" if field is None else INPUT_IMAGES[field]["mode"]
    allowed = MODE_FIELDS.get(mode, [])
    # A field of several modes, such as strength, is named with the first
    # mode that has it.
    for other, fields in MODE_FIELDS.items():
        stray = [name for name in fields if name not in allowed and body.get(name) is not None]
        if stray:
            verb = "goes" if len(stray) == 1 else "go"
            raise RequestError(
                f"{join_names(stray)} {verb} with {image_field_of(other)}, and this request has none."
            )
    if mode not in rules["pipelines"]:
        families = [row["label"] for row in FAMILIES.values() if mode in row["pipelines"]]
        raise RequestError(
            INPUT_IMAGES[field]["refusal"].format(label=rules["label"], families=join_names(families))
        )
    return mode


def image_field_of(mode):
    """The image field of a mode, or None for plain."""
    for field, row in INPUT_IMAGES.items():
        if row["mode"] == mode:
            return field
    return None


def input_images_of(body, fields):
    """The bytes of each image the request carries, by field, for the image
    fields of its mode."""
    return {field: input_bytes(body, field) for field in fields}


def input_bytes(body, field):
    """The bytes of each image in the field `field`, from the request's
    base64: a list, empty when `field` is None. Holds the field to its
    row's count and byte caps, and names the entry a refusal is about.
    The stdlib reads each file after the user approves it, so the server
    never opens a path a request wrote."""
    if field is None:
        return []
    row = INPUT_IMAGES[field]
    value = body[field]
    if row["max_count"] == 1:
        entries = [(field, value)]
    else:
        if not isinstance(value, list) or value == []:
            raise RequestError(f"{field} must be a list of images, each its bytes as base64.")
        if len(value) > row["max_count"]:
            raise RequestError(f"{field} takes at most {row['max_count']} images. This request has {len(value)}.")
        entries = [(f"{field}[{index}]", entry) for index, entry in enumerate(value)]
    images = []
    for name, entry in entries:
        try:
            images.append(image_bytes_of(entry, row["max_bytes"]))
        except ImageDataError as err:
            raise RequestError(f"{name}: {err}")
    return images


def _check_control_pairing(body):
    """A ControlNet and its image go together; one without the other is
    refused. Checked before mode_of, so a request that is only missing its
    image hears that. A scale or an invert with neither is mode_of's to
    refuse, as a field of a mode the request is not in."""
    name = body.get("controlnet")
    image = body.get("control_image")
    if (name is None) != (image is None):
        raise RequestError(
            "controlnet and control_image go together: the ControlNet's name, and the image "
            "it conditions the generation on."
        )


def _controlnet_of(body, controlnets_dir):
    """The ControlNet part of a checked request: the name or None, the
    scale, and whether to invert the image. Runs after mode_of, which has
    refused a family that takes no ControlNet."""
    name = body.get("controlnet")
    scale = body.get("control_scale")
    invert = body.get("control_invert")
    if name is None:
        return {"controlnet": None, "control_scale": DEFAULT_CONTROL_SCALE, "control_invert": False}
    if controlnets_dir is None:
        raise RequestError(
            "This server has no ControlNets folder. Set client.controlnetsDir in agency.json to the "
            "folder your ControlNets are in, and start the server again."
        )
    controlnet_path(controlnets_dir, name)
    if scale is not None and (not _is_number(scale) or scale < 0 or scale > MAX_CONTROL_SCALE):
        raise RequestError(
            f"control_scale must be a number from 0 to {MAX_CONTROL_SCALE}. 1 applies it as the model card says."
        )
    if invert is not None and not isinstance(invert, bool):
        raise RequestError("control_invert must be true or false.")
    return {
        "controlnet": name,
        "control_scale": DEFAULT_CONTROL_SCALE if scale is None else float(scale),
        "control_invert": invert is True,
    }


def letterbox(source_width, source_height, width, height):
    """Where a control image of the source size goes inside a width x height
    canvas, keeping its aspect ratio: (scaled width, scaled height, left,
    top). The image is scaled to fit and centered, and the rest of the
    canvas is black, which a ControlNet reads as "no lines here"."""
    scale = min(width / source_width, height / source_height)
    fit_width = min(width, max(1, round(source_width * scale)))
    fit_height = min(height, max(1, round(source_height * scale)))
    return fit_width, fit_height, (width - fit_width) // 2, (height - fit_height) // 2


def shrink(source_width, source_height, width, height):
    """The size a reference of the source size is scaled to: its shape at
    REFERENCE_PIXELS or fewer, as (scaled width, scaled height, 0, 0). A
    smaller picture keeps its size. The output size plays no part: the
    model only looks at a reference."""
    if source_width * source_height <= REFERENCE_PIXELS:
        return source_width, source_height, 0, 0
    scale = (REFERENCE_PIXELS / (source_width * source_height)) ** 0.5
    return max(1, int(source_width * scale)), max(1, int(source_height * scale)), 0, 0


def cover(source_width, source_height, width, height):
    """Where a start image of the source size goes on a width x height
    canvas: scaled, with its shape kept, until it covers the canvas, and
    centered. (scaled width, scaled height, left, top), where left and top
    are 0 or below: the overflow hangs off both sides evenly. visible_part
    says which part of the picture is left, and only that part is
    scaled."""
    scale = max(width / source_width, height / source_height)
    fit_width = max(width, round(source_width * scale))
    fit_height = max(height, round(source_height * scale))
    return fit_width, fit_height, (width - fit_width) // 2, (height - fit_height) // 2


# How each fit in INPUT_IMAGES scales an image of the source size.
#
#   box     the function that gives (scaled width, scaled height, left, top)
#   canvas  True: the scaled image goes at left, top on a black canvas of
#           the output size, and whatever falls outside it is cut off.
#           False: the scaled image is used as it is.
FITS = {
    "letterbox": {"box": letterbox, "canvas": True},
    "shrink": {"box": shrink, "canvas": False},
    "cover": {"box": cover, "canvas": True},
}


def fit_box(fit, source_width, source_height, width, height):
    """(scaled width, scaled height, left, top) for an image of the source
    size fitted to width x height the way `fit` says."""
    return FITS[fit]["box"](source_width, source_height, width, height)


def fit_has_canvas(fit):
    """Whether an image fitted the way `fit` says goes on a canvas of the
    output size."""
    return FITS[fit]["canvas"]


def visible_part(source_width, source_height, box, width, height):
    """The part of a picture that shows on a width x height canvas, for a
    `box` from fit_box: (source box, size, position). `source box` is the
    (left, top, right, bottom) of the part in the picture's own pixels,
    `size` is what that part is scaled to, and `position` is where it goes
    on the canvas.

    The server scales the part and never the whole picture. A 64x512
    picture covering a 2048x256 output would be 2048x16384 if scaled whole,
    about 100 MB, to keep a 2048x256 strip of it."""
    fit_width, fit_height, left, top = box
    x0, y0 = max(0, -left), max(0, -top)
    x1, y1 = min(fit_width, width - left), min(fit_height, height - top)
    across, down = source_width / fit_width, source_height / fit_height
    source_box = (x0 * across, y0 * down, x1 * across, y1 * down)
    return source_box, (x1 - x0, y1 - y0), (max(0, left), max(0, top))


def derived_size(width, height):
    """The output size for a request that gave none, from the size of its
    first input picture: its shape at DERIVED_PIXELS or fewer, each side at
    most MAX_SIDE and a multiple of SIZE_MULTIPLE. A picture is never
    scaled up. Raises RequestError when a side ends up under MIN_SIDE."""
    scaled_width, scaled_height = float(width), float(height)
    if width * height > DERIVED_PIXELS:
        scale = (DERIVED_PIXELS / (width * height)) ** 0.5
        scaled_width, scaled_height = width * scale, height * scale
    longest = max(scaled_width, scaled_height)
    if longest > MAX_SIDE:
        scaled_width = scaled_width * MAX_SIDE / longest
        scaled_height = scaled_height * MAX_SIDE / longest
    out_width = int(scaled_width // SIZE_MULTIPLE) * SIZE_MULTIPLE
    out_height = int(scaled_height // SIZE_MULTIPLE) * SIZE_MULTIPLE
    if min(out_width, out_height) < MIN_SIDE:
        raise RequestError(
            f"the picture is {width}x{height}, which is too small or too narrow to take a size "
            "from. Pass size."
        )
    return out_width, out_height


def output_size(size, field, first_image_size):
    """(width, height) of the image to make: the size the request gave, or
    else the size taken from its first input picture when the image field
    `field` says it sets the size, or else the default size.
    `first_image_size` is (width, height) of that picture, or None."""
    if size is not None:
        return size
    if first_image_size is not None and INPUT_IMAGES[field]["sets_size"]:
        return derived_size(*first_image_size)
    return parse_size(DEFAULT_SIZE)


def _shape_problem(width, height, what):
    """Why a picture of width x height is too small or too thin to be
    `what`, such as "A reference", or None."""
    if min(width, height) < MIN_REFERENCE_SIDE:
        return (
            f"the picture is {width}x{height}. {what} must be at least "
            f"{MIN_REFERENCE_SIDE} pixels on each side."
        )
    if max(width, height) > MAX_REFERENCE_ASPECT * min(width, height):
        return (
            f"the picture is {width}x{height}. {what} can be at most "
            f"{MAX_REFERENCE_ASPECT} times as long as it is wide."
        )
    return None


def reference_problem(width, height):
    """Why FLUX.2 [klein] cannot take a reference of width x height, or
    None when it can."""
    return _shape_problem(width, height, "A reference")


def start_image_problem(width, height):
    """Why the server will not redraw a start image of width x height, or
    None when it will. The picture is cropped to the output's shape, and
    a tiny or thin one has too little left after the crop to redraw."""
    return _shape_problem(width, height, "A start image")


def size_match_problem(field, size, other, other_size):
    """Why an image of `size` in `field` cannot go with one of `other_size`
    in the field `other`, which its row says it must match, or None. Sizes
    are (width, height)."""
    if size == other_size:
        return None
    return (
        f"{field} is {size[0]}x{size[1]} and {other} is {other_size[0]}x{other_size[1]}. "
        "They must be the same size."
    )


# The checks a row of INPUT_IMAGES names in `check`.
CHECKS = {"reference_problem": reference_problem, "start_image_problem": start_image_problem}


def image_problem(field, width, height):
    """Why the server cannot take a decoded image of width x height in the
    image field `field`, from the check its row names, or None."""
    check = INPUT_IMAGES[field].get("check")
    return None if check is None else CHECKS[check](width, height)


def _steps_down(steps, strength):
    # StableDiffusionXLImg2ImgPipeline.get_timesteps, which rounds down.
    init_timestep = min(int(steps * strength), steps)
    t_start = max(steps - init_timestep, 0)
    return steps - t_start


def _steps_up(steps, strength):
    # The flow-matching img2img pipelines' get_timesteps, which round up.
    init_timestep = min(steps * strength, steps)
    t_start = int(max(steps - init_timestep, 0))
    return steps - t_start


# How an img2img pipeline counts the steps it runs from the steps asked
# for and the strength. It skips the start of the schedule, and the
# families round the part it skips differently. Each is written as
# diffusers 0.40 writes it, so floating point rounds the same way: 9 steps
# at 0.1 run 1 step "up", and 28 steps at 0.03 run none "down".
STEP_FORMULAS = {"down": _steps_down, "up": _steps_up}


def steps_run(rules, mode, steps, strength):
    """How many steps the pipeline runs for a request in `mode` that asks
    for `steps` at `strength`: all of them, except in REDRAW_MODES."""
    if mode not in REDRAW_MODES:
        return steps
    return STEP_FORMULAS[rules["img2img_steps"]](steps, strength)


def check_request(rules, body, adapters_dir=None, controlnets_dir=None):
    """The checked request, with the family's defaults filled in and a
    random seed when none was given. `adapters_dir` and `controlnets_dir`
    are the folders LoRA adapters and ControlNets come from, or None when
    not configured. Raises RequestError with a message that says what the
    model takes instead.

    `steps_run` is how many of `steps` the pipeline runs, which is fewer
    in REDRAW_MODES. A request that would run none is refused.

    `size` is the (width, height) the request gave, or None: with none,
    the size depends on the first input image, which only the server can
    open, so output_size decides it there. `image_fields` lists the image
    fields the request carries, the one that sets the size first, and
    `input_images` holds the bytes of each image in each of them."""
    if not isinstance(body, dict):
        raise RequestError("The request body must be a JSON object.")
    _check_unknown_fields(body)
    _check_openai_fields(body)
    size = parse_size(body["size"]) if body.get("size") else None
    lora, lora_scale = _lora_of(rules, body, adapters_dir)
    _check_control_pairing(body)
    mode = mode_of(rules, body)
    control = _controlnet_of(body, controlnets_dir)
    image_fields = image_fields_of(mode)
    input_images = input_images_of(body, image_fields)
    steps = _steps_of(rules, body)
    strength = _strength_of(rules, body, mode)
    run = steps_run(rules, mode, steps, strength)
    if run == 0:
        raise RequestError(f"strength {strength} with {steps} steps runs no steps; raise either.")
    return {
        "prompt": _prompt_of(body),
        "size": size,
        "mode": mode,
        "image_fields": image_fields,
        "input_images": input_images,
        "steps": steps,
        "strength": strength,
        "steps_run": run,
        "guidance": _guidance_of(rules, body),
        "seed": _seed_of(body),
        "negative_prompt": _negative_prompt_of(rules, body),
        "output_format": _format_of(body),
        "lora": lora,
        "lora_scale": lora_scale,
        **control,
    }


def pipeline_args(rules, request, width, height):
    """The keyword arguments a checked request becomes when it is passed to
    the family's pipeline at width x height, less the input images, the
    seed's generator, and the step callback, which need Pillow or torch."""
    args = {
        "prompt": request["prompt"],
        "height": height,
        "width": width,
        "num_inference_steps": request["steps"],
        rules["guidance_arg"]: request["guidance"],
    }
    negative = request["negative_prompt"] or rules["default_negative_prompt"]
    if negative != "":
        args["negative_prompt"] = negative
    if request["mode"] == "control":
        args["controlnet_conditioning_scale"] = request["control_scale"]
    if request["mode"] in REDRAW_MODES:
        args["strength"] = request["strength"]
        # Every inpaint pipeline takes a size.
        if request["mode"] == "img2img" and not rules["img2img_takes_size"]:
            # The pipeline draws at the start image's size, which the
            # server has already fitted to width x height.
            del args["width"], args["height"]
    return args


def warm_up_request():
    """The body of the one request the server makes to itself before it
    opens its port."""
    return {"prompt": WARM_UP_PROMPT, "size": "512x512", "steps": 2, "seed": 0}
