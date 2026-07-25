# Idea: A front-end-only web playground for Agency

Status: **spike done, findings proven, not yet integrated.** Written 2026-07-13. Pick up later.

## The goal

A TypeScript-Playground-style web app (https://www.typescriptlang.org/play/) for Agency. Entirely
front-end, no server. The user writes Agency code, we compile it to JS in the browser, run it with
`eval`, and use an in-browser model as the LLM backend.

- In-browser model: [`smoltalk-webllm`](https://github.com/egonSchiele/smoltalk/tree/main/packages/smoltalk-webllm).
- Everything runs client-side. No API keys, no backend.

## The blocker: AsyncLocalStorage is Node-only

Agency uses `node:async_hooks` `AsyncLocalStorage` (ALS) to give each concurrent branch
(`fork` / `race` / `parallel`) an isolated runtime frame: its own `stack`, abort signal, and
`ThreadStore`. The runtime seeds ALS frames at three points and relies on them propagating through
every `await` (see `docs/dev/async-context.md`). ALS does not exist in browsers.

## What the spike proved

All spike code is in this directory (`packages/agency-lang/als-spike/`). It uses `zone.js`
(added as a devDep). Run `node spike.mjs zone`, `node diagnose.mjs`, etc.

### 1. Agency uses a polyfillable subset of ALS

Across all 5 ALS-using files (`asyncContext.ts`, `callDepth.ts`, `interrupts.ts`, `hooks.ts`,
`statelogClient.ts`), Agency calls only two methods:

- `.run(store, fn)` — 73 call sites
- `.getStore()` — 39 call sites

**Zero `enterWith()`, zero `exit()`.** `enterWith()` is the one method that is genuinely impossible
to polyfill without `async_hooks`. We never use it. So we are in the polyfillable subset.

### 2. The naive polyfill silently corrupts fork isolation

The polyfill most bundlers hand you is a single module-level variable (set on `run`, restore on
return). It does NOT propagate across `await`. Proven in `naive-als.mjs` / `spike.mjs`: two
concurrent branches each in their own `run()` frame both read `after=undefined` after an await, and
their stores clobber each other. This would corrupt every `fork`/`race` in Agency. **Do not use a
naive shim.**

### 3. Zone.js gives correct semantics — but cannot track native async/await

`zone.js` monkeypatches `Promise.then` / `setTimeout` / the microtask queue so a continuation
resumes in the zone that scheduled it. We built an `AsyncLocalStorage` on top (`zone-als.mjs`):
`run` = `Zone.current.fork({ properties })`, `getStore` = `Zone.current.get(key)`.

`diagnose.mjs` shows exactly what Zone can and cannot track:

| Async pattern | Zone propagates context? |
|---|---|
| `setTimeout` callback | ✅ yes |
| explicit `.then()` chain | ✅ yes |
| **native `async`/`await`** | ❌ **no** |

V8 runs native `await` through internal machinery that bypasses Zone's patched `.then`. This is a
well-known Zone.js limitation. It is the whole reason the first Zone attempt in `spike.mjs` failed.

### 4. Transpiling to es2016 fixes it (the key finding)

esbuild's `--target=es2016` lowers `async`/`await` into a generator + `.then` state machine. Those
`.then` calls go through Zone's patched `Promise.prototype.then`, so Zone tracks them.

Proven in `spike-src.mjs` → `spike-es2016.cjs`: the identical program that FAILS with native
async/await PASSES once transpiled to es2016. Per-branch isolation across `await` holds, and nested
`run()` frames (parent-zone walk) also work.

## Recommended architecture

1. **Ship a Zone-backed `AsyncLocalStorage` shim** (`zone-als.mjs` here is the template). Browser
   build imports `"zone.js"`; the Node spike imports `"zone.js/node"`.

2. **Alias `node:async_hooks` → the shim** in the bundler. Every runtime file imports the API
   identically (`import { AsyncLocalStorage } from "node:async_hooks"`), so one alias covers all 5
   files. Example (Vite): `resolve.alias["node:async_hooks"] = "/shims/zone-als.js"`.

3. **Transpile ALL Agency code to es2016.** This is the non-obvious part. It is not enough to build
   the runtime at es2016 — the *generated user program* is also full of native `async function` /
   `await __call` (thousands of sites), and it gets `eval`'d. So the playground's compile step must
   run the generated JS through an es2016 lowering pass (esbuild transform, `target: es2016`) before
   `eval`. `smoltalk-webllm`'s own internal awaits do NOT need lowering — only the runtime's awaited
   continuations must capture the zone, and they do once the runtime is lowered.

4. **Stub Node builtins to make the build pass** (see below).

## Build concerns

The stdlib and runtime import Node builtins **statically at module top level**, not lazily:

- stdlib: `node:fs`/`fs` (×33 combined), `child_process`, `os`, `path`, `crypto`, `http`…
- runtime: `node:fs` (×13), `node:path`, `node:os`, `node:async_hooks`…

Because they are top-level static imports, esbuild pulls them into the graph whether or not the user
ever calls `read()`. With `platform: browser`, the build **fails** with `Could not resolve node:fs`.

Fix: alias these builtins to empty stub modules (esbuild `alias` or a resolve plugin). Then the fs
functions become dead weight that only throws at runtime if actually called. That is safe: the
browser sandboxes everything, and these functions are interrupt-gated anyway. Subprocess features
(`std::agency.run`) will not work in-browser and can be stubbed to reject.

## Non-issues (already cleared)

- `lib/runtime/node.ts` is the Agency **nodes** feature, not Node.js. Ignore the filename.
- Observability (`statelogClient` network POSTs) is **off by default**. Non-issue unless opted in.

## Files in this spike

- `zone-als.mjs` — the Zone-backed `AsyncLocalStorage` shim (the deliverable template).
- `naive-als.mjs` — the broken naive polyfill, kept to demonstrate the failure.
- `spike.mjs` — concurrency + nested isolation test. `node spike.mjs zone|naive`.
- `spike-src.mjs` — same test, native async/await, static shim import, for transpiling.
- `diagnose.mjs` — isolates which async patterns Zone can track (setTimeout / .then / await).
- `spike-es2016.cjs` — generated: `esbuild spike-src.mjs --bundle --target=es2016 --format=cjs --platform=node`.

## Next step (not done yet)

Prove it with a **real Agency `fork` program**, not the hand-rolled mimic, to close the last risk
that Agency's actual ALS usage differs from the simulation:

1. Alias `node:async_hooks` → Zone shim; bundle the real runtime at `target: es2016`.
2. Compile a small `.agency` file with a `fork` of two branches that mutate per-branch state.
3. Lower the generated JS to es2016.
4. Run in Node with a mock LLM (no WebGPU needed for the ALS proof) and assert each branch sees only
   its own state.

Only after that passes should the actual playground UI + `smoltalk-webllm` wiring begin.

## Alternatives considered

- **TC39 AsyncContext polyfill** (`AsyncContext.Variable`) — standards-track successor. Same V8
  native-await limitation, so it also needs the es2016 transpile. Zone.js is more battle-tested;
  keep this as a fallback.
- **Codegen context-threading** — make the browser target thread `ctx`/`stack`/`threads`
  explicitly (Agency's pre-ALS mechanism). Avoids Zone entirely but is a compiler fork. Too heavy
  versus the Zone + es2016 path.
