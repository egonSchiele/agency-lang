# Local-Model Support via Custom Provider Modules — Design

**Date:** 2026-06-16
**Status:** Approved design, ready for implementation plan
**Related:** This is requirement #5 of the user-selectable-models effort (model *selection* shipped in PRs #298/#301). This spec covers only the remaining piece: registering a custom/local LLM provider at runtime.

## Goal

Let a user run the Agency agent (and any Agency program) against a **local model** served by a globally-installed `smoltalk-llama-cpp`, **without** making `agency-lang` depend on `smoltalk-llama-cpp`, without editing the prebuilt agent binary, and within the codebase's import rules.

## Background & key facts

Model *selection* already works: `--provider`/`--model` flags, `setModel`, `setLlmOptions({ provider })`, and per-call `llm({ provider, model, ... })`. So the only missing capability is **getting a custom provider class registered with smoltalk** before the first `llm()` call.

Established facts (verified against the current tree):

- **smoltalk's provider registry is the seam.** `smoltalk.registerProvider(name, ClientClass)` adds a provider to a *module-level* registry; `getClient(config)` resolves a provider via `resolveProvider(model, explicitProvider)` and, for unknown providers, looks them up in that registry (`node_modules/smoltalk/dist/client.js`).
- **smoltalk uses registered classes structurally**, with **no `instanceof BaseClient` check** — it does `new ClientClass(config)` then calls duck-typed methods. A class built against a *different* smoltalk copy works once registered into ours.
- **`smoltalk-llama-cpp` exports a `LlamaCPP` class and does not auto-register.** Documented usage: `registerProvider("llama-cpp", LlamaCPP)`. It declares **smoltalk as a peer dependency** and depends on `node-llama-cpp`.
- **`node-llama-cpp` is ESM-only** (`"type": "module"`, no `require` export, Node ≥20). Therefore `createRequire()` cannot reliably load this dependency graph; `await import()` can, on every supported Node.
- **`runNode` (`lib/runtime/node.ts`) is the universal execution entry.** It is imported into every compiled program (`imports.mustache`) and is what direct runs, `serve` standalones, packed `.mjs` artifacts, and subprocess IPC all call. It runs `__initAllRegistered(execCtx)` (line 209) before any user code, global-init, or `llm()` call.
- **Per-call `llm({...})` options already pass through to the smoltalk client config** — `clientConfig` is spread (`...restClientConfig`, `prompt.ts:402`) into the smoltalk config. So model-specific config like `llama-cpp`'s `metadata.llamaCppModelDir` flows through `llm(prompt, { provider: "llama-cpp", model: "model.gguf", metadata: { llamaCppModelDir: "./models" } })` with no new work.

## Scope

**In scope:** the load-and-register seam — loading a user-authored provider module at startup and registering its provider into agency's own smoltalk instance.

**Out of scope (already works):**
- Model selection (`--provider`/`--model`, `setModel`, `setLlmOptions`).
- Passing model config such as the `.gguf` directory (flows through per-call `llm({ metadata })`).
- The built-in `ollama` provider (smoltalk ships it; usable today via `--provider ollama` once the `ollama` npm package is resolvable — separate concern).

## Architecture

### 1. The provider-module contract (user-facing)

A **provider module** is a user-authored ES module that exports a `register` function. It receives agency's own `registerProvider`; it must **not** import `registerProvider` from smoltalk itself.

```js
// llama-setup.mjs
import { LlamaCPP } from "smoltalk-llama-cpp";

export function register({ registerProvider }) {
  registerProvider("llama-cpp", LlamaCPP);
}
```

Rationale for injecting `registerProvider` rather than letting the module import it from smoltalk: because smoltalk is a *peer* dependency of `smoltalk-llama-cpp`, a globally-installed `smoltalk-llama-cpp` may resolve its *own* copy of smoltalk. If the module called *that* copy's `registerProvider`, the class would land in a registry agency never reads, and the provider would silently be "not supported." Injecting agency's `registerProvider` guarantees registration lands in the instance agency's runtime resolves against. (Structural use of the class — see facts above — makes cross-copy class instances safe.) This is also what makes `pack` work: agency's smoltalk is bundled, the user's module is loaded externally at runtime and never drags a second smoltalk into the bundle.

### 2. Triggering — config + env, merged

Two surfaces, merged and de-duplicated:

- **`agency.json`**: `client.providerModules: string[]` — discoverable, project-level. Added to `lib/config.ts` (type + zod). `lib/backends/typescriptBuilder.ts` bakes a string-literal array into `runtimeCtxArgs.providerModules`, stored on `RuntimeContext` (the same pipeline used for `smoltalkDefaults`, `maxToolResultChars`, etc.).
- **Env var**: `AGENCY_PROVIDER_MODULES` — comma-separated paths, read at runtime. Right for machine-specific absolute paths and the prebuilt binary.

**Merge rule:** `[...configModules, ...envModules]`, then de-duplicate by resolved path. Each path is resolved against `process.cwd()` if not absolute, then converted to a file URL via `pathToFileURL` for `import()`.

