import { compile } from "@/compiler/defaultSession.js";
import { loadConfigSafe } from "@/config.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type StagedAgent = {
  runFile: string;
  cleanup: () => void;
};

/**
 * Compile the bundled agent with an explicit config, in isolation.
 *
 * The obvious alternative — compiling in place — would overwrite the shipped
 * `agent.js` (the compiler writes beside the source, recursively for Agency
 * imports), after which the NEXT unconfigured run would take the precompiled
 * fast path and silently inherit this config. It would also write
 * `.agency-build` manifest state next to the source, which fails outright on
 * a read-only npm install. So: copy the agent source tree to a fresh temp
 * directory (preserving relative imports), normalize the copy to writable
 * (cpSync preserves modes, and a read-only install produces read-only copies
 * the compiler could not overwrite), strip `outDir` (a user config must not
 * receive launcher artifacts), and compile with freshness "always" — the
 * no-manifest policy — plus quiet.
 *
 * Lifecycle: the config is validated BEFORE the temp dir exists, so a
 * malformed or missing explicit config can neither leak a tree nor silently
 * become an empty configured build. After creation, a process-exit hook
 * guarantees removal even if compilation calls process.exit() (the compiler
 * does, on parse and type failures). `cleanup` is idempotent and unregisters
 * that hook. Deletion is guarded: only a directory directly under the chosen
 * temp root with the `agency-agent-` prefix is ever removed (the repo's
 * `safeDeleteDirectory` deliberately refuses OS temp paths, so this guard is
 * purpose-built).
 */
export function stageConfiguredAgent(
  configPath: string,
  agentDir: string,
  options: { tempRoot?: string } = {},
): StagedAgent {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const { config: loaded, error } = loadConfigSafe(configPath);
  if (error !== undefined) {
    throw new Error(error);
  }
  const config = { ...loaded, outDir: undefined };

  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  const staged = fs.mkdtempSync(path.join(tempRoot, "agency-agent-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    process.removeListener("exit", cleanup);
    removeOwnedTemp(staged, tempRoot);
  };
  process.once("exit", cleanup);
  try {
    fs.cpSync(agentDir, staged, { recursive: true });
    makeTreeWritable(staged);
    const runFile = compile(
      config,
      path.join(staged, "agent.agency"),
      undefined,
      { freshness: "always", quiet: true },
    );
    if (runFile === null) {
      throw new Error(`Failed to compile agent with config ${configPath}`);
    }
    return { runFile, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Owner read/write on files, read/write/execute on directories — applied to
 *  the COPY only, so a read-only installed tree stages compilable. */
function makeTreeWritable(directory: string): void {
  fs.chmodSync(directory, 0o755);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      makeTreeWritable(fullPath);
    } else {
      fs.chmodSync(fullPath, 0o644);
    }
  }
}

/** Recursive deletion with ownership checks: the target must sit directly
 *  under the temp root and carry our prefix. Throws rather than deleting
 *  anything that fails either check. */
function removeOwnedTemp(staged: string, tempRoot: string): void {
  const resolved = path.resolve(staged);
  if (path.dirname(resolved) !== path.resolve(tempRoot)) {
    throw new Error(`Refusing to delete ${resolved}: not directly under ${tempRoot}`);
  }
  if (!path.basename(resolved).startsWith("agency-agent-")) {
    throw new Error(`Refusing to delete ${resolved}: not an agency-agent stage`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
