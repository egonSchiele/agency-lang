# Standalone Server Bundling — Status

## What's Done

### Code changes (on `main`, uncommitted)

1. **`lib/cli/serve.ts`** — `generateStandalone` now:
   - Accepts a `mode` parameter (`"http" | "mcp"`)
   - Generates a temporary entrypoint file that wires up discovery + the appropriate server
   - Uses absolute paths to dist files (via `import.meta.url`) so we don't need package.json exports entries
   - Bundles with esbuild, then cleans up temp files
   - Supports `--api-key-env` for HTTP mode and `--name` for MCP mode

2. **`scripts/agency.ts`** — CLI flags added:
   - `--standalone` on both `serve http` and `serve mcp`
   - `--api-key-env <name>` on `serve http`

3. **`lib/utils/formatType.ts`** (new) — Extracted `formatTypeHint` and `formatTypeHintTs` out of `cli/util.ts`. This breaks a dependency chain where the typechecker pulled in `cli/util.ts` → `prompts` → `readline`, which caused CJS/ESM conflicts in the ESM bundle. Updated all importers (typechecker, LSP, backends, debugger) to use the new path. `cli/util.ts` re-exports for backward compatibility.

### Spec
- `docs/superpowers/specs/2026-05-08-standalone-http-server-design.md`

## What's Left

### Blockers

1. **Smoltalk eagerly imports `node-llama-cpp`** — This native package has top-level side effects and platform-specific binaries. It can't be bundled and can't be externalized (the static import fails if the package isn't installed). **Fix**: Make smoltalk lazy-load node-llama-cpp via `createRequire` so it's only loaded when a local model is actually requested. This change needs to happen in the smoltalk package.

2. **Verify `prompts` is no longer in the bundle** — After the `formatType.ts` extraction, `prompts` should no longer be transitively pulled into the standalone bundle. Needs verification once the smoltalk fix lands and we can produce a working bundle.

### Remaining work (after blockers resolved)

3. **Remove the `createRequire` banner** from esbuild config if no longer needed
4. **Test MCP standalone mode** — Code is wired up but untested
5. **Test the output on a clean machine** — Copy `foo.server.js` to a machine without Agency installed, run `node foo.server.js`, verify it works
6. **Clean up test artifacts** — Remove `foo.server.js`, `bar.js` from working directory
