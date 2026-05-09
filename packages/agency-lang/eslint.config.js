import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "tests/**",
      "lib/templates/**/*.ts",
      "stdlib/**/*.js",
      "node_modules/**",
      "lib/agents/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["lib/**/*.ts"],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // Disable rules from recommended that are too noisy for this codebase
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",

      // --- Agency structural rules ---

      // Use type, not interface.
      // Disabled until a dedicated cleanup PR auto-fixes all existing interfaces.
      // "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // Prefer const over let when never reassigned
      "prefer-const": "error",

      // No dynamic imports, no new Map(), no new Set()
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic imports are not allowed. Use static import statements.",
        },
        {
          selector: "NewExpression[callee.name='Map']",
          message: "Use a plain object instead of Map.",
        },
        {
          selector: "NewExpression[callee.name='Set']",
          message: "Use a plain array instead of Set.",
        },
      ],

      // Max nesting depth
      "max-depth": ["error", { max: 4 }],

      // Max function length
      "max-lines-per-function": [
        "error",
        { max: 100, skipBlankLines: true, skipComments: true },
      ],

      // Max file length
      "max-lines": [
        "error",
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  // ----- Per-file overrides for existing code -----
  // These files predate the structural lint rules. New files should comply.
  // TODO: Gradually fix these and remove overrides.
  {
    files: [
      "lib/backends/agencyGenerator.ts",
      "lib/backends/typescriptBuilder.ts",
      "lib/cli/bundle.ts",
      "lib/cli/commands.ts",
      "lib/cli/debug.ts",
      "lib/cli/doc.ts",
      "lib/cli/evaluate.ts",
      "lib/cli/optimize.ts",
      "lib/cli/schedule/index.ts",
      "lib/cli/serve.ts",
      "lib/cli/test.ts",
      "lib/cli/util.ts",
      "lib/cli/watch.ts",
      "lib/compilationUnit.ts",
      "lib/debugger/driver.ts",
      "lib/debugger/testHelpers.ts",
      "lib/debugger/uiState.ts",
      "lib/importStrategy.ts",
      "lib/ir/prettyPrint.ts",
      "lib/lsp/completion.ts",
      "lib/lsp/server.ts",
      "lib/parser.ts",
      "lib/parsers/parsers.ts",
      "lib/preprocessors/importResolver.ts",
      "lib/preprocessors/parallelDesugar.ts",
      "lib/preprocessors/typescriptPreprocessor.ts",
      "lib/runtime/agencyFunction.ts",
      "lib/runtime/hooks.ts",
      "lib/runtime/node.ts",
      "lib/runtime/prompt.ts",
      "lib/runtime/revivers/mapReviver.ts",
      "lib/runtime/revivers/setReviver.ts",
      "lib/runtime/state/context.ts",
      "lib/runtime/state/globalStore.ts",
      "lib/runtime/state/stateStack.ts",
      "lib/runtime/trace/contentAddressableStore.ts",
      "lib/simplemachine/graph.ts",
      "lib/simplemachine/util.ts",
      "lib/symbolTable.ts",
      "lib/tui/styleParser.ts",
      "lib/typeChecker/assignability.ts",
      "lib/typeChecker/checker.ts",
      "lib/typeChecker/index.ts",
      "lib/typeChecker/inference.ts",
      "lib/typeChecker/suppression.ts",
      "lib/typeChecker/synthesizer.ts",
      "lib/typeChecker/utils.ts",
      "lib/utils.ts",
      "lib/utils/node.ts",
    ],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-depth": "off",
      "no-restricted-syntax": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
  // Test files tend to have long describe blocks and use Set/Map
  {
    files: ["lib/**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      "max-depth": "off",
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
];
