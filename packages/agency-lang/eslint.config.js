import tseslint from "typescript-eslint";

const SCREEN_PAINT_MESSAGE = "Screens draw text through lib/tui/paint.ts (segment, paint, paintedLine), which escapes it. A raw line() lets statelog content be read as style tags.";

// Files under lib/stdlib that may import fs directly, each with the reason.
// Everything else in lib/stdlib reads and writes files through
// lib/stdlib/contained.ts, which refuses symlinks below the approved
// directory (docs/dev/stdlib/contained-files.md). To add a file here, say
// which fixed file it touches and why no approval names that path.
const FS_IMPORTERS = {
  "lib/stdlib/contained.ts": "the module every other file operation goes through",
  "lib/stdlib/modelBackend.ts":
    "recognizes a model directory, including a Hugging Face cache snapshot whose entries are symlinks into blobs/; reads names and sizes only, never contents",
  "lib/stdlib/gitignore.ts":
    "reads .gitignore rules from a walk root up to the filesystem root, ancestors included; the text becomes ignore rules and is never returned",
  "lib/stdlib/shell.ts": "which() probes PATH entries and exec() checks its cwd; no approval names either",
  "lib/stdlib/utils.ts": "reads /proc/version once to tell WSL from Linux, a fixed kernel file",
};

const FS_MODULES = ["fs", "fs/promises", "node:fs", "node:fs/promises"];

export default [
  {
    ignores: [
      "dist/**",
      "tests/**",
      "lib/templates/**/*.ts",
      "stdlib/**/*.js",
      "node_modules/**",
      "lib/agents/**",
      "lib/vendor/**",
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
  {
    files: ["lib/stdlib/**/*.ts"],
    ignores: ["lib/stdlib/**/*.test.ts", "lib/stdlib/__tests__/**", ...Object.keys(FS_IMPORTERS)],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: FS_MODULES.map((name) => ({
            name,
            message:
              "lib/stdlib reads and writes files through lib/stdlib/contained.ts. If this file truly needs fs, add it to FS_IMPORTERS in eslint.config.js with the reason.",
          })),
        },
      ],
    },
  },
  {
    files: ["lib/logsViewer/**/*.ts", "lib/eval/**/*.ts", "lib/runsExplorer/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Dynamic imports are not allowed. Use static import statements.",
        },
        {
          selector: [
            "MemberExpression[object.name='data'][property.name='usage']",
            "MemberExpression[object.name='data'][computed=true][property.value='usage']",
            "VariableDeclarator[init.name='data'] > ObjectPattern > Property[key.name='usage']",
            "VariableDeclarator[init.name='data'] > ObjectPattern > Property[key.value='usage']",
            "MemberExpression[object.property.name='data'][property.name='usage']",
            "MemberExpression[object.property.name='data'][computed=true][property.value='usage']",
            "VariableDeclarator[init.property.name='data'] > ObjectPattern > Property[key.name='usage']",
            "VariableDeclarator[init.property.name='data'] > ObjectPattern > Property[key.value='usage']",
            "AssignmentExpression[right.property.name='data'] > ObjectPattern > Property[key.name='usage']",
            "AssignmentExpression[right.property.name='data'] > ObjectPattern > Property[key.value='usage']",
          ].join(", "),
          message:
            "Read token counts through lib/statelog/wireAccessors.ts (hasTokenUsage, tokensIn, tokensCached, tokensCacheWrite, contextTokens, tokensOut).",
        },
      ],
    },
  },
  {
    files: ["lib/logsViewer/screens/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {paths: [
        {name:"../../tui/builders.js",importNames:["line","lines","text"],message:SCREEN_PAINT_MESSAGE},
        {name:"../../tui/styleParser.js",importNames:["escapeStyleTags"],message:SCREEN_PAINT_MESSAGE},
        {name:"../../tui/index.js",importNames:["line","lines","text","escapeStyleTags"],message:SCREEN_PAINT_MESSAGE},
      ]}],
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
