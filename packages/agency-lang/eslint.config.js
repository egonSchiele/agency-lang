import { builtinModules } from "module";
import tseslint from "typescript-eslint";
import { NODE_ONLY, WAITING } from "./eslint.node-exceptions.mjs";

const SCREEN_PAINT_MESSAGE = "Screens draw text through lib/tui/paint.ts (segment, paint, paintedLine), which escapes it. A raw line() lets statelog content be read as style tags.";

// Files under lib/stdlib that may import fs directly, each with the reason.
// Everything else in lib/stdlib reads and writes files through
// `host.files`, which refuses symlinks below the approved directory
// (docs/dev/stdlib/contained-files.md). To add a file here, say which
// fixed file it touches and why no approval names that path.
const FS_IMPORTERS = {
  "lib/stdlib/modelBackend.ts":
    "recognizes a model directory, including a Hugging Face cache snapshot whose entries are symlinks into blobs/; reads names and sizes only, never contents",
  "lib/stdlib/gitignore.ts":
    "reads .gitignore rules from a walk root up to the filesystem root, ancestors included; the text becomes ignore rules and is never returned",
  "lib/stdlib/shell.ts": "which() probes PATH entries and exec() checks its cwd; no approval names either",
};

const FS_MODULES = ["fs", "fs/promises", "node:fs", "node:fs/promises"];

// Every Node module, with and without the "node:" prefix.
const NODE_MODULES = builtinModules
  .filter((name) => !name.startsWith("_") && !name.startsWith("node:"))
  .flatMap((name) => [name, `node:${name}`]);

// The inside of a Root belongs to lib/host (lib/host/roots.ts). ESLint keeps
// only the last no-restricted-syntax block for a file, so this rule is
// repeated in every block that sets it.
const ROOT_REAL_RULE = {
  selector: "MemberExpression[property.name='real']",
  message:
    "Only files under lib/host read the inside of a Root. Ask the host for the operation you want, or for a path with rootPath() from lib/host/roots.ts.",
};

const NODE_GLOBALS = ["process", "Buffer", "__dirname", "__filename", "require", "setImmediate"];

// The files a browser bundle of the runtime contains: the four directories
// below and the files outside them that the runtime imports. The spec says
// which (docs/superpowers/specs/2026-10-05-host-and-platforms.md, "The lint
// rule"). scripts/lint-browser-reach.mjs fails when the bundle reaches a
// file this list does not cover.
export const BROWSER_FILES = [
  "lib/runtime/**/*.ts",
  "lib/stdlib/**/*.ts",
  "lib/stdlib/**/*.mjs",
  "lib/simplemachine/**/*.ts",
  "lib/host/**/*.ts",
  "lib/config/config.ts",
  "lib/config/paths.ts",
  "lib/constants.ts",
  "lib/duration.ts",
  "lib/importPaths.ts",
  "lib/logger.ts",
  "lib/matchVal.ts",
  "lib/statelogClient.ts",
  "lib/statelogSender.ts",
  "lib/types/function.ts",
  "lib/utils/canonicalize.ts",
  "lib/utils/columnWidths.ts",
  "lib/utils/diff.ts",
  "lib/utils/hash.ts",
  "lib/utils/iteration.ts",
  "lib/utils/sha256.node.ts",
  "lib/utils/sha256.portable.ts",
  "lib/utils/path.node.ts",
  "lib/utils/path.portable.ts",
  "lib/utils/termcolors.ts",
];

const NODE_IMPORT_MESSAGE =
  "This file can end up in a browser bundle, so it may not import a Node module. Reach the platform through the host (docs/dev/runtime/host.md). A file that must stay on Node goes in eslint.node-exceptions.mjs with the reason.";
const NODE_GLOBAL_MESSAGE =
  "This file can end up in a browser bundle, so it may not use a Node global. Reach the platform through the host (docs/dev/runtime/host.md). A file that must stay on Node goes in eslint.node-exceptions.mjs with the reason.";

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
        ROOT_REAL_RULE,
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
              "lib/stdlib reads and writes files through host.files (docs/dev/stdlib/contained-files.md). If this file truly needs fs, add it to FS_IMPORTERS in eslint.config.js with the reason.",
          })),
        },
      ],
    },
  },
  {
    // Files the browser can reach may not use Node. ESLint keeps only the
    // last block that sets a rule for a file, so this block repeats the fs
    // ban above for the stdlib files it covers, with the same exceptions.
    files: BROWSER_FILES,
    ignores: ["**/*.test.ts", "lib/stdlib/__tests__/**", ...Object.keys(NODE_ONLY), ...WAITING],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: NODE_MODULES.map((name) => ({ name, message: NODE_IMPORT_MESSAGE })),
        },
      ],
      "no-restricted-globals": [
        "error",
        ...NODE_GLOBALS.map((name) => ({ name, message: NODE_GLOBAL_MESSAGE })),
      ],
    },
  },
  {
    // process.exit() kills log requests still on their way to a Statelog
    // server. These directories run inside a user's program, so they exit
    // through lib/runtime/exitProcess.ts (docs/dev/hosting/statelog.md).
    files: ["lib/runtime/**/*.ts", "lib/serve/**/*.ts", "lib/stdlib/**/*.ts"],
    ignores: ["**/*.test.ts", "lib/stdlib/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Dynamic imports are not allowed. Use static import statements.",
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='exit']",
          message:
            "Exit through exitProcess() in lib/runtime/exitProcess.ts, which sends pending logs first. Use exitProcessNow() where the exit cannot wait, and say why.",
        },
        ROOT_REAL_RULE,
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
        ROOT_REAL_RULE,
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
  {
    // lib/host owns the inside of a Root, so the rule above does not apply
    // there; the dynamic-import ban stays.
    files: ["lib/host/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Dynamic imports are not allowed. Use static import statements.",
        },
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
