# TypeScript formatting

Hand-written TypeScript in this package is formatted by [Prettier](https://prettier.io). CI fails a pull request if any file is not formatted, so run the formatter before you push.

## Commands

```bash
pnpm run fmt:ts         # format every hand-written .ts file in place
pnpm run fmt:ts:check   # exit non-zero if anything is unformatted (this is what CI runs)
```

Both commands run from `packages/agency-lang`. `agency fmt` is unrelated: it formats `.agency` files, not TypeScript.

## Configuration

- `packages/agency-lang/.prettierrc.json` holds the options. It is Prettier's defaults plus `printWidth: 100`, chosen because it was the closest match to how the code was already written when Prettier was introduced.
- `packages/agency-lang/.prettierignore` lists what is *not* formatted: generated files (`lib/templates/**/*.ts`, `dist/`), vendored code (`lib/vendor/`), and test fixtures whose exact text matters (`tests/fixtures/`, `tests/typescriptGenerator/`, and so on). If you add a new generated or fixture directory, add it here too.
- `.vscode/settings.json` at the repo root points VS Code at the Prettier extension and this config, so format-on-save produces the same output as `pnpm run fmt:ts`. The extension (`esbenp.prettier-vscode`) is listed in `.vscode/extensions.json`; VS Code offers to install it when you open the workspace.

## Why

Before Prettier, VS Code's built-in TypeScript formatter and code written by other tools disagreed on layout, so many diffs were formatting noise that had to be read to be dismissed. One formatter, enforced in CI, keeps diffs to real changes.

## Gotcha

Wrapping long lines can push a function over the structural linter's 150-line limit (`max-lines-per-function` in `eslint.config.js`). When that happens, extract a helper rather than raising the limit; that is what `timed()` in `lib/compiler/buildSession.ts` and `helpScreen()` in `lib/logsViewer/run.ts` are.
