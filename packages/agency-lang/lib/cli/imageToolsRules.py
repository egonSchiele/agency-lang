"""The arithmetic of imageTools.py, kept apart so it runs without Pillow:
where a crop's box lands in pixels, and where each image goes on a paste
canvas. CI has python3 but not Pillow, so it tests these through
python3.

Nothing here may import PIL. A test checks the imports.
"""

# The most pixels an input image or a paste canvas may have. Pillow
# refuses a larger input with this as its MAX_IMAGE_PIXELS; a larger
# canvas is refused before it is allocated.
MAX_IMAGE_PIXELS = 100_000_000


def crop_box(x, y, w, h, pad, width, height):
    """The pixel box (left, top, right, bottom) for a normalized box on a
    `width` by `height` image, grown by `pad` of its size on every side
    and clamped to the image. Raises ValueError for a box that covers
    nothing."""
    box_w, box_h = float(w) * width, float(h) * height
    grow_x, grow_y = box_w * float(pad), box_h * float(pad)
    left = max(0.0, float(x) * width - grow_x)
    top = max(0.0, float(y) * height - grow_y)
    right = min(float(width), float(x) * width + box_w + grow_x)
    bottom = min(float(height), float(y) * height + box_h + grow_y)
    if right <= left or bottom <= top:
        raise ValueError(f"the box covers nothing of a {width}x{height} image")
    return (round(left), round(top), round(right), round(bottom))


def paste_layout(sizes, columns):
    """The canvas size and each image's top-left corner for images of
    `sizes` [(width, height), ...] in rows of `columns`. Every cell is
    the size of the largest image, and each image is centered in its
    cell. Raises ValueError for no images, fewer than one column, or a
    canvas over MAX_IMAGE_PIXELS."""
    columns = int(columns)
    if columns < 1:
        raise ValueError("columns must be at least 1")
    if not sizes:
        raise ValueError("paste needs at least one image")
    cell_w = max(width for width, _ in sizes)
    cell_h = max(height for _, height in sizes)
    rows = (len(sizes) + columns - 1) // columns
    canvas = (cell_w * columns, cell_h * rows)
    if canvas[0] * canvas[1] > MAX_IMAGE_PIXELS:
        raise ValueError(
            f"the canvas would be {canvas[0]}x{canvas[1]}, over {MAX_IMAGE_PIXELS:,} pixels. "
            "Paste fewer or smaller images."
        )
    corners = [
        (
            (index % columns) * cell_w + (cell_w - width) // 2,
            (index // columns) * cell_h + (cell_h - height) // 2,
        )
        for index, (width, height) in enumerate(sizes)
    ]
    return {"canvas": canvas, "corners": corners}
