# `agency models`

Browse the hosted model catalog and fetch fresh model data.

## `agency models list`

List hosted text models from the built-in catalog. Filterable:

```bash
agency models list                       # all models
agency models list --provider openai     # one provider
agency models list --max-price 1         # input cost <= $1 / 1M tokens
agency models list --min-context 200000  # context window >= 200k tokens
```

Columns: name, provider, open-weights, input $/1M, output $/1M, context window.

To preview a saved (or hand-edited) model-data file merged with the built-in
catalog, pass one or more files as positional arguments — handy for checking a
file before a program loads it with `loadModelData`:

```bash
agency models refresh > my-models.json          # save + hand-edit
agency models list my-models.json               # built-in catalog + your file
agency models list a.json b.json --provider acme  # multiple files accumulate; filters still apply
```

Files are merged in order (later files win on provider+name collisions, like
`loadModelData`). If a file can't be loaded, `list` prints the error and exits
non-zero instead of showing a baked-only list.

## `agency models refresh`

Fetch the latest model data and **print it as JSON to stdout**. It does not
save or register anything — redirect it to a file you control:

```bash
agency models refresh > my-models.json
# optionally override the source URL:
agency models refresh https://example.com/model-data.json > my-models.json
```

Errors go to stderr with a non-zero exit code, so a failed fetch is detectable
in a pipeline (and leaves stdout empty).

## Using a saved file

Load a saved model-data file in an Agency program with
[`std::llm.loadModelData`](../stdlib/llm.md):

```agency
import { loadModelData } from "std::llm"

node main() {
  const r = loadModelData("my-models.json")
  // r is success(count) or failure(reason)
}
```

`loadModelData` **accumulates**: multiple calls layer over each other and over
the built-in catalog, with the most recently loaded file winning on
provider+name collisions. Loaded data affects `llm()` model resolution and cost
accounting as well as `listHostedModels()` / `hostedModelInfo()`.
