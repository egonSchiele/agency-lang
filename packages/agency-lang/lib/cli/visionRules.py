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
from imageToolsRules import crop_box  # noqa: E402
from localServerCommon import MAX_IMAGE_BYTES, ImageDataError, base64_length, image_bytes_of  # noqa: E402

# The releases these rules and the server were written against. The server
# refuses any other, because it reaches into each library's processor and
# model classes.
TRANSFORMERS_VERSION = "5.17.0"
ONNXRUNTIME_VERSION = "1.30.0"

# The most boxes a reply holds, and the most an embeddings request takes,
# so every box of one reply can be embedded in one request.
MAX_REPLY_BOXES = 100

# A request body is one image as base64 and a few settings. Anything
# bigger is not a request this server makes sense of.
MAX_SETTINGS_BYTES = 64 * 1024
MAX_BODY_BYTES = base64_length(MAX_IMAGE_BYTES) + MAX_SETTINGS_BYTES

# Two boxes that overlap by more than this much (intersection over union)
# are one object, and the lower-scoring one is dropped. 0.3 is the value
# transformers uses for the same job. KEEP_OVERLAPS is more than any two
# boxes can overlap, so nothing is dropped.
MERGE_IOU = 0.3
KEEP_OVERLAPS = 1.0

# How many of the best-scoring boxes kept_boxes considers. OWLv2 predicts
# 3,600 boxes for every image; the merge compares each kept box with each
# candidate, so it gets a bounded amount of work.
MAX_MERGE_CANDIDATES = 500

# A box over the whole image, in the normalized shape. An embeddings
# request with no boxes embeds this one.
WHOLE_IMAGE = {"x": 0, "y": 0, "width": 1, "height": 1}

# An open-vocabulary detector takes the labels as text. Fifty is a long
# list already; a longer one is a sign the caller wants "everything", and
# the detector has no such mode.
MAX_LABELS = 50
MAX_LABEL_CHARS = 64

# The fields every request carries. `model` is the front door's routing
# field.
COMMON_FIELDS = ["model", "image"]
DETAILS = ["short", "long"]

# What each route is. One row per route; a family lists the route names it
# answers.
#
#   path               where the route is served
#   fields             the fields the route takes beside COMMON_FIELDS, each
#                      checked by its entry in FIELD_CHECKS, in this order
#   default_threshold  the threshold a request gets when it gives none. A
#                      family's own `default_threshold_<route>` wins over it.
#   limit_max          the largest `limit` a request may ask for
#   limit_default      the `limit` a request gets when it gives none
ROUTE_TABLE = {
    "detections": {
        "path": "/v1/vision/detections",
        "fields": ["labels", "threshold"],
    },
    "tags": {
        "path": "/v1/vision/tags",
        "fields": ["threshold", "limit"],
        # The WD14 model card's threshold.
        "default_threshold": 0.35,
        # The WD14 vocabulary has about ten thousand tags; a caption wants
        # thirty.
        "limit_max": 500,
        "limit_default": 30,
    },
    "captions": {
        "path": "/v1/vision/captions",
        "fields": ["detail"],
    },
    "embeddings": {
        "path": "/v1/vision/embeddings",
        "fields": ["boxes"],
    },
    "regions": {
        "path": "/v1/vision/regions",
        "fields": ["limit"],
        "limit_max": MAX_REPLY_BOXES,
        "limit_default": 50,
    },
}

