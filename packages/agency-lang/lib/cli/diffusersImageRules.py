"""The rules of diffusersImageServer.py, kept apart from the server so they
can run without torch: which model families are served, which components
each family's model_index.json may name, and what a request may ask for.
CI runs these through python3; it has no torch.

Nothing here may import torch or diffusers. A test checks the imports.
"""

import random

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
]

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
#   components       every component model_index.json must name, as
#                    [library, class]. [None, None] is a slot the file
#                    lists and leaves empty.
FAMILIES = {
    "ZImagePipeline": {
        "label": "Z-Image Turbo",
        "pipeline": "ZImagePipeline",
        "default_steps": 9,
        "max_steps": 50,
        "default_guidance": 0.0,
        "takes_guidance": False,
        "components": {
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "Qwen3Model"],
            "tokenizer": ["transformers", "Qwen2Tokenizer"],
            "transformer": ["diffusers", "ZImageTransformer2DModel"],
            "vae": ["diffusers", "AutoencoderKL"],
        },
    },
    "ChromaPipeline": {
        "label": "Chroma",
        "pipeline": "ChromaPipeline",
        "default_steps": 40,
        "max_steps": 80,
        "default_guidance": 3.0,
        "takes_guidance": True,
        "components": {
            "feature_extractor": [None, None],
            "image_encoder": [None, None],
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "T5EncoderModel"],
            "tokenizer": ["transformers", "T5Tokenizer"],
            "transformer": ["diffusers", "ChromaTransformer2DModel"],
            "vae": ["diffusers", "AutoencoderKL"],
        },
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


def check_request(rules, body):
    """The checked request, with the family's defaults filled in and a
    random seed when none was given. Raises RequestError with a message
    that says what the model takes instead."""
    if not isinstance(body, dict):
        raise RequestError("The request body must be a JSON object.")
    _check_unknown_fields(body)
    _check_openai_fields(body)
    width, height = parse_size(body.get("size") or DEFAULT_SIZE)
    return {
        "prompt": _prompt_of(body),
        "width": width,
        "height": height,
        "steps": _steps_of(rules, body),
        "guidance": _guidance_of(rules, body),
        "seed": _seed_of(body),
        "negative_prompt": _negative_prompt_of(rules, body),
        "output_format": _format_of(body),
    }


def warm_up_request():
    """The body of the one request the server makes to itself before it
    opens its port."""
    return {"prompt": WARM_UP_PROMPT, "size": "512x512", "steps": 2, "seed": 0}
