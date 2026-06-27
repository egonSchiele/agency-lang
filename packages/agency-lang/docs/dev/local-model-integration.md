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
pnpm add --save=false smoltalk-llama-cpp@0.5.2

# Run the suite.
AGENCY_LLM_INTEGRATION=1 pnpm test:run tests/integration/local-model
```

First run downloads ~85 MB and takes a few minutes; subsequent runs hit the
cache and finish in seconds.

## Updating the model pin

If you change the curated `smollm2-135m` URI in `lib/stdlib/localModels.ts`,
update **two** values:

1. `EXPECTED_SHA256` in `tests/integration/local-model/smoltest.test.ts` —
   currently `null` (format-only check). The first green integration run
   prints the actual hash; paste it in to enable strict tamper-canary
   matching on subsequent runs.
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