# What each family is and does. One row per family, flat: one key per
# value, so a test can compare a row to a literal.
#
#   label      how the family is named in a message
#   engine     the library that runs it: "onnxruntime" or "transformers"
#   runner     the class in visionServer.py that answers its routes
#   identify_* what marks a directory as this family: a file beside
#              another, or the first entry of config.json's architectures
#   routes     the route names it answers
#   default_threshold_<route>
#              the threshold a request on that route gets when it gives
#              none, when this family's scores need their own. Every family
#              that answers detections has one.
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
        "routes": ["detections", "tags", "captions", "regions"],
        # The value Florence-2's own examples use. Florence-2 gives no
        # scores, so it drops nothing.
        "default_threshold_detections": 0.3,
        "task_detections": "<OPEN_VOCABULARY_DETECTION>",
        "task_tags": "<DENSE_REGION_CAPTION>",
        "task_caption_short": "<CAPTION>",
        "task_caption_long": "<MORE_DETAILED_CAPTION>",
        "task_regions": "<REGION_PROPOSAL>",
    },
    "Dinov2Model": {
        "label": "DINOv2",
        "engine": "transformers",
        "runner": "Dinov2Runner",
        "identify_architecture": "Dinov2Model",
        "routes": ["embeddings"],
    },
    "Owlv2ForObjectDetection": {
        "label": "OWLv2",
        "engine": "transformers",
        "runner": "Owlv2Runner",
        "identify_architecture": "Owlv2ForObjectDetection",
        "routes": ["detections", "regions"],
        # The OWLv2 model card's threshold. A real object often scores 0.2
        # to 0.4, so Florence-2's 0.3 would drop many.
        "default_threshold_detections": 0.1,
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
    marks = [
        f"{rules['identify_file']} beside {rules['identify_beside']}"
        for rules in FAMILIES.values()
        if "identify_file" in rules
    ]
    architectures = [rules["identify_architecture"] for rules in FAMILIES.values() if "identify_architecture" in rules]
    marks.append(f"a config.json naming {join_names(architectures, 'or')}")
    raise ValueError(
        f"visionServer.py serves {labels} models. This directory has none of "
        f"{join_names(marks, 'or')}."
    )


def route_of_path(path):
    """The route name a request path is for, or None."""
    for name, row in ROUTE_TABLE.items():
        if path == row["path"]:
            return name
    return None


def route_paths(rules):
    """The paths a family answers, for /health and the 404."""
    return [ROUTE_TABLE[name]["path"] for name in rules["routes"]]


def default_threshold(rules, route):
    """The threshold a request on `route` gets when it gives none: the
    family's own when its row has one, else the route's."""
    return rules.get(f"default_threshold_{route}", ROUTE_TABLE[route].get("default_threshold"))


def _is_number(value):
    # Python counts True as 1, and a threshold of true is not a threshold of 1.
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _is_integer(value):
    return not isinstance(value, bool) and isinstance(value, int)


def _image_of(body):
    try:
        return image_bytes_of(body.get("image"))
    except ImageDataError as err:
        raise RequestError(str(err))


def _labels_of(rules, route, body):
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


def _threshold_of(rules, route, body):
    default = default_threshold(rules, route)
    threshold = body.get("threshold")
    if threshold is None:
        return default
    if not _is_number(threshold) or threshold < 0 or threshold > 1:
        raise RequestError(f"threshold must be a number from 0 to 1. The default is {default}.")
    return float(threshold)


def _limit_of(rules, route, body):
    row = ROUTE_TABLE[route]
    limit = body.get("limit")
    if limit is None:
        return row["limit_default"]
    if not _is_integer(limit) or limit < 1 or limit > row["limit_max"]:
        raise RequestError(
            f"limit must be a whole number from 1 to {row['limit_max']}. "
            f"The default is {row['limit_default']}."
        )
    return limit


def _detail_of(rules, route, body):
    detail = body.get("detail")
    if detail is None:
        return DETAILS[0]
    if detail not in DETAILS:
        raise RequestError(f'detail must be {join_names(DETAILS, "or")}. Got {detail!r}.')
    return detail


def _box_problem(box):
    """Why `box` is not a normalized box, or None."""
    if not isinstance(box, dict) or sorted(box) != ["height", "width", "x", "y"]:
        return "must be {x, y, width, height}"
    if not all(_is_number(box[key]) and 0 <= box[key] <= 1 for key in box):
        return "must hold numbers from 0 to 1"
    if box["width"] <= 0 or box["height"] <= 0:
        return "must have a width and a height above 0"
    return None


def _boxes_of(rules, route, body):
    """The boxes to embed. None or a missing field is the whole image, so
    the runner has one path; an empty list is no boxes at all."""
    boxes = body.get("boxes")
    if boxes is None:
        return [WHOLE_IMAGE]
    if not isinstance(boxes, list):
        raise RequestError("boxes must be a list of {x, y, width, height} boxes in 0..1, or null for the whole image.")
    if len(boxes) > MAX_REPLY_BOXES:
        raise RequestError(f"boxes may hold at most {MAX_REPLY_BOXES}. Got {len(boxes)}.")
    for index, box in enumerate(boxes):
        problem = _box_problem(box)
        if problem is not None:
            raise RequestError(f"boxes[{index}] {problem}.")
    return [{key: float(box[key]) for key in ("x", "y", "width", "height")} for box in boxes]


# The one function that checks each field a route may take. Each takes
# (rules, route, body) and returns the field's checked value, or raises
# RequestError saying what the field takes.
FIELD_CHECKS = {
    "labels": _labels_of,
    "threshold": _threshold_of,
    "limit": _limit_of,
    "detail": _detail_of,
    "boxes": _boxes_of,
}


def _check_fields(route, body):
    allowed = COMMON_FIELDS + ROUTE_TABLE[route]["fields"]
    unknown = sorted(key for key in body if key not in allowed)
    if unknown:
        raise RequestError(
            f"{join_names(unknown)} {'is' if len(unknown) == 1 else 'are'} not "
            f"{'a setting' if len(unknown) == 1 else 'settings'} of {ROUTE_TABLE[route]['path']}. "
            f"It takes {join_names(allowed[1:])}."
        )


def check_request(rules, route, body):
    """The checked request for one route: the image's bytes and the route's
    settings with defaults filled in. Raises RequestError with a message
    that says what the route takes instead, or 404 for a route the family
    does not answer."""
    if route not in rules["routes"]:
        raise RequestError(
            f"{rules['label']} does not answer {ROUTE_TABLE[route]['path']}. It answers "
            f"{join_names(route_paths(rules))}.",
            status=404,
        )
    if not isinstance(body, dict):
        raise RequestError("The request body must be a JSON object.")
    _check_fields(route, body)
    checked = {"image": _image_of(body)}
    for field in ROUTE_TABLE[route]["fields"]:
        checked[field] = FIELD_CHECKS[field](rules, route, body)
    return checked


def warm_up_request(rules, image_base64):
    """The route and body of the one request the server makes to itself
    before it opens its port: the family's first route, on a small image
    the server drew."""
    route = rules["routes"][0]
    body = {"image": image_base64}
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


def box_pixels(box, width, height, index):
    """The pixel rectangle (left, top, right, bottom) of normalized box
    number `index` on a `width` by `height` image. Raises RequestError
    for a box that covers less than a pixel once it is rounded."""
    try:
        left, top, right, bottom = crop_box(box["x"], box["y"], box["width"], box["height"], 0, width, height)
    except ValueError:
        right = left = 0
        top = bottom = 0
    if right <= left or bottom <= top:
        raise RequestError(f"boxes[{index}] covers less than a pixel of the {width}x{height} image.")
    return left, top, right, bottom


def square_padding(width, height):
    """The side of the square a `width` by `height` crop is padded to, and
    the (left, top) offset that centers the crop in it."""
    side = max(width, height)
    return side, ((side - width) // 2, (side - height) // 2)


def square_box_to_image(box, width, height):
    """A box [x1, y1, x2, y2] in 0..1 of the square OWLv2 padded a `width`
    by `height` image to, as a normalized box on the image itself, or None
    when it lay wholly in the padding. OWLv2 pads on the bottom and the
    right, so scaling by the longer side gives pixels."""
    side = max(width, height)
    found = normalized_box([value * side for value in box], width, height)
    if found["width"] <= 0 or found["height"] <= 0:
        return None
    return found


def _overlap(a, b):
    """Intersection over union of two normalized boxes."""
    left = max(a["x"], b["x"])
    top = max(a["y"], b["y"])
    right = min(a["x"] + a["width"], b["x"] + b["width"])
    bottom = min(a["y"] + a["height"], b["y"] + b["height"])
    inter = max(right - left, 0.0) * max(bottom - top, 0.0)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def _best_candidates(scores, threshold):
    """The indexes scoring at or above `threshold`, best first, with the
    index breaking ties, cut to MAX_MERGE_CANDIDATES."""
    passing = [index for index, score in enumerate(scores) if score >= threshold]
    passing.sort(key=lambda index: (-scores[index], index))
    return passing[:MAX_MERGE_CANDIDATES]


def merge_overlapping(candidates, iou, limit):
    """`candidates` in order, each kept unless it overlaps an already kept
    one by more than `iou`, stopping once `limit` are kept."""
    kept = []
    for candidate in candidates:
        if len(kept) == limit:
            break
        if all(_overlap(candidate["box"], other["box"]) <= iou for other in kept):
            kept.append(candidate)
    return kept


def kept_boxes(scores, boxes, width, height, threshold, iou, limit):
    """The boxes of a reply, best first.

    scores[i] is the score of boxes[i]. Each box is [x1, y1, x2, y2] in
    0..1 of the square OWLv2 padded the image to. Returns dicts
    {"index", "score", "box"}, where index is the box's position in the
    input and box is normalized to the image itself. Boxes below
    `threshold` and boxes wholly in the padding are left out, a box that
    overlaps a better one by more than `iou` is dropped, and at most
    `limit` are kept."""
    candidates = []
    for index in _best_candidates(scores, threshold):
        box = square_box_to_image(boxes[index], width, height)
        if box is not None:
            candidates.append({"index": index, "score": float(scores[index]), "box": box})
    return merge_overlapping(candidates, iou, limit)
