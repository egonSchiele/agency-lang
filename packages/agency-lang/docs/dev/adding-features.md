# Adding Features

Step-by-step guides for common tasks in the Agency codebase.

---

## Adding a new AST node type

1. **Define the type** in `lib/types/` (create a new file or add to an existing one). Export it from `lib/types.ts`. Add the new type to the `AgencyNode` union type in `lib/types.ts`.
2. **Add a parser** in `lib/parsers/`. Wire it into the main parser in `lib/parser.ts`. Add unit tests in a co-located `.test.ts` file.
3. **Add code generation** by adding a case to `processNode` in `lib/backends/typescriptBuilder.ts`. You may also need to create new `.mustache` template files in `lib/templates/backends/` and run `pnpm run templates`.
4. **Add integration test fixtures** — create `.agency` and `.mts` files in `tests/typescriptGenerator/`.

---

## Adding a CLI command

1. Add the command definition in `scripts/agency.ts` using commander (`.command()`, `.argument()`, `.option()`, `.action()`).
2. Implement the command logic in `lib/cli/` (create a new file or add to an existing one). Shared utilities like `parseTarget`, `pickANode`, `executeNode` live in `lib/cli/util.ts`.
3. Optionally add a shortcut script in `package.json` under `"scripts"`.
