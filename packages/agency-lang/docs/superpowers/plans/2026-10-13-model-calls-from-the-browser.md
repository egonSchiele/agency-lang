# Model calls from the browser, and the browser entry an app uses

Written 2026-10-13. The next step after PR F4 (#1194). It finishes
`docs/dev/runtime/running-without-node.md`, whose "What is left" section is
out of date: smoltalk 0.17.0 bundles for the browser, and Agency already
depends on it, but the browser smoke bundle still points `smoltalk` at a
throwing stand-in. So no program has called a model from a page through
Agency. BMO, the first app to run in a web view, needs exactly that.

## Goal

A compiled Agency program, bundled with esbuild under `--platform=browser`,
calls a hosted model (Gemini, OpenAI, Anthropic) from a page, with the API
key supplied by the app through the host, and the Chromium test proves it.

## What is in the way

1. **The stand-in.** `scripts/bundle-browser-smoke.mjs` aliases `smoltalk`
   to `tests/browser/shims/smoltalk.mjs`. Removing the alias is the change;
   the question is what then fails to bundle.
2. **`@anthropic-ai/sdk` does `await import("node:fs")`** on its
   credential-file path, taken when no key is passed. smoltalk's own check
   bundles with `--external:node:*` for this. Agency's smoke check instead
   fails on any Node import, which is the stricter and better rule. The two
   have to agree.
3. **Keys reach smoltalk through its own `env()`,** which answers
   `undefined` in a browser. The runtime's `createLlmClient` in
   `lib/runtime/llmClient.ts` already merges a per-provider `apiKey` map
   into `SmolConfig`, but nothing fills that map from `host.settings`. On
   Node the gap is invisible because smoltalk reads `process.env` itself.
4. **`process` and `child_process` shims** for tarsec and typestache stay.
   They are not smoltalk's problem.
5. **The `llm` capability** is checked by `requireCapabilities` on a model
   call. The browser host has it. Nothing to do, but the test should show
   a host built without `llm` refusing the call.

## Design

The rule from running-without-node.md: one implementation for both
targets, with the difference confined to the six listed places. None of
this needs a seventh.

**Keys come from the host's settings.** When the runtime builds a smoltalk
client, it reads each provider's key name (`GEMINI_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the rest of the list in
smoltalk's `lib/util/provider.ts`) through `host.settings.read` and passes
the ones that are set in the `apiKey` map. An explicit `apiKey` from the
caller still wins. On Node `settings.read` is `process.env`, so behaviour
is unchanged. In a browser the app passes `variables: { GEMINI_API_KEY }`
to `browserHost` and the key arrives the same way. smoltalk's own `env()`
fallback is then never needed on either platform.

The list of key names lives in one place. smoltalk should export it (a
small smoltalk change, `PROVIDER_KEY_VARIABLES` or similar); until it
does, Agency keeps a copy with a test that compares it against smoltalk's
`provider.ts` by calling `resolveApiKey` with a fake `env`.

**The smoke check keeps its strict rule.** A browser bundle of Agency must
not import a Node module. If `@anthropic-ai/sdk`'s dynamic `node:fs`
import is the only offender, mark that one specifier external in the smoke
script with a comment naming the SDK path that takes it, and assert that
the bundle has no other Node import. Do not switch to `--external:node:*`
wholesale: that would hide the next regression.

**The test calls a real model.** `tests/browser/browser.test.ts` gains a
second case, skipped without `GEMINI_API_KEY` in the environment, that
runs a program with one `llm()` call through `browserHost({ variables })`
and checks the reply. CI has the key for the other real-model tests; use
the same guard they use.

## Tasks

### Task 1: drop the alias and see what breaks

Remove `--alias:smoltalk=...` from `scripts/bundle-browser-smoke.mjs`,
delete `tests/browser/shims/smoltalk.mjs`, run the script. Fix each Node
import it reports, in this order: inside Agency's `lib/`, by moving the
code behind the host; inside smoltalk, by a smoltalk PR; inside a
third-party SDK, by the one named external. Record what was found in the
PR description.

### Task 2: keys from the host

In `lib/runtime/llmClient.ts`, where `SmolConfig` is assembled, add
`apiKeysFromSettings(host.settings)`. Unit test with a `memoryHost` whose
variables hold two keys and check the map that reaches smoltalk. Check
the generated header passes the run's host here; the function already has
the run, since the explicit-run change.

### Task 3: the Chromium model call

The second test case described above, plus a case where
`browserHost({ capabilities: ["network", "env", "terminal"] })` refuses
the call with the `llm` capability message.

### Task 4: the browser entry an app imports

`tests/browser/entry.mjs` is a test fixture. An app needs the same thing
as a documented export: `agency-lang/host-lib/browserHost.js` is already
reachable, so this task is a doc, not code. Add a section to
`docs/dev/runtime/host.md` under "The browser" showing the three lines an
app writes: build the host with its variables and terminal, call
`main({ host })`, and bundle with `--platform=browser`. Include the
`process` shim esbuild needs for tarsec and typestache, which is the part
an app author cannot guess.

### Task 5: docs

Rewrite "What is left" in `running-without-node.md`. After this plan the
list is: the callbacks that are not handed a handle, and nothing else
about the browser. Note smoltalk 0.17.0 as the version that bundles.

## Verification

- `node scripts/bundle-browser-smoke.mjs` passes with no alias.
- `pnpm vitest run tests/browser` with `GEMINI_API_KEY` set passes both
  cases; without the key, the model case is skipped and the rest pass.
- `pnpm vitest run lib/runtime/llmClient.test.ts` for task 2.

## Out of scope

- A model running in the page (WebGPU, transformers.js). That is a new
  provider, and BMO's local-model track decides whether it is wanted.
- Sign in with ChatGPT. It is an OAuth flow in the app that ends with a
  token, and the token reaches smoltalk through the same `apiKey` map. If
  OpenAI's subscription endpoint needs a different base URL or header,
  that is a smoltalk change and a later plan.
- The `agency serve` and remote paths. Unchanged.

## Outcome

Done 2026-10-13. What the tasks found that the plan did not expect:

- smoltalk 0.17.0 bundles, but its `embed/ollama.js` imports ollama's Node build by name instead of through its `#ollama` entry, and its own browser check does not notice because the offending import is inside `node_modules`. The smoke script aliases `ollama` to `ollama/browser` until smoltalk fixes it.
- `@anthropic-ai/sdk` imports `node:path` dynamically as well as `node:fs`. Both are external, and the check allows them only as dynamic imports.
- The generated header already reads every key variable through the host, but through the module's default host at load time, and bakes `""` for each miss. In a page that is every slot, and those empty strings shadowed the run's host's keys. `withHostKeys` treats an empty slot as unset.
- Nothing checked the `llm` capability on a model call, so the refusal case in task 3 needed a `requireCapabilities` call at the top of `runPrompt`, not just a test.
- CI's model key is `OPENAI_API_KEY`, not `GEMINI_API_KEY`, so the real call goes to OpenAI.
