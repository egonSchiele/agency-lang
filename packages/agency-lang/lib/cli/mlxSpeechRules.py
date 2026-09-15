"""The request rules of mlxSpeechServer.py, kept apart from the server so
they can run without MLX: which model families are served, which voice
and instructions each one takes, the formats, the text limit, and the
sentence split. CI runs these through python3; it has no MLX.

Nothing here may import mlx or mlx_audio. A test checks the imports.
"""

import re

# The one mlx-audio release these rules and the server were written
# against. The server refuses any other version.
MLX_AUDIO_VERSION = "0.5.4"

# The longest text one request may carry. The Agency caller sends long
# text in pieces well under this; the limit is for a caller that skips it
# (curl) and would otherwise hold the generation lock for a long time.
MAX_TEXT_CHARS = 1000

FORMATS = {
    "wav": "audio/wav",
    "pcm": "application/octet-stream",
}

# What each family takes. One row per family the server can load; Orpheus
# is recognized by family_of so the refusal can name it, but has no row
# until it is served.
#
#   label         how the family is named in a message
#   voices        MODEL_VOICES: the loaded model lists them;
#                 a list: fixed; None: the family has no preset voices
#   default_voice used when the request names none; the first voice when
#                 this one is missing
#   instructions  "optional" or "required"
#   max_tokens    audio tokens per sentence before generation stops
MODEL_VOICES = "model"

FAMILIES = {
    "custom_voice": {
        "label": "This CustomVoice model",
        "voices": MODEL_VOICES,
        "default_voice": "ryan",
        "instructions": "optional",
        # Qwen3-TTS's default: 4096 at 12 tokens a second, about five
        # minutes. No sentence reaches it.
        "max_tokens": 4096,
    },
    "voice_design": {
        "label": "This VoiceDesign model",
        "voices": None,
        "default_voice": "",
        "instructions": "required",
        "max_tokens": 4096,
    },
}

# How a family recognized by family_of but not served yet is named in the
# refusal.
UNSERVED_FAMILIES = {"orpheus": "an Orpheus model"}

# What the server says to itself once, before it opens its port, and how a
# family that needs instructions is told to say it.
WARM_UP_TEXT = "Ready."
WARM_UP_INSTRUCTIONS = "A calm, clear voice."

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|(?<=[。！？])\s*")

# A part that ends with one of these is not a sentence; it is joined to
# the next part. Lowercase, with the period.
_ABBREVIATIONS = {"mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "jr.", "sr.", "vs.", "etc.", "e.g.", "i.e."}


class RequestError(Exception):
    """A request the server refuses. `status` is the HTTP status to answer."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def family_of(config):
    """The model family a config.json describes."""
    model_type = config.get("model_type")
    if model_type == "qwen3_tts":
        kind = config.get("tts_model_type", "base")
        if kind in ("custom_voice", "voice_design"):
            return kind
        raise RequestError(
            "mlxSpeechServer.py serves Qwen3-TTS CustomVoice and VoiceDesign models. "
            f'This is a Qwen3-TTS "{kind}" model, which needs a reference recording.'
        )
    if model_type == "llama":
        return "orpheus"
    raise RequestError(
        "mlxSpeechServer.py serves Qwen3-TTS (CustomVoice or VoiceDesign) models. "
        f'This model has model_type "{model_type}".'
    )


def join_names(names):
    if len(names) <= 1:
        return "".join(names)
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return ", ".join(names[:-1]) + ", and " + names[-1]


def _text_of(body):
    text = body.get("input")
    if not isinstance(text, str) or text.strip() == "":
        raise RequestError("input must be a non-empty string.")
    if len(text) > MAX_TEXT_CHARS:
        raise RequestError(
            f"input is {len(text)} characters; this server takes at most {MAX_TEXT_CHARS} per request."
        )
    return text


def _format_of(body):
    fmt = body.get("response_format", "wav")
    if fmt not in FORMATS:
        raise RequestError(f'response_format "{fmt}" is not supported. Use wav or pcm.')
    return fmt


def _speed_of(body):
    speed = body.get("speed", 1)
    if speed not in (1, 1.0, None):
        raise RequestError("Local speech models do not support a speed other than 1.")


def _string_field(body, name):
    value = body.get(name, "")
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RequestError(f"{name} must be a string.")
    return value


def _voice_of(rules, speakers, voice):
    """The voice to generate with, from the family's row: refused for a
    family with none, defaulted when empty, and checked against the list."""
    if rules["voices"] is None:
        if voice != "":
            raise RequestError(
                f"{rules['label']} has no preset voices. Leave voice empty and "
                "describe the voice in instructions."
            )
        return ""
    voices = speakers if rules["voices"] == MODEL_VOICES else rules["voices"]
    if voice == "":
        return rules["default_voice"] if rules["default_voice"] in voices else voices[0]
    # Speaker names are lowercase, and the model lowercases the one it is
    # given, so "Ryan" is ryan.
    if voice.lower() not in voices:
        raise RequestError(
            f'"{voice}" is not a voice of this model. Its voices are {join_names(voices)}.'
        )
    return voice.lower()


def _instructions_of(rules, instructions):
    """The instructions to generate with, from the family's row."""
    if rules["instructions"] == "required" and instructions == "":
        raise RequestError(
            f"{rules['label']} needs instructions describing the voice, "
            'such as "A deep, slow voice."'
        )
    return instructions


def check_request(family, speakers, body):
    """The checked request: text, voice, instructions, and format. Raises
    RequestError with a message that says what the model takes instead."""
    rules = FAMILIES.get(family)
    if rules is None:
        raise RequestError(f"{family} is not a family this server serves.", status=500)
    _speed_of(body)
    return {
        "text": _text_of(body),
        "voice": _voice_of(rules, speakers, _string_field(body, "voice")),
        "instructions": _instructions_of(rules, _string_field(body, "instructions")),
        "format": _format_of(body),
    }


def warm_up_request(family):
    """The body of the one request the server makes to itself before it
    opens its port: the family's default voice, and instructions only when
    the family cannot speak without them."""
    body = {"input": WARM_UP_TEXT, "response_format": "wav"}
    if FAMILIES[family]["instructions"] == "required":
        body["instructions"] = WARM_UP_INSTRUCTIONS
    return body


def _ends_with_abbreviation(part):
    return part.rsplit(None, 1)[-1].lower() in _ABBREVIATIONS


def split_sentences(text):
    """The sentences of `text`, for generating one at a time. Splits after
    ., !, ?, and their full-width forms, except after a known abbreviation.
    Text with no such mark is one sentence."""
    parts = [part.strip() for part in _SENTENCE_END.split(text.strip()) if part.strip() != ""]
    sentences = []
    for part in parts:
        if sentences and _ends_with_abbreviation(sentences[-1]):
            sentences[-1] = f"{sentences[-1]} {part}"
        else:
            sentences.append(part)
    return sentences