### 3. Loading — the one sanctioned `import()`

New file `lib/runtime/providerModules.ts` exporting `async function loadProviderModules(ctx)`:

1. Gather + resolve the merged path list (config from `ctx`, env from `process.env.AGENCY_PROVIDER_MODULES`).
2. For each not-yet-loaded path: `const mod = await import(pathToFileURL(resolved).href)` — the **single** sanctioned dynamic import in the codebase, wrapped here with an explicit structural-linter / eslint-disable exception and a comment explaining why it is necessary and bounded.
3. Validate and call `await mod.register({ registerProvider })`, where `registerProvider` is agency's own `import { registerProvider } from "smoltalk"`.
4. Record each successfully-loaded path in a **process-level `Set`** so repeated `runNode` calls (long-running `serve`, subprocess workers, test runs) do not redundantly re-import or re-register.

**When:** called from `runNode`, immediately **before** `__initAllRegistered(execCtx)` (`lib/runtime/node.ts:209`), so providers are registered before any user code, global-init expression, or `llm()` call on every fresh run. Because registration is process-global (not part of serialized checkpoint state), it behaves like handlers: re-established on each fresh run/resume, and inherited by forks and subprocesses for free.

The process-level loaded-`Set` is a **requirement, not an optimization**: it is what keeps a long-running `serve` process from re-registering on every request.

### 4. Error handling — fail loud

A configured-but-broken provider module is a setup error and must never be silently skipped:

- Path does not resolve / `import()` throws → fatal; error names the offending path and includes the underlying cause.
- Module has no `register` export, or `register` is not a function → fatal; clear message naming the path and the expected contract.
- `register()` throws → propagate, wrapped with the module path for context.

## Compatibility with other features

- **`serve`**: runs the program through `runNode`; the load happens once per server process (guarded by the loaded-`Set`), not per request. Baked `providerModules` and the env var are both available. No breakage.
- **`pack`**: esbuild bundles the runtime + smoltalk; the static `import { registerProvider } from "smoltalk"` is bundled into the *same* smoltalk instance the bundled runtime reads from, so registration lands correctly in a packed binary. The user's setup module is loaded via a **runtime-computed** `import()` specifier (a `pathToFileURL(...).href` string), which esbuild cannot statically resolve and therefore leaves as a genuine runtime import — it is not bundled (correct: it is machine-specific and optional). `smoltalk-llama-cpp` is never statically imported by agency, so it is never a bundle target and needs no `external` entry. The documented pack caveat about reading stdlib *files* at runtime does not apply (we import an explicit user path, not a package-root-relative file).
- **subprocess IPC**: `subprocess-bootstrap.ts` also runs via `runNode`; each subprocess loads provider modules from the same config/env.

## Components & files

- **Create** `lib/runtime/providerModules.ts` — `loadProviderModules(ctx)`, path resolution, the sanctioned `import()`, `register` validation/call, process-level loaded-`Set`.
- **Modify** `lib/runtime/node.ts` — call `loadProviderModules(execCtx)` before `__initAllRegistered` in `runNode`.
- **Modify** `lib/runtime/state/context.ts` — store `providerModules: string[]` on `RuntimeContext` (constructor arg + field).
- **Modify** `lib/config.ts` — add `client.providerModules?: string[]` (type + zod).
- **Modify** `lib/backends/typescriptBuilder.ts` — bake `providerModules` literal into `runtimeCtxArgs` when present.
- **Docs** — a guide page on custom/local providers (the contract, the two trigger surfaces, and a full `smoltalk-llama-cpp` walkthrough: install globally, write `llama-setup.mjs`, set `providerModules`, run with `--provider llama-cpp --model path.gguf`, and the `metadata.llamaCppModelDir` per-call note).

## Testing

- **Unit** (`lib/runtime/providerModules.test.ts`): point at a temp setup module that registers a fake provider; assert it lands in agency's smoltalk registry; cover all three error cases (bad path, missing/non-function `register`, throwing `register`); assert the loaded-`Set` prevents a second registration on a repeat call.
- **agency-js end-to-end** (`tests/agency-js/provider-module/`): an `agency.json` with `providerModules` pointing at a setup module that registers a fake **`echo`** provider — a tiny class implementing smoltalk's `SmolClient` interface that returns a canned response (**no real LLM call**). Run a program with `--provider echo`; assert the canned output. This proves the whole seam without a model download.
- **Codegen** (`lib/backends/providerModules.codegen.test.ts`): `agency.json providerModules` → emitted `runtimeCtxArgs.providerModules` literal.
- **`pack` smoke test**: pack a program whose `agency.json` lists a `providerModules` setup module; run the artifact; assert esbuild left the dynamic import intact and the provider registered at runtime. Guards against a future esbuild version hard-erroring on the dynamic import.

## Open questions

None blocking. The model-config-passthrough question (gguf dir) is resolved (already flows through per-call `llm({ metadata })`); extending `setLlmOptions`/`LlmDefaults` to carry `metadata` is a possible future convenience, explicitly out of scope here.
