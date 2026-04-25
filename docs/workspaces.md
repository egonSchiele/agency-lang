# pnpm Workspaces

This repo uses [pnpm workspaces](https://pnpm.io/workspaces) to manage multiple packages in a monorepo.

## Structure

```
/
  pnpm-workspace.yaml
  package.json                 # workspace root (private)
  packages/
    agency-lang/               # the main Agency compiler and runtime
    test/                      # test package for verifying the setup
```

## Common commands

All commands should be run from the repo root.

### Build

```bash
pnpm --filter agency-lang run build
```

### Run tests

```bash
pnpm --filter agency-lang run test        # watch mode
pnpm --filter agency-lang run test:run    # single run
```

### Compile an .agency file

```bash
pnpm --filter agency-lang run agency <path-to-file>
```

### Run any agency-lang script

```bash
pnpm --filter agency-lang run <script-name>
```

The root `package.json` also has shortcuts for `build`, `test`, and `test:run` that delegate to `agency-lang`.

## The test package

`packages/test/` is a minimal package that depends on `agency-lang` via `workspace:*`. It exists to verify that the workspace linking works and that compiled Agency code can resolve `agency-lang` imports correctly.

To compile a file in the test package:

```bash
pnpm --filter agency-lang run compile packages/test/hello.agency
```

## Adding a new package

1. Create a directory under `packages/`.
2. Add a `package.json` with `"agency-lang": "workspace:*"` in `dependencies`.
3. Run `pnpm install` from the repo root to link everything.
