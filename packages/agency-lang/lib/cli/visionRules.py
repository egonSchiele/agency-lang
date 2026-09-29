"""The rules of visionServer.py, kept apart from the server so they can run
without torch or onnxruntime: which model families are served, what
identifies each, which routes each answers, and what a request may ask
for. CI runs these through python3; it has neither library.

Nothing here may import torch, transformers, or onnxruntime. A test
checks the imports.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from localServerCommon import ImagePathError, check_image_path  # noqa: E402

# The releases these rules and the server were written against. The server
# refuses any other, because it reaches into each library's processor and
# model classes.
TRANSFORMERS_VERSION = "5.17.0"
ONNXRUNTIME_VERSION = "1.30.0"

# A request body is a path and a few settings. Anything bigger is not a
# request this server makes sense of.
MAX_BODY_BYTES = 64 * 1024

# An open-vocabulary detector takes the labels as text. Fifty is a long
# list already; a longer one is a sign the caller wants "everything", and
# the detector has no such mode.
MAX_LABELS = 50
MAX_LABEL_CHARS = 64

# The most tags one request may ask for. The WD14 vocabulary has about ten
# thousand; a caption wants thirty.
MAX_TAG_LIMIT = 500
DEFAULT_TAG_LIMIT = 30

# Scores below this are left out. The detection default is the value
# Florence-2's own examples use; the tag default is the WD14 model card's.
DEFAULT_THRESHOLD = {"detections": 0.3, "tags": 0.35}

# Route name -> path. A family lists the route names it answers.
ROUTES = {
    "detections": "/v1/vision/detections",
    "tags": "/v1/vision/tags",
    "captions": "/v1/vision/captions",
}

# The fields every request carries, and the fields each route adds.
# `model` is the front door's routing field.
COMMON_FIELDS = ["model", "image"]
ROUTE_FIELDS = {
    "detections": ["labels", "threshold"],
    "tags": ["threshold", "limit"],
    "captions": ["detail"],
}
DETAILS = ["short", "long"]

# What each family is and does. One row per family, flat: one key per
# value, so a test can compare a row to a literal.
#
#   label      how the family is named in a message
#   engine     the library that runs it: "onnxruntime" or "transformers"
#   runner     the class in visionServer.py that answers its routes
#   identify_* what marks a directory as this family: a file beside
#              another, or the first entry of config.json's architectures
#   routes     the route names it answers
#   task_*     for a Florence-2 model, the task token each route sends
FAMILIES = {
    "wd14": {
        "label": "WD14 tagger",
        "engine": "onnxruntime",
        "runner": "Wd14Runner",
        "identify_file": "model.onnx",
        "identify_beside": "selected_tags.csv",
        "routes": ["tags"],
    },
    "Florence2ForConditionalGeneration": {
        "label": "Florence-2",
        "engine": "transformers",
        "runner": "Florence2Runner",
        "identify_architecture": "Florence2ForConditionalGeneration",
        "routes": ["detections", "tags", "captions"],
        "task_detections": "<OPEN_VOCABULARY_DETECTION>",
        "task_tags": "<DENSE_REGION_CAPTION>",
        "task_caption_short": "<CAPTION>",
        "task_caption_long": "<MORE_DETAILED_CAPTION>",
    },
}


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


def _identifies(rules, names, config):
    if "identify_file" in rules:
        return rules["identify_file"] in names and rules["identify_beside"] in names
    architectures = config.get("architectures") if isinstance(config, dict) else None
    first = architectures[0] if isinstance(architectures, list) and architectures else None
    return first == rules["identify_architecture"]


def family_of(names, config):
    """The family row for a model directory, from its file names and its
    config.json (or None). Raises ValueError naming what did not match,
    because the engine imports whatever the config names, and only the
    rows here are allowed."""
    for rules in FAMILIES.values():
        if _identifies(rules, names, config):
            return rules
    labels = join_names([rules["label"] for rules in FAMILIES.values()])
    raise ValueError(
        f"visionServer.py serves {labels} models. This directory has neither model.onnx "
        f"beside selected_tags.csv nor a config.json naming Florence2ForConditionalGeneration."
    )


def route_of_path(path):
    """The route name a request path is for, or None."""
    for name, route_path in ROUTES.items():
        if path == route_path:
            return name
    return None


def route_paths(rules):
    """The paths a family answers, for /health and the 404."""
    return [ROUTES[name] for name in rules["routes"]]


def _is_number(value):
    # Python counts True as 1, and a threshold of true is not a threshold of 1.
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _is_integer(value):
    return not isinstance(value, bool) and isinstance(value, int)


def _image_of(body):
    try:
        return check_image_path(body.get("image"))
    except ImagePathError as err:
        raise RequestError(str(err))


def _labels_of(body):
    labels = body.get("labels")
    if not isinstance(labels, list) or not labels:
        raise RequestError(
            'labels must be a list of the things to look for, such as ["person", "desk"]. '
            "A detector with no labels finds whatever it likes."
        )
    if len(labels) > MAX_LABELS:
        raise RequestError(f"labels may hold at most {MAX_LABELS} names. Got {len(labels)}.")
    for label in labels:
        if not isinstance(label, str) or label.strip() == "" or len(label) > MAX_LABEL_CHARS:
            raise RequestError(
                f"Each label must be a non-empty string of at most {MAX_LABEL_CHARS} characters. "
                f"Got {label!r}."
            )
    return [label.strip() for label in labels]


def _threshold_of(route, body):
    threshold = body.get("threshold")
    if threshold is None:
        return DEFAULT_THRESHOLD[route]
    if not _is_number(threshold) or threshold < 0 or threshold > 1:
        raise RequestError(
            f"threshold must be a number from 0 to 1. The default is {DEFAULT_THRESHOLD[route]}."
        )
    return float(threshold)


def _limit_of(body):
    limit = body.get("limit")
    if limit is None:
        return DEFAULT_TAG_LIMIT
    if not _is_integer(limit) or limit < 1 or limit > MAX_TAG_LIMIT:
        raise RequestError(
            f"limit must be a whole number from 1 to {MAX_TAG_LIMIT}. The default is {DEFAULT_TAG_LIMIT}."
        )
    return limit


def _detail_of(body):
    detail = body.get("detail")
    if detail is None:
        return DETAILS[0]
    if detail not in DETAILS:
        raise RequestError(f'detail must be {join_names(DETAILS, "or")}. Got {detail!r}.')
    return detail


def _check_fields(route, body):
    allowed = COMMON_FIELDS + ROUTE_FIELDS[route]
    unknown = sorted(key for key in body if key not in allowed)
    if unknown:
        raise RequestError(
            f"{join_names(unknown)} {'is' if len(unknown) == 1 else 'are'} not "
            f"{'a setting' if len(unknown) == 1 else 'settings'} of {ROUTES[route]}. "
            f"It takes {join_names(allowed[1:])}."
        )


def check_request(rules, route, body):
    """The checked request for one route: the image's path and the route's
    settings with defaults filled in. Raises RequestError with a message
    that says what the route takes instead, or 404 for a route the family
    does not answer."""
    if route not in rules["routes"]:
        raise RequestError(
            f"{rules['label']} does not answer {ROUTES[route]}. It answers "
            f"{join_names(route_paths(rules))}.",
            status=404,
        )
    if not isinstance(body, dict):
        raise RequestError("The request body must be a JSON object.")
    _check_fields(route, body)
    checked = {"image": _image_of(body)}
    if route == "detections":
        checked["labels"] = _labels_of(body)
        checked["threshold"] = _threshold_of(route, body)
    elif route == "tags":
        checked["threshold"] = _threshold_of(route, body)
        checked["limit"] = _limit_of(body)
    else:
        checked["detail"] = _detail_of(body)
    return checked


def warm_up_request(rules, image_path):
    """The route and body of the one request the server makes to itself
    before it opens its port: the family's first route, on a small image
    the server drew."""
    route = rules["routes"][0]
    body = {"image": image_path}
    if route == "detections":
        body["labels"] = ["square"]
    return route, body


def normalized_box(box, width, height):
    """A pixel box [x1, y1, x2, y2] as {x, y, width, height} in 0..1 with the
    origin at the top left, clamped to the image. The shape std::ocr
    returns, so either box can go to cropImage."""
    x1, y1, x2, y2 = (float(v) for v in box)
    left = min(max(x1, 0.0), width)
    top = min(max(y1, 0.0), height)
    right = min(max(x2, 0.0), width)
    bottom = min(max(y2, 0.0), height)
    return {
        "x": left / width,
        "y": top / height,
        "width": max(right - left, 0.0) / width,
        "height": max(bottom - top, 0.0) / height,
    }
