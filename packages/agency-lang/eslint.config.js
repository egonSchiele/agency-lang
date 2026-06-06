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

      // No dynamic imports, no new Map()
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic imports are not allowed. Use static import statements.",
        },
      ],

      // Max nesting depth
      "max-depth": ["error", { max: 5 }],

      // Max function length
      "max-lines-per-function": [
        "error",
        { max: 150, skipBlankLines: true, skipComments: true },
      ],

      // Max file length
      "max-lines": [
        "error",
        { max: 1250, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  // ----- Per-file overrides for existing code -----
  // These files predate the structural lint rules. New files should comply.
  // TODO: Gradually fix these and remove overrides.
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
  {
    files: ["lib/backends/agencyGenerator.ts"],
    rules: {
      "max-lines": "off",
    }
  }
];
