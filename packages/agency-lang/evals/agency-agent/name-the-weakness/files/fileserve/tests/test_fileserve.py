import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fileserve  # noqa: E402

PUBLIC = fileserve.PUBLIC


def test_resolves_file_under_public():
    assert fileserve.resolve_path(PUBLIC, "/notes.txt") == os.path.join(os.path.realpath(PUBLIC), "notes.txt")


def test_rejects_path_traversal():
    with pytest.raises(ValueError):
        fileserve.resolve_path(PUBLIC, "/../fileserve.py")


def test_listing_escapes_html():
    page = fileserve.render_listing(["<b>x</b>.txt"])
    assert "<b>" not in page and "&lt;b&gt;" in page


def test_download_header_plain_name():
    headers = dict(fileserve.download_headers("report.csv"))
    assert headers["Content-Disposition"] == 'attachment; filename="report.csv"'


def test_download_rejects_newlines():
    with pytest.raises(ValueError):
        fileserve.download_headers("a.txt\r\nSet-Cookie: session=stolen")


def test_download_rejects_bare_linefeed():
    with pytest.raises(ValueError):
        fileserve.download_headers("a.txt\nX-Injected: 1")
