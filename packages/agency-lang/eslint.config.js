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

      // Use type, not interface
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

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
        { max: 600, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  // Per-file overrides for legitimately large files
  {
    files: [
      "lib/backends/typescriptBuilder.ts",
      "lib/parser.ts",
    ],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
    },
  },
];
