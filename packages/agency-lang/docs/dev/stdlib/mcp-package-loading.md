# Loading the `@agency-lang/mcp` package

MCP support lives in a separate npm package, `@agency-lang/mcp`, which agency-lang does not depend on. A user installs it beside agency-lang in a project, or globally with `npm install -g` or `pnpm add -g`. This doc covers how agency-lang finds that package and loads it, and the rule that keeps the two steps in agreement.

## The two steps

Three files are involved:

- `lib/stdlib/mcpResolver.ts` finds the package's entry file. `isMcpAvailable()` is true when it finds one. `std::mcp`, the agent's `/mcp` command, and the agent's startup all check this before doing anything with MCP.
- `lib/stdlib/mcp.ts` calls `exposeResolvedMcpPath()`, which puts the entry file's path in the `AGENCY_MCP_PATH` environment variable.
- `lib/stdlib/mcpBridge.mjs` loads that file with `import()`. It is a `.mjs` file because the repo bans dynamic imports in TypeScript, and the package is optional, so it cannot be a static import.

The resolver looks in three places, in this order:

1. `AGENCY_MCP_PATH`, when it is already set. Tests use this, and so does an install in a place the search below does not reach.
2. The `node_modules` directories `import()` would search from agency-lang itself: one in the resolver's own directory and one in each directory above it. This covers a project install. It leaves out `NODE_PATH`, because `import()` ignores it. pnpm sets `NODE_PATH` to its hidden `node_modules/.pnpm/node_modules` when it runs a script, and in this repo that folder holds the workspace's copy of the package.
3. Each global `node_modules` directory that `npm root -g` and `pnpm root -g` print.

In each directory it reads `@agency-lang/mcp/package.json` and works out which file `import()` would load.

## The rule: find the file `import()` would load

The resolver must pick the same file the bridge's `import()` will load, using the same rules. The package's `exports` field can name different files for different kinds of loading. For example, the published package says:

```json
"exports": {
  ".": {
    "types": "./dist/src/mcp.d.ts",
    "import": "./dist/src/mcp.js"
  }
}
```

`import()` matches the conditions `node`, `import`, `module-sync`, `node-addons`, and `default`, and takes the first matching one in the order the package lists them. `require.resolve` matches `require` instead of `import`, so it rejects this package with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The resolver therefore cannot use `require.resolve` on the package name. If it did, every real install would report "MCP is not installed" even though `import()` could load the package.

Node has no public function that resolves a package for `import()` from a directory other than the calling file's own (the second argument of `import.meta.resolve` is behind a flag). So the resolver reads `exports` itself, in `conditionalTarget()`. It covers the shapes a normal package uses, not every rule in Node's algorithm: a string target, an array of targets tried in order, and an object of conditions, nested to any depth. One difference is that Node stops at a matched condition whose value is `null`, and the resolver moves on to the next condition. Another is that Node throws on a target that does not start with `./`, and the resolver skips it. A package with no `exports` falls back to `main`, then to `index.js`. The resolver also checks that the file exists.

A `package.json` that cannot be read or parsed, such as one left half-written by an interrupted install, counts as "not in this directory". The resolver prints a warning naming the file and moves on to the next directory. `isMcpAvailable()` runs at agent startup even for a user with no MCP servers configured, so it must never throw.

`mcpResolver.test.ts` installs fake packages with different `exports` shapes in a temporary global `node_modules`. It replaces `globalNodeModulesRoots()` with a stub, so the result does not depend on what the machine running the tests has installed globally.
