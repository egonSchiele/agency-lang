// Files the browser entry point can reach that still use Node.
//
// The lint rule in eslint.config.js bans Node modules and Node globals in
// every file a browser bundle of the runtime would contain. These two lists
// are the exceptions. Together they only ever get shorter: a file leaves
// WAITING when a PR moves its Node use into the host, and nothing joins
// NODE_ONLY without a reason beside it. The spec is
// docs/superpowers/specs/2026-10-05-host-and-platforms.md.
//
// scripts/lint-browser-reach.mjs reads both lists too. It walks the imports
// of the runtime and the stdlib without entering a listed file, and fails
// when a file it reaches is not covered by the rule, or imports a file on
// NODE_ONLY.

/** Node-only for good, each with the reason. lib/runtime/browser.ts
 *  exports a stand-in for every header name that comes from one of these,
 *  and a stdlib module whose compiled file imports one is Node-only. */
export const NODE_ONLY = {
  "lib/host/default.node.ts":
    "builds the default host for Node; the browser condition of #default-host picks default.browser.ts instead",
  "lib/host/nodeHost.ts": "the host for Node, built from Node modules on purpose",
  "lib/runtime/cliEntry.ts": "starts a program from the command line",
  "lib/runtime/cliInterruptResolution.ts":
    "the command line's endpoint for interrupts nothing handled",
  "lib/runtime/coverageCollector.ts": "tooling: writes coverage files",
  "lib/runtime/interruptPrompts.ts": "asks a person at a terminal to approve an interrupt",
  "lib/runtime/ipc.ts": "runs a child Agency program and extends the handler chain into it",
  "lib/runtime/localProvider.ts": "loads a model provider module from disk",
  "lib/runtime/providerModules.ts": "loads provider modules from disk",
  "lib/runtime/subprocess-bootstrap.ts": "the child end of ipc.ts",
  "lib/runtime/trace/traceReader.ts": "tooling: reads a trace file for the debugger",
  "lib/stdlib/agency.ts": "compiles and runs Agency code in a subprocess (std::agency)",
  "lib/stdlib/agencyEval.ts": "runs evals of agents from run directories on disk",
  "lib/stdlib/cli.ts": "the terminal UI needs the terminal's size and raw mode",
  "lib/stdlib/github/testUtils.ts": "a test helper",
  "lib/stdlib/hubClient.ts": "downloads model files to disk (local models)",
  "lib/stdlib/hubDownload.ts": "downloads model files to disk (local models)",
  "lib/stdlib/localImageInputs.ts": "local models",
  "lib/stdlib/localModels.ts": "starts local model servers (local models)",
  "lib/stdlib/localPython.ts": "runs Python for local models",
  "lib/stdlib/mlxImage.ts": "local models",
  "lib/stdlib/mlxModelRecord.ts": "local models",
  "lib/stdlib/mlxServerModels.ts": "local models",
  "lib/stdlib/modelBackend.ts": "recognizes a model directory on disk (local models)",
  "lib/stdlib/modelVerify.ts":
    "hashes model files of many gigabytes in pieces; a JavaScript SHA-256 is too slow for that",
  "lib/stdlib/oauthEncryption.ts":
    "encrypts stored tokens with createCipheriv; no portable cipher yet",
  "lib/stdlib/ui-region.ts": "the terminal UI needs the terminal's size and raw mode",
  "lib/stdlib/ui.ts": "the terminal UI needs the terminal's size and raw mode",
  "lib/utils/sha256.node.ts":
    "Node crypto; the browser condition of #sha256 picks sha256.portable.ts",
};

/** Waiting for a later PR to move its Node use into the host, or to stop
 *  pulling in a part of the compiler that uses Node (the files under
 *  lib/runtime/template, lib/runtime/toolBlockDiagnostics.ts,
 *  lib/stdlib/template.ts, and lib/debugger/debuggerState.ts, which
 *  imports all of lib/index.ts). Sorted. */
export const WAITING = [
  "lib/config/config.ts",
  "lib/debugger/debuggerState.ts",
  "lib/importPaths.ts",
  "lib/runtime/agentHome.ts",
  "lib/runtime/builtins.ts",
  "lib/runtime/callbackForwarding.ts",
  "lib/runtime/checkpointChecksum.ts",
  "lib/runtime/costTelemetry.ts",
  "lib/runtime/deterministicClient.ts",
  "lib/runtime/effectSets.ts",
  "lib/runtime/exitProcess.ts",
  "lib/runtime/memory/frame.ts",
  "lib/runtime/memory/store.ts",
  "lib/runtime/moduleFingerprintRegistry.ts",
  "lib/runtime/node.ts",
  "lib/runtime/policy.ts",
  "lib/runtime/replyAttachments.ts",
  "lib/runtime/state/context.ts",
  "lib/runtime/subprocessRunInfo.ts",
  "lib/runtime/template/codeLiteral.ts",
  "lib/runtime/template/explainMismatch.ts",
  "lib/runtime/template/fill.ts",
  "lib/runtime/template/hygiene.ts",
  "lib/runtime/template/literals.ts",
  "lib/runtime/template/synthesizeType.ts",
  "lib/runtime/toolBlockDiagnostics.ts",
  "lib/runtime/trace/sinks.ts",
  "lib/runtime/trace/traceWriter.ts",
  "lib/statelogClient.ts",
  "lib/stdlib/abortable.ts",
  "lib/stdlib/agentSessions.ts",
  "lib/stdlib/appleNotes.ts",
  "lib/stdlib/args.ts",
  "lib/stdlib/assertContained.ts",
  "lib/stdlib/aws/s3.ts",
  "lib/stdlib/aws/uri.ts",
  "lib/stdlib/base64.ts",
  "lib/stdlib/builtins.ts",
  "lib/stdlib/clipboard.ts",
  "lib/stdlib/contained.ts",
  "lib/stdlib/expandPath.ts",
  "lib/stdlib/ffmpeg.ts",
  "lib/stdlib/fs.ts",
  "lib/stdlib/git.ts",
  "lib/stdlib/github/credential.ts",
  "lib/stdlib/gitignore.ts",
  "lib/stdlib/image.ts",
  "lib/stdlib/imageTools.ts",
  "lib/stdlib/imessage.ts",
  "lib/stdlib/keyring.ts",
  "lib/stdlib/layout/render.ts",
  "lib/stdlib/mcpBridge.mjs",
  "lib/stdlib/mcpResolver.ts",
  "lib/stdlib/mediaPathScan.ts",
  "lib/stdlib/notify.ts",
  "lib/stdlib/oauth.ts",
  "lib/stdlib/ocr.ts",
  "lib/stdlib/path.ts",
  "lib/stdlib/prepareContainedPath.ts",
  "lib/stdlib/resolveDir.ts",
  "lib/stdlib/shell.ts",
  "lib/stdlib/skills.ts",
  "lib/stdlib/sms.ts",
  "lib/stdlib/speech.ts",
  "lib/stdlib/spill.ts",
  "lib/stdlib/statelog.ts",
  "lib/stdlib/system.ts",
  "lib/stdlib/template.ts",
  "lib/stdlib/thread.ts",
  "lib/stdlib/utils.ts",
  "lib/stdlib/vision.ts",
  "lib/utils/termcolors.ts",
];
