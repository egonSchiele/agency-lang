// Files the browser entry point can reach that still use Node.
//
// The lint rule in eslint.config.js bans Node modules and Node globals in
// every file a browser bundle of the runtime would contain. The first two
// lists are the exceptions. Together they only ever get shorter: a file
// leaves WAITING when its Node use moves into the host, and nothing joins
// NODE_ONLY without a reason beside it. The spec is
// docs/superpowers/specs/2026-10-05-host-and-platforms.md.
//
// scripts/lint-browser-reach.mjs reads all three lists. It walks the
// imports of the runtime and the stdlib without entering a listed file,
// and fails when a file it reaches is not covered by the rule, or imports
// a file on NODE_ONLY that REACHES_NODE_ONLY does not name.

/** Node-only for good, each with the reason. An entry is a file, or a
 *  directory glob such as lib/host/node/** for every file under it.
 *  lib/runtime/browser.ts exports a stand-in for every header name that
 *  comes from one of these, and a stdlib module whose compiled file imports
 *  one is Node-only. */
export const NODE_ONLY = {
  "lib/host/node/**":
    "the host for Node, built from Node modules on purpose, and default.node.ts, which the default condition of #default-host picks",
  "lib/debugger/debuggerState.ts":
    "the debugger's state, which imports the whole compiler through lib/index.ts; the runtime names only its type",
  "lib/runtime/agencyGlobals.node.ts":
    "re-exports Node's path and os for Agency code; the browser entry point exports portable ones",
  "lib/runtime/cliEntry.ts": "starts a program from the command line",
  "lib/runtime/cliInterruptResolution.ts":
    "the command line's endpoint for interrupts nothing handled",
  "lib/runtime/coverageCollector.ts": "tooling: writes coverage files",
  "lib/runtime/ipc.ts": "runs a child Agency program and extends the handler chain into it",
  "lib/runtime/localProvider.ts": "loads a model provider module from disk",
  "lib/runtime/platform.node.ts":
    "the Node side of #platform: provider modules from disk, the coverage collector, local models",
  "lib/runtime/providerModules.ts": "loads provider modules from disk",
  "lib/runtime/subprocess-bootstrap.ts": "the child end of ipc.ts",
  "lib/runtime/template/**":
    "filling a template runs the compiler (the parser, the symbol table, and the import resolver read files); lib/types/function.ts names only its types",
  "lib/runtime/trace/traceReader.ts": "tooling: reads a trace file for the debugger",
  "lib/stdlib/agency.ts": "compiles and runs Agency code in a subprocess (std::agency)",
  "lib/stdlib/agencyEval.ts": "runs evals of agents from run directories on disk",
  "lib/stdlib/args.ts":
    "std::args parses the command line with node:util's parseArgs and ends the process; a browser has no command line",
  "lib/stdlib/calendar.ts": "std::calendar signs in through std::oauth",
  "lib/stdlib/embedding.ts": "local models",
  "lib/stdlib/ffmpeg.ts": "probes for ffmpeg with spawnSync before any interrupt (std::speech)",
  "lib/stdlib/cli.ts": "the terminal UI needs the terminal's size and raw mode",
  "lib/stdlib/github/testUtils.ts": "a test helper",
  "lib/stdlib/hubClient.ts": "downloads model files to disk (local models)",
  "lib/stdlib/hubDownload.ts": "downloads model files to disk (local models)",
  "lib/stdlib/image.ts": "std::image generates and reads pictures through local models",
  "lib/stdlib/imageTools.ts": "runs the Python agency local serve uses (local models)",
  "lib/stdlib/llm.ts": "std::llm loads provider modules from disk",
  "lib/stdlib/localImageInputs.ts": "local models",
  "lib/stdlib/localModelList.ts": "local models",
  "lib/stdlib/localModelManifest.ts": "local models",
  "lib/stdlib/localModels.ts": "starts local model servers (local models)",
  "lib/stdlib/localPython.ts": "runs Python for local models",
  "lib/stdlib/localRequest.ts": "local models",
  "lib/stdlib/mcp.ts": "std::mcp loads the @agency-lang/mcp package from node_modules",
  "lib/stdlib/mcpBridge.mjs": "the bridge std::mcp loads the package through",
  "lib/stdlib/mcpResolver.ts": "finds the @agency-lang/mcp package with createRequire",
  "lib/stdlib/mlxImage.ts": "local models",
  "lib/stdlib/mlxModelRecord.ts": "local models",
  "lib/stdlib/mlxServerModels.ts": "local models",
  "lib/stdlib/modelBackend.ts": "recognizes a model directory on disk (local models)",
  "lib/stdlib/modelDirKind.ts": "reads a model directory on disk to tell its kind (local models)",
  "lib/stdlib/modelVerify.ts":
    "hashes model files of many gigabytes in pieces; a JavaScript SHA-256 is too slow for that",
  "lib/stdlib/oauth.ts":
    "std::oauth signs in through a callback server on http, and stores tokens through oauthEncryption.ts",
  "lib/stdlib/oauthEncryption.ts":
    "encrypts stored tokens with createCipheriv; no portable cipher yet",
  "lib/stdlib/speech.ts": "std::speech records from a raw-mode terminal and probes ffmpeg",
  "lib/stdlib/statelog.ts":
    "std::statelog reads a statelog file through lib/eval/statelogParser.ts, which uses fs",
  "lib/stdlib/template.ts": "std::template fills a template, which runs the compiler",
  "lib/stdlib/ui-region.ts": "the terminal UI needs the terminal's size and raw mode",
  "lib/stdlib/ui.ts": "the terminal UI needs the terminal's size and raw mode",
  "lib/stdlib/vision.ts": "std::vision runs through local models",
  "lib/stdlib/visionFiles.ts": "local models",
  "lib/utils/sha256.node.ts":
    "Node crypto; the browser condition of #sha256 picks sha256.portable.ts",
  "lib/utils/path.node.ts":
    "Node path; the browser condition of #path picks path.portable.ts",
};

/** Imports of a Node-only file by a file the browser can reach, as
 *  importer: targets. Each is a seam the browser entry point
 *  (lib/runtime/browser.ts) has to cut, by a host function or a
 *  per-platform file; until then the Node bundle needs the import. The
 *  reach lint fails on an import of a Node-only file this does not name,
 *  and on a named one that is gone, so this list only gets shorter. */
export const REACHES_NODE_ONLY = {
};

/** Files whose Node use has not moved into the host yet. Each is imported
 *  by a file the browser can reach, so none can be Node-only; what each
 *  one needs is beside it. Sorted. */
export const WAITING = [
];
