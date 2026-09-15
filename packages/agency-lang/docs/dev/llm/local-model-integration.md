# Local-model integration tests

The fake-provider unit tests (in `lib/stdlib/localModels.test.ts`,
`lib/cli/local.test.ts`, and `tests/agency-js/local-model/`) cover the
wiring deterministically. The integration suite in
`tests/integration/local-model/` additionally exercises a **real download +
real CPU inference** path. It pulls the SmolLM2-135M GGUF from Hugging Face,
registers the `smoltalk-llama-cpp` provider, and runs a one-shot completion
(`smoltest.test.ts`). Three more files sit alongside it: `agent-flag.test.ts`
runs `agency agent --local-model smollm2-135m --print` end to end (skipped
until #1054 is fixed: the coordinator's opening prompt does not fit that
model's context),
`embed.test.ts` downloads `nomic-embed-text` and checks that
smoltalk-llama-cpp's `embed` returns 768-dimensional vectors that rank a
paraphrase above an unrelated sentence, and
`catalog-liveness.test.ts` checks that every curated model's Hugging Face URI still resolves, using manifest fetches only and no weight downloads.

## When it runs

- **CI**: on push to `main` (see `.github/workflows/local-model.yml`), and
  by hand from the Actions tab (`workflow_dispatch`) to try a change to the
  workflow or the suite on a branch before it merges. PRs do NOT run this
  suite automatically — they get the fake-provider tests in `test.yml`.
- **Locally**: gated on `AGENCY_LLM_INTEGRATION=1`, so a stray `pnpm test:run`
  never downloads a model.

## Running locally

The suite sandboxes `HOME` and `AGENCY_MODELS_DIR` to a temp dir, so it
won't write to your real `~/.agency-agent/models` or `~/agency.json`.

```bash
# In packages/agency-lang/. Install the optional provider once. It is not in
# package.json, so a normal `pnpm install` never pulls it. Keep both versions
# in step with SMOLTALK_LLAMA_CPP_VERSION and NODE_LLAMA_CPP_VERSION in
# .github/workflows/local-model.yml, which is the source of truth. (pnpm 11
# refuses `--save=false` on `add`, so this edits package.json and the
# lockfile; the last line puts them back.)
pnpm add smoltalk-llama-cpp@0.5.0 node-llama-cpp@3.20.0
git checkout package.json ../../pnpm-lock.yaml

# Run the suite (dedicated config — the default vitest run excludes tests/).
AGENCY_LLM_INTEGRATION=1 pnpm test:integration
```

First run downloads ~85 MB and takes a few minutes; subsequent runs hit the
cache and finish in seconds.

## Updating the model pin

If you change the curated `smollm2-135m` URI in `lib/stdlib/localModels.ts`,
update **two** values:

1. `EXPECTED_SHA256` in `tests/integration/local-model/smoltest.test.ts`. It
   holds the hash of the file the curated URI points at, and the test compares
   the download against it byte for byte, so a stale value fails the run.
   Recapture it from Hugging Face's LFS metadata for the new file (the git-LFS
   oid is the sha256 of the content), or take it from the log line the test
   prints. Setting it back to `null` drops the check to format-only (64 hex
   chars) and logs the observed hash, which is a way to recapture a hash you
   do not have — not a resting state to leave it in.
2. The cache key in `.github/workflows/local-model.yml`. It names both
   models (`smollm2-135m` and `nomic-embed-text`), the plugin version, and
   the node-llama-cpp version, so changing any of them, or bumping the `v2`
   suffix, starts a fresh cache that holds everything the suite downloads.

## Sandbox vs. real `$HOME`

The suite normally redirects `HOME` and `AGENCY_MODELS_DIR` to a temp dir so
a local run doesn't pollute `~/.agency-agent/models` or `~/agency.json`. Set
`AGENCY_INTEGRATION_USE_REAL_HOME=1` to disable that sandbox — the workflow
sets it so the `actions/cache` step can actually hit `~/.agency-agent/models`
on warm runs.

## Updating the `smoltalk-llama-cpp` pin

Edit `SMOLTALK_LLAMA_CPP_VERSION` in `.github/workflows/local-model.yml`,
and `NODE_LLAMA_CPP_VERSION` next to it when the plugin's node-llama-cpp
range moves. That file is the single source of truth, and the cache key
includes both. Verify the suite passes against the new versions before
merging, and make sure they are published: the workflow installs from npm.
