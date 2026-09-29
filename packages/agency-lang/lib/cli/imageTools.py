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
shape std::ocr and std::vision return.
"""

import json
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"

from PIL import Image  # noqa: E402

# Pillow refuses images with more pixels than this, which guards against
# a decompression bomb.
Image.MAX_IMAGE_PIXELS = 100_000_000

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
    width, height = image.size
    box_w, box_h = float(w) * width, float(h) * height
    grow_x, grow_y = box_w * float(pad), box_h * float(pad)
    left = max(0.0, float(x) * width - grow_x)
    top = max(0.0, float(y) * height - grow_y)
    right = min(float(width), float(x) * width + box_w + grow_x)
    bottom = min(float(height), float(y) * height + box_h + grow_y)
    if right <= left or bottom <= top:
        raise ValueError(f"the box covers nothing of a {width}x{height} image")
    cut = image.crop((round(left), round(top), round(right), round(bottom)))
    if square == "true":
        side = max(cut.width, cut.height)
        canvas = Image.new("RGB", (side, side), cut.getpixel((0, 0)))
        canvas.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
        cut = canvas
    return save_new(cut, out)


def size(source):
    with open(source, "rb") as f:
        image = Image.open(f)
        return {"width": image.width, "height": image.height}


def paste(out, columns, *sources):
    """The inputs on a white canvas in rows of `columns`, each at its own
    size in a cell the size of the largest. Two inputs is a before and
    after; a folder in rows of eight is a contact sheet."""
    columns = int(columns)
    if columns < 1:
        raise ValueError("columns must be at least 1")
    images = [open_rgb(path) for path in sources]
    if not images:
        raise ValueError("paste needs at least one image")
    cell_w = max(image.width for image in images)
    cell_h = max(image.height for image in images)
    rows = (len(images) + columns - 1) // columns
    canvas = Image.new("RGB", (cell_w * columns, cell_h * rows), WHITE)
    for index, image in enumerate(images):
        cell_x = (index % columns) * cell_w
        cell_y = (index // columns) * cell_h
        canvas.paste(image, (cell_x + (cell_w - image.width) // 2, cell_y + (cell_h - image.height) // 2))
    return save_new(canvas, out)


COMMANDS = {"crop": crop, "size": size, "paste": paste}


def main(argv):
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(f"imageTools.py takes one of: {', '.join(COMMANDS)}", file=sys.stderr)
        return 2
    try:
        result = COMMANDS[argv[1]](*argv[2:])
    except (OSError, ValueError, TypeError) as err:
        print(str(err), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
