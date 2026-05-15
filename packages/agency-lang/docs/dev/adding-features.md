# Adding Features

Step-by-step guides for common tasks in the Agency codebase.

---

## Adding a new AST node type

1. **Define the type** in `lib/types/` (create a new file or add to an existing one). Export it from `lib/types.ts`. Add the new type to the `AgencyNode` union type in `lib/types.ts`.
2. **Add a parser** in `lib/parsers/`. Wire it into the main parser in `lib/parser.ts`. Add unit tests in a co-located `.test.ts` file.
3. **Add code generation** by adding a case to `processNode` in `lib/backends/typescriptBuilder.ts`. You may also need to create new `.mustache` template files in `lib/templates/backends/` and run `pnpm run templates`.
4. **Add integration test fixtures** — create `.agency` and `.mts` files in `tests/typescriptGenerator/`.

---

## Adding a new pattern form

Patterns (destructuring, `is`, match arms, for-loop binders) are
implemented as syntactic sugar lowered to existing AST constructs.
After lowering, the rest of the pipeline (typechecker, TypeScriptBuilder,
preprocessor, LSP) sees only existing node types.

1. **AST type** — add the node to `lib/types/pattern.ts` and the `Pattern`
   / `BindingPattern` / `MatchPattern` unions. Add it to the `AgencyNode`
   union in `lib/types.ts` so the formatter can dispatch on it.
2. **Parser** — extend `bindingPatternParser` and/or `matchPatternParser`
   in `lib/parsers/parsers.ts`. Add tests in `lib/parsers/pattern.test.ts`.
3. **Lowering** — extend `extractBindings` and `patternToCondition` in
   `lib/lowering/patternLowering.ts`. The lowering must preserve `loc`
   from the original pattern node so error messages point at the right
   source position.
4. **Formatter** — extend `formatPattern()` in
   `lib/backends/agencyGenerator.ts` so the new form round-trips.
5. **Tests** — add lowering unit tests
   (`lib/lowering/patternLowering.test.ts`) and end-to-end agency tests
   under `tests/agency/`.

The format path opts out of pattern lowering by passing `lower: false`
to `parse()`; the compile and LSP paths use the default (`lower: true`).

---

## Adding a CLI command

1. Add the command definition in `scripts/agency.ts` using commander (`.command()`, `.argument()`, `.option()`, `.action()`).
2. Implement the command logic in `lib/cli/` (create a new file or add to an existing one). Shared utilities like `parseTarget`, `pickANode`, `executeNode` live in `lib/cli/util.ts`.
3. Optionally add a shortcut script in `package.json` under `"scripts"`.
