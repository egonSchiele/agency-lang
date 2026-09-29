"""Pixel work the standard library needs that takes no model: crop a box
out of an image, read an image's size, paste images side by side.

Run once per call by lib/stdlib/imageTools.ts through the Python
`agency local serve` uses, since Pillow is already there and the core
package has no image library of its own. Each command is a function of
its arguments that returns one dict, printed as one JSON line. Output
files are created with mode "x": an existing file is never overwritten.

  imageTools.py crop <in> <out> <x> <y> <w> <h> <pad> <square>
  imageTools.py size <in>
  imageTools.py paste <out> <columns> <in>...

Box numbers are normalized 0..1 with the origin at the top left, the
shape std::ocr and std::vision return. The arithmetic is in
imageToolsRules.py, which CI tests without Pillow.
"""

import json
import os
import sys
import warnings

os.environ["HF_HUB_OFFLINE"] = "1"

from PIL import Image  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imageToolsRules import MAX_IMAGE_PIXELS, crop_box, paste_layout  # noqa: E402

# Pillow refuses images with more pixels than this, which guards against
# a decompression bomb. Pillow only warns between the limit and twice it,
# so the warning is an error here too.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

# The background a square pad or a paste canvas gets.
WHITE = (255, 255, 255)


def open_rgb(path):
    with open(path, "rb") as f:
        return Image.open(f).convert("RGB")


def save_new(image, path):
    """Writes with mode x, so an existing file is an error, not a loss."""
    with open(path, "xb") as f:
        image.save(f, format=format_of(path))
    return {"path": path, "width": image.width, "height": image.height}


def format_of(path):
    ext = os.path.splitext(path)[1].lower()
    return {".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}.get(ext, "PNG")


def crop(source, out, x, y, w, h, pad, square):
    """The box, grown by `pad` of its size on every side, clamped to the
    image, cut out and written. `square` pads the cut to a square with
    the edge color, so a wide crop keeps its whole width."""
    image = open_rgb(source)
    cut = image.crop(crop_box(x, y, w, h, pad, image.width, image.height))
    if square == "true":
        side = max(cut.width, cut.height)
        canvas = Image.new("RGB", (side, side), cut.getpixel((0, 0)))
        canvas.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
        cut = canvas
    return save_new(cut, out)


def dimensions(source):
    """(width, height) from the image's header, without decoding pixels."""
    with open(source, "rb") as f:
        return Image.open(f).size


def size(source):
    width, height = dimensions(source)
    return {"width": width, "height": height}


def paste(out, columns, *sources):
    """The inputs on a white canvas in rows of `columns`, each at its own
    size in a cell the size of the largest. Two inputs is a before and
    after; a folder in rows of eight is a contact sheet. The sizes are
    read first, so a canvas too large is refused before any pixels are
    decoded, and the inputs are decoded one at a time."""
    layout = paste_layout([dimensions(path) for path in sources], columns)
    canvas = Image.new("RGB", layout["canvas"], WHITE)
    for path, corner in zip(sources, layout["corners"]):
        canvas.paste(open_rgb(path), corner)
    return save_new(canvas, out)


COMMANDS = {"crop": crop, "size": size, "paste": paste}


def main(argv):
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(f"imageTools.py takes one of: {', '.join(COMMANDS)}", file=sys.stderr)
        return 2
    try:
        result = COMMANDS[argv[1]](*argv[2:])
    except (OSError, ValueError, TypeError, Image.DecompressionBombError, Image.DecompressionBombWarning) as err:
        print(str(err), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
