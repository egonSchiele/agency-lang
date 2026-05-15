# Agency memory tests

These tests exercise the memory layer end-to-end through `.agency` code.
Because the memory subsystem makes real LLM calls (extraction, recall,
compaction), the tests need a deterministic LLM provider to stay
hermetic and free.

## Running

Set `AGENCY_USE_TEST_LLM_PROVIDER=1` so the runtime picks up the
deterministic mock client and the per-test JSON fixture is read for
canned responses:

```bash
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/memory/
```

Without the env var the deterministic client is *not* registered and
each `llm()` / `embed()` call inside the memory pipeline would hit a
real provider — slow, expensive, and non-deterministic. The runner
will print a warning if it sees a memory test running without the
flag set.

## Files per test

Each `.agency` test typically has:

- `<name>.agency` — the test program
- `<name>.test.json` — the test definitions (assertions, expected
  outcomes)
- `<name>.js` — optional canned LLM responses keyed by call site,
  loaded automatically when `AGENCY_USE_TEST_LLM_PROVIDER=1`
- shared `agency.json` in this directory — directory-scoped config
  override that opts into the memory layer (merged on top of the
  project-level config by `lib/cli/test.ts`)
