# Watch Mode for Agency Compile

## Summary

Add a `--watch` flag to the `agency compile` command that watches input files/directories for changes and recompiles automatically. Uses chokidar for cross-platform file watching.

## CLI Interface

```
agency compile --watch src/
agency compile --watch foo.agency bar.agency
agency compile --watch src/ --ts
```

The `--watch` flag is added to the existing `compile` command. All existing compile options (`--ts`) continue to work. When `--watch` is passed, the command compiles all inputs once up front, then watches for subsequent changes and recompiles only the changed file.

## Scope

- **Compile only** — watch mode recompiles changed files but does not execute them.
- **Changed file only** — when a file changes, only that file is recompiled, not its dependents.
- **No new commands** — this is a flag on the existing `compile` command, not a separate command.

## Implementation

### New file: `lib/cli/watch.ts`

Exports a single function:

```typescript
export async function watchAndCompile(
  config: AgencyConfig,
  inputs: string[],
  options: { ts?: boolean }
): Promise<void>
```

Behavior:

1. **Initial compile:** Calls the existing `compile()` function on all inputs.
2. **Set up watcher:** Creates a chokidar watcher on all input paths, filtered to `*.agency` files using chokidar's glob support.
3. **On change/add:** Calls `compile()` on the changed file. Uses a per-file debounce of ~100ms to avoid redundant recompiles from duplicate filesystem events.
4. **Status messages:**
   - On start: `"Watching for changes..."`
   - On recompile: `"Recompiled foo.agency"`
   - On error: prints the error inline
5. **Error resilience:** Compilation errors are caught and printed. The watcher stays alive and continues watching.
6. **Graceful shutdown:** Listens for `SIGINT` to close the watcher and exit cleanly.

### Changes to `scripts/agency.ts`

Add a `--watch` option to the compile command:

```typescript
.option("-w, --watch", "Watch for changes and recompile")
```

When `--watch` is set, call `watchAndCompile()` instead of the normal compile loop.

### New dependency

`chokidar` v4 added to `dependencies` in `package.json`. v4 is much lighter (1 dependency vs 13), has native TypeScript types, and uses Node's `fs.watch` instead of bundled fsevents. Glob patterns are not supported as watch targets in v4 — use the `ignored` option to filter for `.agency` files instead.

## Testing

### `lib/cli/watch.test.ts`

- Creates a temp directory with a `.agency` file
- Starts the watcher
- Modifies the file
- Asserts that `compile()` was called for the changed file
- Asserts that compilation errors are caught and don't crash the watcher
- Mocks `compile()` to avoid needing the full compilation pipeline

## Future Considerations (not in scope)

- Recompiling dependents (files that import the changed file) — would require import graph tracking.
- Watch + run mode (`--watch --run`) — would require re-executing compiled output on change.
- These can be added later without breaking the initial design.
