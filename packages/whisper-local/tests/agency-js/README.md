# agency-js tests for whisper-local

This directory is intentionally empty.

The plan (Task 13) called for a stub-JS-module test driven through the
`index.agency` wrapper. After investigation, the agency-lang repo's
`tests/agency-js/` harness compiles `.agency` files to `.js` via the agency CLI
and executes them — there is no `runAgency`-style mock harness like the plan
sketched.

The wrapper in `index.agency` is a one-line passthrough:

```
export def transcribe(filepath: string, language: string = "", model: string = "base"): string {
  return transcribeImpl(filepath, language, model)
}
```

There is nothing meaningful to test here that isn't already covered by
`tests/transcribe.test.ts` (which exercises the JS implementation directly with
the addon, ffmpeg, and modelManager all mocked) and the slow integration test
in `tests/integration.test.ts` (which exercises the full pipeline end-to-end).

Adding a heavyweight `tests/agency/` style test that compiles and runs the
`.agency` wrapper would only verify the agency-lang compiler emits a correct
function call — that's covered by agency-lang's own test suite, not ours.

If a stub-injection harness is added to agency-lang in the future, the test
sketch in the plan can be implemented here.
