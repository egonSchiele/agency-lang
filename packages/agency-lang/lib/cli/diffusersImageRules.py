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
from localServerCommon import ImageDataError, image_bytes_of  # noqa: E402

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

# How many adapters stay loaded at once. Two lets a user compare two
# adapters without reloading either; more would hold GPU memory for
# adapters no request is using.
MAX_LOADED_ADAPTERS = 2

# What each family takes, keyed by `_class_name` in model_index.json.
#
#   label            how the family is named in a message
#   pipeline         the diffusers class the server loads. The server takes
#                    the class from here, never from the file.
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
#   takes_controlnet True: a request may name a ControlNet and an image to
#                    condition on, and controlnet_pipeline is the diffusers
#                    class that runs the pair. Only SDXL: every catalog
#                    ControlNet is an SDXL one.
#   components       every component model_index.json must name, as
#                    [library, class]. [None, None] is a slot the file
#                    lists and leaves empty.
#   settings         the other values model_index.json may carry, which
#                    from_pretrained passes to the pipeline, each with the
#                    one value allowed
FAMILIES = {
    "ZImagePipeline": {
        "label": "Z-Image Turbo",
        "pipeline": "ZImagePipeline",
        "default_steps": 9,
        "max_steps": 50,
        "default_guidance": 0.0,
        "takes_guidance": False,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": False,
        "takes_controlnet": False,
        "components": {
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "Qwen3Model"],
            "tokenizer": ["transformers", "Qwen2Tokenizer"],
            "transformer": ["diffusers", "ZImageTransformer2DModel"],
            "vae": ["diffusers", "AutoencoderKL"],
        },
        "settings": {},
    },
    "ChromaPipeline": {
        "label": "Chroma",
        "pipeline": "ChromaPipeline",
        "default_steps": 40,
        "max_steps": 80,
        "default_guidance": 3.0,
        "takes_guidance": True,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": False,
        "takes_controlnet": False,
        "components": {
            "feature_extractor": [None, None],
            "image_encoder": [None, None],
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "T5EncoderModel"],
            "tokenizer": ["transformers", "T5Tokenizer"],
            "transformer": ["diffusers", "ChromaTransformer2DModel"],
            "vae": ["diffusers", "AutoencoderKL"],
        },
        "settings": {},
    },
    "QwenImagePipeline": {
        "label": "Qwen-Image",
        "pipeline": "QwenImagePipeline",
        "default_steps": 50,
        "max_steps": 80,
        "default_guidance": 4.0,
        "takes_guidance": True,
        # Qwen-Image is not guidance-distilled: guidance_scale is ignored,
        # and true_cfg_scale sets the strength of classifier-free guidance.
        "guidance_arg": "true_cfg_scale",
        "default_negative_prompt": " ",
        "takes_lora": False,
        "takes_controlnet": False,
        "components": {
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "Qwen2_5_VLForConditionalGeneration"],
            "tokenizer": ["transformers", "Qwen2Tokenizer"],
            "transformer": ["diffusers", "QwenImageTransformer2DModel"],
            "vae": ["diffusers", "AutoencoderKLQwenImage"],
        },
        "settings": {},
    },
    "Flux2KleinPipeline": {
        "label": "FLUX.2 [klein]",
        "pipeline": "Flux2KleinPipeline",
        "default_steps": 4,
        "max_steps": 50,
        # The pipeline ignores guidance on a step-distilled model and warns
        # above 1.0, so 1.0 is what the model card passes.
        "default_guidance": 1.0,
        "takes_guidance": False,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": False,
        "takes_controlnet": False,
        "components": {
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "Qwen3ForCausalLM"],
            "tokenizer": ["transformers", "Qwen2TokenizerFast"],
            "transformer": ["diffusers", "Flux2Transformer2DModel"],
            "vae": ["diffusers", "AutoencoderKLFlux2"],
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
        "pipeline": "StableDiffusionXLPipeline",
        "default_steps": 28,
        "max_steps": 80,
        "default_guidance": 5.5,
        "takes_guidance": True,
        "guidance_arg": "guidance_scale",
        "default_negative_prompt": "",
        "takes_lora": True,
        "takes_controlnet": True,
        "controlnet_pipeline": "StableDiffusionXLControlNetPipeline",
        "components": {
            "feature_extractor": [None, None],
            "image_encoder": [None, None],
            "scheduler": ["diffusers", "EulerDiscreteScheduler"],
            "text_encoder": ["transformers", "CLIPTextModel"],
            "text_encoder_2": ["transformers", "CLIPTextModelWithProjection"],
            "tokenizer": ["transformers", "CLIPTokenizer"],
            "tokenizer_2": ["transformers", "CLIPTokenizer"],
            "unet": ["diffusers", "UNet2DConditionModel"],
            "vae": ["diffusers", "AutoencoderKL"],
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
        expected = rules["components"].get(component)
        if expected is None:
            raise ValueError(
                f'{rules["label"]} has no component "{component}", '
                "and this model_index.json names one."
            )
        if value != expected:
            raise ValueError(
                f'{rules["label"]}\'s "{component}" must be {expected}. '
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


def _control_image_of(value):
    """The bytes of the control image, from the request's base64. The
    stdlib reads the file after the user approves it, so the server never
    opens a path a request wrote."""
    try:
        return image_bytes_of(value)
    except ImageDataError as err:
        raise RequestError(f"control_image: {err}")


def _controlnet_of(rules, body, controlnets_dir):
    """The ControlNet part of a checked request: the name or None, the
    image's bytes or None, the scale, and whether to invert the image. A
    ControlNet and its image go together; one without the other is
    refused, and so are a scale or an invert without them."""
    name = body.get("controlnet")
    image = body.get("control_image")
    scale = body.get("control_scale")
    invert = body.get("control_invert")
    if name is None and image is None:
        if scale is not None or invert is not None:
            raise RequestError(
                "control_scale and control_invert need controlnet: they say how to apply it."
            )
        return {
            "controlnet": None,
            "control_image": None,
            "control_scale": DEFAULT_CONTROL_SCALE,
            "control_invert": False,
        }
    if name is None or image is None:
        raise RequestError(
            "controlnet and control_image go together: the ControlNet's name, and the image "
            "it conditions the generation on."
        )
    if not rules["takes_controlnet"]:
        raise RequestError(f"{rules['label']} does not take a ControlNet. Leave controlnet empty.")
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
        "control_image": _control_image_of(image),
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


def check_request(rules, body, adapters_dir=None, controlnets_dir=None):
    """The checked request, with the family's defaults filled in and a
    random seed when none was given. `adapters_dir` and `controlnets_dir`
    are the folders LoRA adapters and ControlNets come from, or None when
    not configured. Raises RequestError with a message that says what the
    model takes instead."""
    if not isinstance(body, dict):
        raise RequestError("The request body must be a JSON object.")
    _check_unknown_fields(body)
    _check_openai_fields(body)
    width, height = parse_size(body.get("size") or DEFAULT_SIZE)
    lora, lora_scale = _lora_of(rules, body, adapters_dir)
    control = _controlnet_of(rules, body, controlnets_dir)
    return {
        "prompt": _prompt_of(body),
        "width": width,
        "height": height,
        "steps": _steps_of(rules, body),
        "guidance": _guidance_of(rules, body),
        "seed": _seed_of(body),
        "negative_prompt": _negative_prompt_of(rules, body),
        "output_format": _format_of(body),
        "lora": lora,
        "lora_scale": lora_scale,
        **control,
    }


def pipeline_args(rules, request):
    """The keyword arguments a checked request becomes when it is passed to
    the family's pipeline, less the seed's generator and the step callback,
    which need torch."""
    args = {
        "prompt": request["prompt"],
        "height": request["height"],
        "width": request["width"],
        "num_inference_steps": request["steps"],
        rules["guidance_arg"]: request["guidance"],
    }
    negative = request["negative_prompt"] or rules["default_negative_prompt"]
    if negative != "":
        args["negative_prompt"] = negative
    return args


def warm_up_request():
    """The body of the one request the server makes to itself before it
    opens its port."""
    return {"prompt": WARM_UP_PROMPT, "size": "512x512", "steps": 2, "seed": 0}
