# fileserve

A static file server for a `public/` directory, standard library only.

- `GET /<path>` returns the file as text.
- `GET /<path>?download=<name>` returns it as an attachment saved as `<name>`.
- `GET /<dir>/` lists the directory.

Run the tests with `pytest -q fileserve/tests`.
