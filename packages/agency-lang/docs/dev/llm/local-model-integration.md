# Local-model integration tests

The fake-provider unit tests (in `lib/stdlib/localModels.test.ts`,
`lib/cli/local.test.ts`, and `tests/agency-js/local-model/`) cover the
wiring deterministically. The integration suite in
`tests/integration/local-model/` additionally exercises a **real download +
real CPU inference** path: it pulls the ~85 MB SmolLM2-135M GGUF from
Hugging Face, registers `node-llama-cpp`, runs a one-shot completion, and
verifies the agent's `--local-model` flag end-to-end.

## When it runs

- **CI**: only on push to `main` (see `.github/workflows/local-model.yml`).
  PRs do NOT run this suite — they get the fake-provider tests in `test.yml`.
- **Locally**: gated on `AGENCY_LLM_INTEGRATION=1`, so a stray `pnpm test:run`
  never downloads a model.

## Running locally

The suite sandboxes `HOME` and `AGENCY_MODELS_DIR` to a temp dir, so it
won't write to your real `~/.agency-agent/models` or `~/agency.json`.

```bash
# In packages/agency-lang/. Install the optional provider (one-time; not in
# package.json, so this doesn't affect normal `pnpm install`).
# Keep the version in step with SMOLTALK_LLAMA_CPP_VERSION in
# .github/workflows/local-model.yml, which is the source of truth.
pnpm add --save=false smoltalk-llama-cpp@0.4.0

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
2. The cache key in `.github/workflows/local-model.yml` (bump the `v1` suffix
   or change the model identifier in the key).

## Sandbox vs. real `$HOME`

The suite normally redirects `HOME` and `AGENCY_MODELS_DIR` to a temp dir so
a local run doesn't pollute `~/.agency-agent/models` or `~/agency.json`. Set
`AGENCY_INTEGRATION_USE_REAL_HOME=1` to disable that sandbox — the workflow
sets it so the `actions/cache` step can actually hit `~/.agency-agent/models`
on warm runs.

## Updating the `smoltalk-llama-cpp` pin

Edit `SMOLTALK_LLAMA_CPP_VERSION` in `.github/workflows/local-model.yml`.
That's the single source of truth. Verify the suite passes against the new
version before merging.
